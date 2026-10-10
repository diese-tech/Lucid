/** Private, disposable UI state. Pickup records and operations remain authoritative. */
import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder, UserSelectMenuBuilder,
  type ChatInputCommandInteraction, type MessageComponentInteraction, type GuildMember,
  type MessageActionRowComponentBuilder, type ModalSubmitInteraction } from 'discord.js';
import { PickupRepository } from '../../db/repositories/pickups.js';
import { PickupSpaceRepository } from '../../db/repositories/pickup-spaces.js';
import { RosterSlotRepository } from '../../db/repositories/roster-slots.js';
import { SignupRepository } from '../../db/repositories/signups.js';
import type { Pickup } from '../../db/repositories/types.js';
import { ROLES, ROLE_LABELS, TEAM_LABELS, teamsForFormat, isRole, isTeam, type Role, type Team } from '../../domain/roles.js';
import { isAuthorized, requireCanonicalEntryMessage } from '../permissions.js';
import { navigationRow } from '../components.js';
import { rosterMessageLink, signupMessageLink } from '../render.js';
import { Action, encodeId, type DecodedId } from '../ids.js';
import { commitRosterChange, commitLifecycleChange, OperationRefused, type RosterChangeRequest } from '../pickup-operations.js';
import { PickupProjectionRepository } from '../../db/repositories/pickup-projections.js';
import { refreshReviewCard, resyncRosterMessage, resolveUnresolvedProjections, handlePublishConfirm, handleRepairPublication, evaluateRosterReady } from './review.js';
import { writeCancelledMessages } from './cancel.js';
import { writeFinishedMessages } from './finish.js';
import { verifyCurrentCandidate, candidateRefusalMessage } from '../eligibility.js';
import { eligibleSignupRecordsChecked } from '../eligibility.js';
import { generateDifferentRoster, rosterFingerprint } from '../../domain/roster.js';

type Interaction = ChatInputCommandInteraction | MessageComponentInteraction;
type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
const TTL = 10 * 60_000;
const SILENT = { parse: [] as const };
type Change = RosterChangeRequest['change'] | { kind: 'publish' } | { kind: 'cancel' } | { kind: 'finish' };
interface Session {
  token: string; ownerId: string; guildId: string; expiresAt: number; messageId: string | null;
  pickupId: number | null; version: number | null; page: number;
  mode: 'picker' | 'home' | 'swap_source' | 'swap_target' | 'swap_role' | 'seat_slot' | 'replace_slot' | 'candidate';
  sourceSlotId?: number;
  location?: { team: Team; role: Role };
  candidateKind?: 'seat' | 'replace';
  proposal?: { token: string; version: number; expiresAt: number; change: Change; description: string; roster: string };
  busy?: boolean;
  intent?: 'cancel';
}
const sessions = new Map<string, Session>();
export function resetManageSessions(): void { sessions.clear(); }

function newSession(interaction: Interaction): Session {
  for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key);
  const session: Session = { token: randomBytes(12).toString('hex'), ownerId: interaction.user.id,
    guildId: interaction.guildId!, expiresAt: Date.now() + TTL, messageId: null, pickupId: null, version: null, page: 0, mode: 'picker' };
  sessions.set(session.token, session);
  return session;
}
function id(action: typeof Action[keyof typeof Action], session: Session, ...args: (string|number)[]) {
  return encodeId(action, session.pickupId ?? 0, session.token, ...args);
}
function button(session: Session, label: string, action: string, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(id(Action.ManageAction, session, action)).setLabel(label).setStyle(style);
}
async function currentMember(interaction: Interaction): Promise<GuildMember | null> {
  if (!interaction.guild || interaction.guild.id !== interaction.guildId) return null;
  try { return await interaction.guild.members.fetch({ user: interaction.user.id, force: true, cache: false }); }
  catch { return null; }
}
function allowed(member: GuildMember, pickup: Pickup, guildId: string): boolean {
  const space = pickup.pickupSpaceId ? new PickupSpaceRepository().get(pickup.pickupSpaceId) : null;
  return pickup.guildId === guildId && space?.guildId === guildId && isAuthorized(member, space);
}
async function stillAuthorized(interaction: Interaction, pickupId: number): Promise<boolean> {
  const member = await currentMember(interaction); const pickup = new PickupRepository().byId(pickupId);
  return !!member && !!pickup && allowed(member, pickup, interaction.guildId!);
}
async function say(interaction: Interaction, content: string, components: Row[] = [], embeds: object[] = []) {
  await interaction.editReply({ content, components, embeds, allowedMentions: SILENT });
}
function navigation(session: Session, picker = false): Row {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    ...(picker ? [] : [button(session, 'Refresh', 'refresh'), button(session, 'Back', session.mode === 'home' ? 'back' : 'refresh')]),
    button(session, 'Close', 'close'),
  );
}
async function picker(interaction: Interaction, session: Session, member: GuildMember): Promise<void> {
  session.pickupId = null; session.version = null;
  session.mode = 'picker'; session.proposal = undefined;
  const pickups = new PickupRepository().listByStatus(session.intent === 'cancel' ? ['open','roster_ready'] : ['open', 'roster_ready', 'published'], { guildId: session.guildId, limit: 1_000_000 })
    .filter(p => allowed(member, p, session.guildId));
  const pages = Math.max(1, Math.ceil(pickups.length / 25));
  session.page = Math.max(0, Math.min(session.page, pages - 1));
  const visible = pickups.slice(session.page * 25, (session.page + 1) * 25);
  const rows: Row[] = [];
  if (visible.length) rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(id(Action.ManagePick, session)).setPlaceholder('Choose an active pickup')
      .addOptions(visible.map(p => ({ label: `#${p.id} · ${new PickupSpaceRepository().get(p.pickupSpaceId!)?.name ?? 'Pickup'} · ${p.status}`.slice(0, 100),
        description: new Date(p.startAt * 1000).toISOString().slice(0, 100), value: String(p.id) }))),
  ));
  if (pages > 1) rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(id(Action.ManagePage, session, session.page - 1)).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(session.page === 0),
    new ButtonBuilder().setCustomId(id(Action.ManagePage, session, session.page + 1)).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(session.page === pages - 1),
  ));
  rows.push(navigation(session, true));
  await say(interaction, visible.length ? `**Manage Pickup** · page ${session.page + 1}/${pages}\nChoose a pickup you are currently authorized to manage.`
    : 'No active pickups are available for you to manage.', rows);
}

async function seatPicker(interaction: Interaction, session: Session, pickup: Pickup): Promise<void> {
  const occupied = new Set(new RosterSlotRepository().forPickup(pickup.id).map(s => `${s.team}:${s.role}`));
  const locations = teamsForFormat(pickup.format).flatMap(team => ROLES.map(role => ({ team, role })))
    .filter(s => !occupied.has(`${s.team}:${s.role}`));
  session.mode = 'seat_slot';
  if (!locations.length) { await say(interaction, 'There are no open seats.', [navigation(session)]); return; }
  const select = new StringSelectMenuBuilder().setCustomId(id(Action.ManageSelect, session, 'seat_slot'))
    .setPlaceholder('Choose the open seat').addOptions(locations.map(s => ({ label: `${TEAM_LABELS[s.team]} · ${ROLE_LABELS[s.role]}`, value: `${s.team}:${s.role}` })));
  await say(interaction, 'Choose an open seat.', [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select), navigation(session)]);
}
async function candidatePicker(interaction: Interaction, session: Session, pickup: Pickup): Promise<void> {
  const pool = await eligibleSignupRecordsChecked(interaction.client, pickup.guildId,
    new SignupRepository().recordsForPickup(pickup.id), pickup.eligibilityRoleIds);
  if (!pool.ok) { await say(interaction, 'Lucid could not verify current candidates. No changes were made.', [navigation(session)]); return; }
  const seated = new Set(new RosterSlotRepository().userIds(pickup.id));
  const source = session.candidateKind === 'replace' ? new RosterSlotRepository().byId(session.sourceSlotId!) : null;
  const records = source && pickup.status === 'roster_ready' ? pool.records.filter(s => s.role === source.role || s.role === 'fill') : pool.records;
  const users = [...new Set(records.map(s => s.userId))].filter(u => !seated.has(u));
  const names = users.map(u => interaction.guild?.members.cache.get(u)?.displayName ?? u);
  const counts = new Map<string,number>(); for (const name of names) counts.set(name,(counts.get(name)??0)+1);
  session.mode = 'candidate';
  const pages = Math.max(1, Math.ceil(users.length / 25)); session.page = Math.max(0, Math.min(session.page, pages - 1));
  const rows: Row[] = [];
  if (users.length) rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(id(Action.ManageSelect, session, 'candidate')).setPlaceholder('Choose an eligible unseated signup')
      .addOptions(users.slice(session.page * 25, (session.page + 1) * 25).map(u => ({
        label: (()=>{ const name=interaction.guild?.members.cache.get(u)?.displayName??u;
          return (counts.get(name)??0)>1 ? `${name.slice(0,74)} · ${u}`.slice(0,100) : name.slice(0,100); })(), value: u,
        description: pool.records.filter(s => s.userId === u).map(s => s.role).join(', ').slice(0,100),
      }))),
  ));
  if (pickup.status === 'published' && session.candidateKind === 'replace') rows.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(new UserSelectMenuBuilder()
      .setCustomId(id(Action.ManageSelect, session, 'member')).setPlaceholder('Or choose a current server member')),
  );
  if (pages > 1) rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(id(Action.ManagePage, session, session.page - 1)).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(session.page === 0),
    new ButtonBuilder().setCustomId(id(Action.ManagePage, session, session.page + 1)).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(session.page === pages - 1),
  ));
  rows.push(navigation(session));
  await say(interaction, `Eligible unseated signups: ${users.length} · page ${session.page + 1}/${pages}`, rows);
}
async function home(interaction: Interaction, session: Session, pickup: Pickup): Promise<void> {
  session.pickupId = pickup.id; session.version = pickup.version;
  session.mode = 'home'; session.proposal = undefined;
  const space = new PickupSpaceRepository().get(pickup.pickupSpaceId!);
  const slots = new RosterSlotRepository().forPickup(pickup.id);
  const seated = new Set(slots.map(s => s.userId));
  const candidates = [...new Set(new SignupRepository().forPickup(pickup.id).map(s => s.userId))].filter(u => !seated.has(u));
  const locations = teamsForFormat(pickup.format).flatMap(team => ROLES.map(role => ({team,role})));
  const lines = [`Space: **${space?.name ?? 'Unavailable'}**`, `Start: <t:${pickup.startAt}:F>`,
    `Status: **${pickup.status}** · version ${pickup.version}`, `Delivery: **${pickup.publicationStatus}**`,
    `Readiness: ${slots.length}/${locations.length} seats filled`,
    ...(pickup.format === 'pickup_vs_premade' ? [`Opponent: ${pickup.premadeName ?? 'Premade team'}`] : []),
    pickup.rosterChannelId ? `Roster destination: <#${pickup.rosterChannelId}>` : 'Roster destination is missing.',
    ...(pickup.publicationErrorCategory ? [`⚠️ ${pickup.publicationErrorCategory.slice(0, 300)}`] : []), '',
    ...locations.map(location => {
      const s=slots.find(slot=>slot.team===location.team&&slot.role===location.role);
      return `${TEAM_LABELS[location.team]} · ${ROLE_LABELS[location.role]} — ${s ? `<@${s.userId}>${s.replacementNeeded ? ' ⚠️ replacement needed' : ''}` : 'OPEN'}`;
    }),
    '', `Unseated signups (${candidates.length}; eligibility is rechecked before seating):`,
    ...candidates.slice(0, 12).map(u => `<@${u}>`), ...(candidates.length > 12 ? [`…and ${candidates.length - 12} more.`] : [])];
  const links = [ ...(signupMessageLink(pickup) ? [{ label: 'View Signup', url: signupMessageLink(pickup)! }] : []),
    ...(rosterMessageLink(pickup) ? [{ label: 'View Roster', url: rosterMessageLink(pickup)! }] : []) ];
  const rows: Row[] = [];
  const unsettled = ['publishing', 'repairing', 'uncertain'].includes(pickup.publicationStatus)
    || new PickupProjectionRepository().blockingForPickup(pickup.id, pickup.version).length > 0;
  const terminal = pickup.status === 'finished' || pickup.status === 'cancelled';
  if (terminal) { /* Only navigation remains after closure. */ }
  else if (unsettled) rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button(session, 'Repair Delivery', 'repair')));
  else if (pickup.status === 'open') rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button(session, 'Seat Player', 'seat'), button(session, 'Cancel', 'cancel', ButtonStyle.Danger)));
  else if (pickup.status === 'roster_ready' || pickup.status === 'published') {
    const actions = [button(session, pickup.status === 'published' ? 'Swap' : 'Change Role', 'swap'), button(session, 'Replace', 'replace')];
    if (pickup.status === 'roster_ready') {
      actions.unshift(button(session, 'Shuffle', 'shuffle'));
      if (pickup.format === 'pickup_vs_pickup') actions.splice(1, 0, button(session, 'Swap Players', 'swap_teams'));
    }
    actions.push(button(session, pickup.status === 'published' ? 'Finish' : pickup.publicationStatus === 'failed' ? 'Retry Publication' : 'Publish', pickup.status === 'published' ? 'finish' : 'publish', ButtonStyle.Success));
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(actions));
    if (pickup.status === 'roster_ready') rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button(session, 'Cancel', 'cancel', ButtonStyle.Danger)));
  }
  rows.push(navigation(session)); const nav = navigationRow(links); if (nav) rows.push(nav);
  await say(interaction, '', rows, [{ title: `Pickup #${pickup.id}`, description: lines.join('\n').slice(0, 4000), color: 0x5865f2 }]);
}

async function slotPicker(interaction: Interaction, session: Session, pickup: Pickup, target = false, replace = false): Promise<void> {
  const slots = new RosterSlotRepository().forPickup(pickup.id).filter(s => !target || s.id !== session.sourceSlotId);
  session.mode = replace ? 'replace_slot' : target ? 'swap_target' : 'swap_source';
  if (!slots.length) { await say(interaction, 'No occupied slots are available.', [navigation(session)]); return; }
  const select = new StringSelectMenuBuilder().setCustomId(id(Action.ManageSelect, session, session.mode))
    .setPlaceholder(target ? 'Choose the second assignment' : 'Choose the first assignment')
    .addOptions(slots.map(s => ({ label: `${TEAM_LABELS[s.team]} · ${ROLE_LABELS[s.role]} — ${interaction.guild?.members.cache.get(s.userId)?.displayName ?? s.userId}`.slice(0, 100), value: String(s.id) })));
  await say(interaction, replace ? '**Replace player** — choose the assignment to replace.' : '**Swap assignments** — select the players to exchange.', [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select), navigation(session),
  ]);
}
async function preview(interaction: Interaction, session: Session, pickup: Pickup, change: Change, description: string): Promise<void> {
  if (session.version !== pickup.version || new PickupRepository().byId(pickup.id)?.version !== pickup.version) {
    await say(interaction, 'This roster changed while the preview was loading. Refresh and preview again.', [navigation(session)]); return;
  }
  const proposal = { token: randomBytes(8).toString('hex'), version: pickup.version, expiresAt: Date.now() + TTL,
    change: structuredClone(change), description, roster: rosterFingerprint(new RosterSlotRepository().forPickup(pickup.id)) };
  session.proposal = proposal;
  session.expiresAt = Math.max(session.expiresAt, proposal.expiresAt);
  await say(interaction, `**Confirm pickup #${pickup.id} · version ${pickup.version}**\n${description}\n\nNo changes have been saved.`, [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(id(Action.ManageConfirm, session, proposal.token)).setLabel('Confirm').setStyle(ButtonStyle.Success),
      button(session, 'Back', 'refresh'), button(session, 'Close', 'close'),
    ),
  ]);
}

async function prepareShuffle(interaction: Interaction, session: Session, pickup: Pickup): Promise<void> {
  if (pickup.status !== 'roster_ready' || session.version !== pickup.version) {
    await say(interaction, 'This pickup changed. Refresh and try again.', [navigation(session)]); return;
  }
  const pool = await eligibleSignupRecordsChecked(interaction.client, pickup.guildId,
    new SignupRepository().recordsForPickup(pickup.id), pickup.eligibilityRoleIds);
  if (!pool.ok) { await say(interaction, 'Lucid could not verify the current signup pool. No changes were made.', [navigation(session)]); return; }
  const result = generateDifferentRoster(pool.records, pickup.format, rosterFingerprint(new RosterSlotRepository().forPickup(pickup.id)));
  if (!result.result.feasible || !result.isDifferent) {
    await say(interaction, 'No alternative roster is currently available. No changes were made.', [navigation(session)]); return;
  }
  await preview(interaction, session, pickup, { kind: 'shuffle', slots: result.result.slots },
    'Replace the draft, including manual assignments, with:\n' + result.result.slots.map(s => `${TEAM_LABELS[s.team]} · ${ROLE_LABELS[s.role]} — <@${s.userId}>`).join('\n'));
}
async function confirm(interaction: MessageComponentInteraction, session: Session, pickup: Pickup, decoded: DecodedId): Promise<void> {
  const proposal = session.proposal;
  if (!proposal || proposal.token !== decoded.args[1] || proposal.expiresAt <= Date.now() || proposal.version !== pickup.version
    || proposal.roster !== rosterFingerprint(new RosterSlotRepository().forPickup(pickup.id))) {
    session.proposal = undefined;
    await say(interaction, 'That preview expired or the roster changed. No changes were made. Reopen management and preview again.', [navigation(session)]); return;
  }
  session.busy = true; session.proposal = undefined;
  let saved = false;
  try {
    if (!(await resolveUnresolvedProjections(interaction.client, pickup))) throw new OperationRefused('Discord delivery is still pending. Repair delivery first.');
    // Slot occupants can lose membership/eligibility while a private preview is open.
    const slots = new RosterSlotRepository();
    const change = proposal.change;
    const users = change.kind === 'swap'
      ? [slots.byId(change.sourceSlotId)?.userId, slots.byId(change.targetSlotId)?.userId]
      : change.kind === 'shuffle' ? change.slots.map(s => s.userId)
      : change.kind === 'seat' || change.kind === 'replace' ? [change.userId]
      : change.kind === 'publish' ? slots.userIds(pickup.id) : [];
    for (const userId of users) {
      if (!userId) throw new OperationRefused('That roster slot no longer exists.');
      const check = await verifyCurrentCandidate(interaction.guild, userId, pickup.eligibilityRoleIds);
      if (!check.ok) throw new OperationRefused(candidateRefusalMessage(check.reason, userId));
    }
    const member = await currentMember(interaction);
    const current = new PickupRepository().byId(pickup.id);
    if (!member || !current || !allowed(member, current, session.guildId)) throw new OperationRefused('Your permission to manage this Pickup Space changed.');
    if (Date.now() >= proposal.expiresAt) throw new OperationRefused('That preview expired during verification. Reopen management and preview again.');
    if (change.kind === 'publish') {
      await handlePublishConfirm(interaction, current, { action: Action.PublishConfirm, pickupId: pickup.id, args: [String(proposal.version)] }, async () => {
        const actor = await currentMember(interaction); const latest = new PickupRepository().byId(pickup.id);
        return !!actor && !!latest && allowed(actor, latest, session.guildId)
          && Date.now() < proposal.expiresAt && latest.version === proposal.version
          && rosterFingerprint(new RosterSlotRepository().forPickup(pickup.id)) === proposal.roster;
      });
      return;
    }
    if (change.kind === 'cancel' || change.kind === 'finish') {
      commitLifecycleChange({ actorId: session.ownerId, guildId: session.guildId, pickupId: pickup.id, expectedVersion: proposal.version,
        expectedRosterFingerprint: proposal.roster, proposalExpiresAt: proposal.expiresAt, kind: change.kind });
      saved = true;
      if (change.kind === 'finish') await writeFinishedMessages(interaction.client, current);
      else await writeCancelledMessages(interaction.client, current);
    } else {
      commitRosterChange({ actorId: session.ownerId, guildId: session.guildId, pickupId: pickup.id, expectedVersion: proposal.version,
        expectedRosterFingerprint: proposal.roster, proposalExpiresAt: proposal.expiresAt, change });
      saved = true;
      if (change.kind === 'seat') await evaluateRosterReady(interaction.client, pickup.id);
      else await refreshReviewCard(interaction.client, pickup.id);
      if (pickup.status === 'published') await resyncRosterMessage(interaction.client, pickup);
    }
    const pending = new PickupProjectionRepository().unresolvedForPickup(pickup.id).length > 0;
    await say(interaction, pending ? 'Change saved. Discord refresh is pending; do not repeat the change.' : 'Change saved.', [navigation(session)]);
  } catch (error) {
    saved ||= proposal.change.kind === 'publish' && new PickupRepository().byId(pickup.id)?.status === 'published';
    await say(interaction, saved ? 'Change saved. Discord refresh is pending; do not repeat the change.'
      : `${error instanceof OperationRefused ? error.message : 'Lucid could not save the change.'} No changes were made.`, [navigation(session)]);
  } finally { session.busy = false; }
}
export async function handleManageCommand(interaction: ChatInputCommandInteraction, intent?: 'cancel'): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await currentMember(interaction);
  if (!member) { await say(interaction, 'Lucid could not verify your current server membership. No changes were made.'); return; }
  const session = newSession(interaction); session.intent = intent; await picker(interaction, session, member);
  session.messageId = (await interaction.fetchReply()).id;
}

/** Durable entries stay stateless; each click creates a new owner-bound private workspace. */
export async function handleManageEntry(interaction: MessageComponentInteraction, decoded: DecodedId): Promise<void> {
  const pickup = new PickupRepository().byId(decoded.pickupId);
  if (!pickup || pickup.guildId !== interaction.guildId) {
    await interaction.reply({ content: 'That pickup is not in this server.', flags: MessageFlags.Ephemeral }); return;
  }
  const rosterEntry = decoded.action === Action.Replace || decoded.action === Action.Finish;
  if (!(await requireCanonicalEntryMessage(interaction, rosterEntry ? pickup.rosterMessageId : pickup.reviewMessageId))) return;
  if (decoded.args[0] !== undefined && Number(decoded.args[0]) !== pickup.version) {
    await interaction.reply({content:'This control came from an earlier roster version. Press Manage to reopen the current pickup.',flags:MessageFlags.Ephemeral}); return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await currentMember(interaction);
  if (!member || !allowed(member, pickup, pickup.guildId)) {
    await say(interaction, 'You are not currently authorized to manage this Pickup Space.'); return;
  }
  const session = newSession(interaction);
  await home(interaction, session, pickup);
  if ((['publishing','repairing','uncertain'].includes(pickup.publicationStatus)
    || new PickupProjectionRepository().blockingForPickup(pickup.id, pickup.version).length) && decoded.action !== Action.RepairPublication) {
    session.messageId = (await interaction.fetchReply()).id; return;
  }
  if (decoded.action === Action.Shuffle && pickup.status === 'roster_ready') await prepareShuffle(interaction,session,pickup);
  else if (decoded.action === Action.SeatPlayer && pickup.status === 'open') await seatPicker(interaction, session, pickup);
  else if (decoded.action === Action.Replace && pickup.status === 'published') await slotPicker(interaction, session, pickup, false, true);
  else if (decoded.action === Action.PublishedSwap && pickup.status === 'published') await slotPicker(interaction, session, pickup);
  else if (decoded.action === Action.Cancel && ['open','roster_ready'].includes(pickup.status)) await preview(interaction, session, pickup, {kind:'cancel'}, 'Cancel this pickup? This permanently closes signups and roster editing.');
  else if ((decoded.action === Action.Finish || decoded.action === Action.FinishFromCard) && pickup.status === 'published') await preview(interaction, session, pickup, {kind:'finish'}, 'Finish this pickup? Roster editing will close permanently.');
  else if (decoded.action === Action.Publish && pickup.status === 'roster_ready') await preview(interaction, session, pickup, {kind:'publish'},
    `Publish this exact roster to <#${pickup.rosterChannelId}>?\n` + new RosterSlotRepository().forPickup(pickup.id).map(s=>`${TEAM_LABELS[s.team]} · ${ROLE_LABELS[s.role]} — <@${s.userId}>`).join('\n'));
  else if (decoded.action === Action.RepairPublication) await handleRepairPublication(interaction, pickup, ()=>stillAuthorized(interaction,pickup.id));
  session.messageId = (await interaction.fetchReply()).id;
}

/** Old private continuations have no actor-owned proposal; never infer the missing preview. */
export async function handleObsoleteContinuation(interaction: MessageComponentInteraction | ModalSubmitInteraction): Promise<void> {
  await interaction.reply({ content: 'These older private controls cannot safely confirm a change. Run `/pickup manage` or press Manage on the current staff card to preview again. No changes were made.', flags: MessageFlags.Ephemeral });
}
export async function handleManageComponent(interaction: MessageComponentInteraction, decoded: DecodedId): Promise<void> {
  const session = sessions.get(decoded.args[0] ?? '');
  if (!session || session.expiresAt <= Date.now()) {
    await interaction.reply({ content: 'This private workspace expired. Run `/pickup manage` or press Manage on the staff card. No changes were made.', flags: MessageFlags.Ephemeral }); return;
  }
  if (session.ownerId !== interaction.user.id || session.guildId !== interaction.guildId || session.messageId !== interaction.message.id) {
    await interaction.reply({ content: 'This private workspace belongs to a different operator or message.', flags: MessageFlags.Ephemeral }); return;
  }
  await interaction.deferUpdate();
  if (session.busy) { await say(interaction, 'An action is already in progress. Wait for its result.'); return; }
  if (decoded.pickupId !== (session.pickupId ?? 0)) { await say(interaction, 'This workspace changed pickup. Reopen management.'); return; }
  const member = await currentMember(interaction);
  if (!member) { await say(interaction, 'Lucid could not verify your current membership. No changes were made.'); return; }
  const picked = decoded.action === Action.ManagePick && interaction.isStringSelectMenu();
  if (picked) session.pickupId = Number(interaction.values[0]);
  const pickup = session.pickupId ? new PickupRepository().byId(session.pickupId) : null;
  if (session.pickupId && (!pickup || !allowed(member, pickup, session.guildId))) {
    await say(interaction, 'You are no longer authorized to manage this Pickup Space. No changes were made.'); return;
  }
  if (decoded.action === Action.ManageAction && decoded.args[1] === 'close') {
    sessions.delete(session.token); await say(interaction, 'Workspace closed. No pending change was saved.'); return;
  }
  if (decoded.action === Action.ManagePage) {
    session.page = Number(decoded.args[1]) || 0;
    if (pickup && session.mode === 'candidate') { await candidatePicker(interaction, session, pickup); return; }
  }
  if (!pickup || (decoded.action === Action.ManageAction && decoded.args[1] === 'back')) {
    await picker(interaction, session, member); return;
  }
  if (picked && session.intent === 'cancel') {
    await home(interaction, session, pickup);
    await preview(interaction, session, pickup, {kind:'cancel'}, 'Cancel this pickup? This permanently closes signups and roster editing.'); return;
  }
  if (decoded.action === Action.ManageConfirm) { await confirm(interaction, session, pickup, decoded); return; }
  const unresolved = ['publishing', 'repairing', 'uncertain'].includes(pickup.publicationStatus)
    || new PickupProjectionRepository().blockingForPickup(pickup.id, pickup.version).length > 0;
  if (unresolved && (decoded.action === Action.ManageSelect || (decoded.action === Action.ManageAction && !['refresh','repair'].includes(decoded.args[1] ?? '')))) {
    await say(interaction, 'Delivery is unsettled. Use Repair Delivery before editing this roster.', [navigation(session)]); return;
  }
  if (decoded.action === Action.ManageAction && decoded.args[1] === 'swap_teams') {
    if (pickup.status !== 'roster_ready' || pickup.format !== 'pickup_vs_pickup' || session.version !== pickup.version) {
      await say(interaction, 'That swap is no longer available.', [navigation(session)]); return;
    }
    session.mode = 'swap_role';
    const select = new StringSelectMenuBuilder().setCustomId(id(Action.ManageSelect, session, 'swap_role')).setPlaceholder('Choose the role to exchange between teams')
      .addOptions(ROLES.map(role => ({ label: ROLE_LABELS[role], value: role })));
    await say(interaction, 'Swap the two players while keeping their role.', [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select), navigation(session)]); return;
  }
  if (decoded.action === Action.ManageAction && decoded.args[1] === 'repair') {
    if (['publishing', 'repairing', 'uncertain'].includes(pickup.publicationStatus)) await handleRepairPublication(interaction, pickup, ()=>stillAuthorized(interaction,pickup.id));
    else {
      const settled = await resolveUnresolvedProjections(interaction.client, pickup);
      await say(interaction, settled ? 'Delivery is reconciled. Refresh to continue.' : 'Delivery remains pending. Restore channel access and retry; no roster change was repeated.', [navigation(session)]);
    }
    return;
  }
  if (decoded.action === Action.ManageAction && ['publish', 'cancel', 'finish'].includes(decoded.args[1] ?? '')) {
    const kind = decoded.args[1] as 'publish' | 'cancel' | 'finish';
    const valid = kind === 'finish' ? pickup.status === 'published' : kind === 'publish' ? pickup.status === 'roster_ready' : ['open','roster_ready'].includes(pickup.status);
    if (!valid || session.version !== pickup.version || ['publishing','repairing','uncertain'].includes(pickup.publicationStatus)) {
      await say(interaction, 'That action is no longer available. Refresh to continue.', [navigation(session)]); return;
    }
    const roster = new RosterSlotRepository().forPickup(pickup.id).map(s => `${TEAM_LABELS[s.team]} · ${ROLE_LABELS[s.role]} — <@${s.userId}>`).join('\n');
    const description = kind === 'publish' ? `Publish this exact roster to <#${pickup.rosterChannelId}>?\n${roster}`
      : kind === 'finish' ? `Finish this pickup? Roster editing will close permanently.\n${roster}` : 'Cancel this pickup? Signups and roster editing will close permanently.';
    await preview(interaction, session, pickup, { kind }, description); return;
  }
  if (decoded.action === Action.ManageAction && decoded.args[1] === 'seat') {
    if (pickup.status !== 'open' || session.version !== pickup.version) {
      await say(interaction, 'This pickup changed. Refresh and try again.', [navigation(session)]); return;
    }
    await seatPicker(interaction, session, pickup); return;
  }
  if (decoded.action === Action.ManageAction && decoded.args[1] === 'replace') {
    if (session.version !== pickup.version || !['roster_ready', 'published'].includes(pickup.status)) {
      await say(interaction, 'This pickup changed. Refresh and try again.', [navigation(session)]); return;
    }
    await slotPicker(interaction, session, pickup, false, true); return;
  }
  if (decoded.action === Action.ManageAction && decoded.args[1] === 'shuffle') {
    await prepareShuffle(interaction,session,pickup); return;
  }
  if (decoded.action === Action.ManageAction && decoded.args[1] === 'swap') {
    if (session.version !== pickup.version || !['roster_ready', 'published'].includes(pickup.status)) {
      await say(interaction, 'This pickup changed. Refresh and try again.', [navigation(session)]); return;
    }
    await slotPicker(interaction, session, pickup); return;
  }
  if (decoded.action === Action.ManageSelect && (interaction.isStringSelectMenu() || interaction.isUserSelectMenu?.())) {
    const external = decoded.args[1] === 'member' && session.mode === 'candidate' && session.candidateKind === 'replace' && pickup.status === 'published';
    if ((!external && decoded.args[1] !== session.mode) || session.version !== pickup.version) {
      await say(interaction, 'This selection changed. Refresh and try again.', [navigation(session)]); return;
    }
    if (session.mode === 'swap_role') {
      const role = interaction.values[0];
      const slots = new RosterSlotRepository().forPickup(pickup.id);
      const source = slots.find(s => s.team === 'order' && s.role === role); const target = slots.find(s => s.team === 'chaos' && s.role === role);
      if (!source || !target) { await say(interaction, 'Both teams must have that role filled.', [navigation(session)]); return; }
      await preview(interaction, session, pickup, { kind: 'swap', sourceSlotId: source.id, targetSlotId: target.id, staffAssigned: false },
        `Exchange <@${source.userId}> (Order ${ROLE_LABELS[source.role]}) and <@${target.userId}> (Chaos ${ROLE_LABELS[target.role]}).`); return;
    }
    if (session.mode === 'seat_slot') {
      const [team, role] = (interaction.values[0] ?? '').split(':');
      if (!team || !role || !isTeam(team) || !isRole(role)) { await say(interaction, 'That seat is not valid.', [navigation(session)]); return; }
      session.location = { team, role }; session.candidateKind = 'seat'; session.page = 0; await candidatePicker(interaction, session, pickup); return;
    }
    if (session.mode === 'candidate') {
      const userId = interaction.values[0];
      const source = session.candidateKind === 'replace' ? new RosterSlotRepository().byId(session.sourceSlotId!) : null;
      const location = source ?? session.location;
      if (!userId || !location) { await say(interaction, 'That candidate selection expired.', [navigation(session)]); return; }
      const check = await verifyCurrentCandidate(interaction.guild, userId, pickup.eligibilityRoleIds);
      if (!check.ok) { await say(interaction, candidateRefusalMessage(check.reason, userId), [navigation(session)]); return; }
      const hasSignups = new SignupRepository().forPickup(pickup.id).some(s => s.userId === userId);
      const offRole = hasSignups && !new SignupRepository().hasSignedUpFor(pickup.id, userId, location.role);
      const change: RosterChangeRequest['change'] = source ? { kind: 'replace', slotId: source.id, userId } : { kind: 'seat', team: location.team, role: location.role, userId };
      await preview(interaction, session, pickup, change,
        `${source ? `Replace <@${source.userId}> with` : 'Seat'} <@${userId}> at ${TEAM_LABELS[location.team]} · ${ROLE_LABELS[location.role]}.${offRole ? '\n⚠️ This is an off-role staff override.' : ''}`); return;
    }
    const slot = new RosterSlotRepository().byId(Number(interaction.values[0]));
    if (!slot || slot.pickupId !== pickup.id) { await say(interaction, 'That slot is not part of this pickup.', [navigation(session)]); return; }
    if (session.mode === 'replace_slot') { session.sourceSlotId = slot.id; session.candidateKind = 'replace'; session.page = 0; await candidatePicker(interaction, session, pickup); return; }
    if (session.mode === 'swap_source') { session.sourceSlotId = slot.id; await slotPicker(interaction, session, pickup, true); return; }
    if (session.mode === 'swap_target') {
      const source = new RosterSlotRepository().byId(session.sourceSlotId!);
      if (!source || source.id === slot.id) { await say(interaction, 'Choose two different assignments.', [navigation(session)]); return; }
      await preview(interaction, session, pickup, { kind: 'swap', sourceSlotId: source.id, targetSlotId: slot.id, staffAssigned: true },
        `Exchange <@${source.userId}> (${TEAM_LABELS[source.team]} · ${ROLE_LABELS[source.role]}) with <@${slot.userId}> (${TEAM_LABELS[slot.team]} · ${ROLE_LABELS[slot.role]}).`); return;
    }
  }
  await home(interaction, session, pickup);
}
