/**
 * Message rendering.
 *
 * The public signup post is intentionally plain text in the style the Dream
 * Walkers community already writes by hand. It is NOT an embed or an event
 * card, and it should not become one — the whole point is that it looks like a
 * person posted it. Keep additions here minimal and unlabelled. Same for the
 * public roster post (renderPublicRoster) -- players read that one directly
 * too.
 *
 * Staff-only cards (control/review/published/finished/cancelled -- every
 * render*Card function below) are a different surface with a different
 * audience, and render as embeds (see CardEmbed) rather than plain content:
 * a colored left border makes a card's status recognizable without reading
 * it, matching the pattern Ratatoskr (the sibling bot) adopted for its own
 * operations cards (issue #53).
 */

import {
  ROLE_LABELS,
  ROLES,
  SIGNUP_ROLES,
  SIGNUP_ROLE_LABELS,
  TEAM_LABELS,
  capacityForFormat,
  type Role,
  type Team,
  teamsForFormat,
} from '../domain/roles.js';
import { discordRelative, discordShortTime } from '../domain/time.js';
import type { Pickup, RosterSlot } from '../db/repositories/types.js';
import type { SignupRecord, SlotAssignment, WorkingRosterResult } from '../domain/roster.js';

/** Discord's hard cap on a single message's content length. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * A staff card's embed payload -- the plain-object shape discord.js accepts
 * directly in a message's `embeds` array, not the builder class. Every
 * render*Card function below returns one of these instead of a string; the
 * marker (see reconciliationMarker) is deliberately NOT part of it -- it
 * belongs in the message's own `content` field so message-recovery.ts's
 * plain-substring search keeps working unchanged (see that module's doc
 * comment) regardless of what the embed currently shows.
 */
export interface CardEmbed {
  title: string;
  description: string;
  color: number;
}

/**
 * Status color for every staff card, matching Ratatoskr's scheme (issue
 * #53) so both bots read the same way at a glance: blue while collecting,
 * teal once ready for staff, green once live/complete, amber when something
 * needs staff attention, gray once closed out.
 */
export const CARD_COLOR = {
  open: 0x3b82f6,
  ready: 0x0d9488,
  published: 0x22c55e,
  warning: 0xf59e0b,
  finished: 0x22c55e,
  cancelled: 0x6b7280,
} as const;

/** "1 role" / "2 roles" — never the literal "role(s)". */
export function roleLimitPhrase(roleLimit: number): string {
  return roleLimit === 1 ? '1 role' : `${roleLimit} roles`;
}

/**
 * How a set of eligibility roles reads back to a human — "Everyone" when
 * unrestricted, otherwise every configured role "or"-joined, matching the
 * OR semantics of the eligibility check itself (holding any one is enough).
 */
export function eligibilityMentions(roleIds: readonly string[]): string {
  return roleIds.length === 0 ? 'Everyone' : roleIds.map((id) => `<@&${id}>`).join(' or ');
}

/**
 * Build a message body from `header` plus as many `items` as fit under
 * Discord's 2000-character message cap, noting how many didn't.
 *
 * For any list built from records that grow with normal guild usage
 * (Pickup Spaces, overlapping pickups, configured origin channels, ...) —
 * not just the one instance that happened to get flagged — silently
 * exceeding the cap fails the whole reply outright, exactly when the list
 * is most needed. `maxLength` defaults to 100 characters under
 * DISCORD_MESSAGE_LIMIT to leave headroom for whatever the caller still
 * appends after this (buttons text, etc).
 *
 * `footer` is called with how many items were cut (0 when every item fit)
 * so the same call site can word the truncated and untruncated cases
 * differently. Returning '' omits the footer (and its leading blank line)
 * entirely, for callers with nothing to add in the untruncated case.
 */
export function boundedLines(
  header: string[],
  items: string[],
  footer: (remaining: number) => string,
  maxLength = DISCORD_MESSAGE_LIMIT - 100,
): string[] {
  const lines = [...header];
  let shown = 0;
  for (const item of items) {
    if (lines.join('\n').length + item.length > maxLength) break;
    lines.push(item);
    shown += 1;
  }
  const footerText = footer(items.length - shown);
  if (footerText) lines.push('', footerText);
  return lines;
}

export interface SignupPostInput {
  format: Pickup['format'];
  startAt: number;
  roleLimit: number;
  note?: string | null;
  premadeName?: string | null;
  pingRoleId?: string | null;
  eligibilityRoleIds?: readonly string[];
  cancelled?: boolean;
}

/**
 * The public signup message.
 *
 * The preview shown to the coordinator before posting uses this exact function,
 * so what they approve is byte-for-byte what players see.
 */
export function renderSignupPost(input: SignupPostInput): string {
  const time = `${discordShortTime(input.startAt)} ${discordRelative(input.startAt)}`;

  const title =
    input.format === 'pickup_vs_premade' && input.premadeName
      ? `**Pickup games vs ${input.premadeName} at ${time}**`
      : `**Pickup games at ${time}**`;

  const lines: string[] = [];

  // The configured role is pinged at the very top, above the title.
  if (input.pingRoleId) lines.push(`<@&${input.pingRoleId}>`);

  if (input.cancelled) {
    lines.push(`~~${title.replaceAll('**', '')}~~`);
    lines.push('');
    lines.push('This pickup was cancelled.');
    return lines.join('\n');
  }

  lines.push(title);
  lines.push('');
  lines.push('React with the role(s) you want to play.');
  lines.push(`You may select **${roleLimitPhrase(input.roleLimit)}**.`);
  if (input.eligibilityRoleIds && input.eligibilityRoleIds.length > 0) {
    lines.push(`Eligibility: ${eligibilityMentions(input.eligibilityRoleIds)}`);
  }

  // The coordinator's note renders bare, with no "Note:" label — a label makes
  // the post read like bot output, and coordinators phrase their own framing.
  if (input.note && input.note.trim()) {
    lines.push('');
    lines.push(input.note.trim());
  }

  return lines.join('\n');
}

function slotsByTeam(slots: SlotAssignment[], team: Team): Map<Role, string> {
  const map = new Map<Role, string>();
  for (const slot of slots) {
    if (slot.team === team) map.set(slot.role, slot.userId);
  }
  return map;
}

export interface RosterRenderOptions {
  /** User IDs whose signup vanished after the draft was generated. */
  withdrawnUserIds?: Set<string>;
  ineligibleUserIds?: Set<string>;
  /**
   * Seated players who said they can't play (issue #36). Deliberately marked
   * rather than removed -- the roster keeps the name visible until staff
   * actually resolve the seat, so nobody reads a silently-empty slot as
   * "nobody was ever here".
   */
  replacementNeededUserIds?: Set<string>;
  bold?: boolean;
  /** The pickup has been explicitly closed out -- see flows/finish.ts. */
  finished?: boolean;
}

function renderTeamBlock(
  slots: SlotAssignment[],
  team: Team,
  options: RosterRenderOptions = {},
): string[] {
  const occupants = slotsByTeam(slots, team);
  const lines = [`### ${TEAM_LABELS[team]}`];

  for (const role of ROLES) {
    const userId = occupants.get(role);
    const label = options.bold ? `**${ROLE_LABELS[role]}:**` : `${ROLE_LABELS[role]}:`;
    if (!userId) {
      // Working roster and review-card renders share this label -- an
      // OPEN seat here is a real, currently-unfilled location, not the
      // placeholder emptiness a not-yet-generated card would show.
      lines.push(`${label} OPEN`);
      continue;
    }
    const warning = options.withdrawnUserIds?.has(userId)
      ? ' ⚠️ signup withdrawn'
      : options.ineligibleUserIds?.has(userId)
        ? ' ⚠️ no longer eligible'
        : options.replacementNeededUserIds?.has(userId)
          ? ' ⚠️ replacement needed'
          : '';
    lines.push(`${label} <@${userId}>${warning}`);
  }
  return lines;
}

/** The private staff review draft. */
export function renderReviewCard(
  pickup: Pickup,
  slots: RosterSlot[],
  options: RosterRenderOptions = {},
): CardEmbed {
  const lines: string[] = [`**Start:** ${discordShortTime(pickup.startAt)} ${discordRelative(pickup.startAt)}`, ''];

  for (const team of teamsForFormat(pickup.format)) {
    lines.push(...renderTeamBlock(slots, team, options));
    lines.push('');
  }

  if (pickup.format === 'pickup_vs_premade') {
    lines.push('### Opponent');
    lines.push(pickup.premadeName ? `**${pickup.premadeName}**` : '_Premade team_');
    lines.push('');
  }

  // A warning outranks the default 'ready' color, and 'finished' outranks a
  // warning -- there is nothing left to act on once the pickup is closed,
  // regardless of whichever warning got it there.
  let color: number = CARD_COLOR.ready;
  if (options.withdrawnUserIds && options.withdrawnUserIds.size > 0) {
    lines.push(
      '⚠️ One or more players have withdrawn their signup. Use Shuffle or Edit Roster to replace them before publishing.',
    );
    color = CARD_COLOR.warning;
  }
  if (options.ineligibleUserIds && options.ineligibleUserIds.size > 0) {
    lines.push(
      '⚠️ One or more players no longer hold an eligibility role. Use Shuffle or Edit Roster before publishing.',
    );
    color = CARD_COLOR.warning;
  }
  if (options.finished) {
    lines.push('✅ This pickup is finished. Roster changes are closed.');
    color = CARD_COLOR.finished;
  }

  return { title: 'Pickup Ready', description: lines.join('\n').trimEnd(), color };
}

/**
 * The healthy published staff card (issue #37) -- a concise operator
 * summary, not the full working-roster draft. Shown once a roster publishes
 * cleanly and stays up until a seat needs a replacement (see
 * renderExpandedPublishedCard) or the pickup finishes.
 */
export function renderCompactPublishedCard(pickup: Pickup): CardEmbed {
  return { title: '✓ Pickup Published', description: discordShortTime(pickup.startAt), color: CARD_COLOR.published };
}

/** One eligible signed-up player not currently seated, for the expanded card's candidate list. */
export interface UnseatedCandidate {
  userId: string;
  /** "Solo, Fill" -- see declaredRoleLabels. Empty string if this player has no readable signup left. */
  roles: string;
}

/**
 * The expanded published staff card (issue #37) -- shown instead of the
 * compact summary while one or more seats are `replacement_needed`, so
 * staff have full context to rebalance without navigating away: current
 * roster (with the affected seat(s) marked), and eligible unseated
 * candidates with their declared roles, mirroring the pre-publish control
 * card's own "Unseated eligible signups" section.
 */
export function renderExpandedPublishedCard(
  pickup: Pickup,
  slots: RosterSlot[],
  unseatedEligible: readonly UnseatedCandidate[],
): CardEmbed {
  const lines: string[] = [`**Start:** ${discordShortTime(pickup.startAt)} ${discordRelative(pickup.startAt)}`, ''];

  const replacementNeededUserIds = new Set(
    slots.filter((slot) => slot.replacementNeeded).map((slot) => slot.userId),
  );
  for (const team of teamsForFormat(pickup.format)) {
    lines.push(...renderTeamBlock(slots, team, { bold: true, replacementNeededUserIds }));
    lines.push('');
  }

  if (unseatedEligible.length > 0) {
    const remainingBudget = DISCORD_MESSAGE_LIMIT - 100 - lines.join('\n').length;
    lines.push(
      ...boundedLines(
        ['**Eligible unseated signups**'],
        unseatedEligible.map(({ userId, roles }) => `<@${userId}>${roles ? ` · ${roles}` : ''}`),
        (remaining) => (remaining > 0 ? `...and ${remaining} more.` : ''),
        remainingBudget,
      ),
    );
    lines.push('');
  }

  lines.push('Use **Swap** or **Replace Player** to resolve the flagged seat(s).');
  return { title: '⚠️ Replacement Needed', description: lines.join('\n').trimEnd(), color: CARD_COLOR.warning };
}

/**
 * The finished staff card (issue #37), manual and automatic finish worded
 * distinctly so nobody reads a timeout as a human decision or vice versa.
 */
export function renderFinishedCard(pickup: Pickup): CardEmbed {
  let description: string;
  if (pickup.finishReason === 'manual' && pickup.finishedByUserId && pickup.finishedAt) {
    description = `Finished by <@${pickup.finishedByUserId}> at ${discordShortTime(Math.floor(pickup.finishedAt / 1000))}`;
  } else if (pickup.finishReason === 'timeout') {
    description = 'Automatically finished 3 hours after scheduled start.';
  } else {
    // finishReason is null for any pickup that reached `finished` before
    // migration 013 added these columns -- reconciliation can still redraw
    // one of those historical cards. Claiming "automatically finished" here
    // would misrepresent a real human decision nobody recorded the actor
    // for (codex review finding on PR #51); say plainly that the attribution
    // itself is unknown instead of guessing either way.
    description = 'Finished (attribution not recorded).';
  }
  return { title: '✓ Pickup Finished', description, color: CARD_COLOR.finished };
}

export interface ControlCardOptions {
  /**
   * Why the card can't show a normal working-roster reading right now.
   *
   * 'role-missing' (the configured eligibility role was deleted) and
   * 'lookup-failed' (Lucid couldn't check membership at all — a transient
   * API error) are NOT the same fact and must render distinctly: the first is
   * a staff configuration problem, the second is not — treating it as one
   * would tell staff to go fix something that was never broken. Neither may
   * silently fall back to "no restriction" or to an indistinguishable "no
   * eligible signups" reading — see review.ts's eligibilityContext.
   */
  eligibilityError?: 'role-missing' | 'lookup-failed' | null;
}

/** "Solo, Support" / "Fill" — a signed-up player's declared roles, ROLES order, Fill last. */
export function declaredRoleLabels(eligibleRecords: readonly SignupRecord[], userId: string): string {
  const declared = new Set(eligibleRecords.filter((r) => r.userId === userId).map((r) => r.role));
  return SIGNUP_ROLES.filter((role) => declared.has(role))
    .map((role) => SIGNUP_ROLE_LABELS[role])
    .join(', ');
}

/**
 * The staff control message before a roster is complete.
 *
 * Posted at pickup creation so Cancel is reachable by button even for a
 * pickup that never fills up. This same message is later edited in place
 * into the full review card once `working.complete` — it is never replaced
 * with a second message.
 *
 * Shows the actual PARTIAL roster (`working`), not a headcount summary: every
 * seat the current signup pool can fill, which seats remain OPEN, and which
 * eligible signed-up players didn't make it in — see domain/roster.ts's
 * generateWorkingRoster. `eligibleRecords` is the exact pool `working` was
 * computed from, used here only to look up each unseated player's declared
 * roles for display.
 *
 * Deliberately does NOT include reconciliationMarker anywhere in the
 * returned embed -- the marker lives in the message's `content` field at
 * every call site instead (see reconciliationMarker's own doc comment), so
 * message-recovery.ts's plain-substring search keeps working unchanged
 * regardless of which of this function's branches currently drew the embed.
 */
export function renderControlCard(
  pickup: Pickup,
  working: WorkingRosterResult,
  eligibleRecords: readonly SignupRecord[],
  options: ControlCardOptions = {},
): CardEmbed {
  const lines: string[] = [`**Start:** ${discordShortTime(pickup.startAt)} ${discordRelative(pickup.startAt)}`];
  if (pickup.format === 'pickup_vs_premade' && pickup.premadeName) {
    lines.push(`**Opponent:** ${pickup.premadeName}`);
  }
  lines.push(`**Role limit:** ${roleLimitPhrase(pickup.roleLimit)}`);
  if (pickup.eligibilityRoleIds.length > 0) {
    lines.push(`**Eligibility:** ${eligibilityMentions(pickup.eligibilityRoleIds)}`);
  }
  lines.push('');

  if (options.eligibilityError === 'role-missing') {
    lines.push(
      '⚠️ **None of this pickup\'s eligibility roles exist anymore.** Reactions cannot be verified. There is no ' +
        'way to change a pickup\'s eligibility roles after it\'s posted — **Cancel** this pickup below and run ' +
        '`/pickup create` again once the roles are fixed.',
    );
    return { title: 'Pickup Open', description: lines.join('\n').trimEnd(), color: CARD_COLOR.warning };
  }
  if (options.eligibilityError === 'lookup-failed') {
    lines.push(
      '⚠️ **Lucid could not verify eligibility for this pickup right now** (a temporary error, not a ' +
        'configuration problem). The roster will resume updating automatically as reactions come in — no action needed.',
    );
    return { title: 'Pickup Open', description: lines.join('\n').trimEnd(), color: CARD_COLOR.warning };
  }

  const targetPlayers = capacityForFormat(pickup.format) * ROLES.length;
  const missingRoles = ROLES.filter((role) => working.missingLocations.some((loc) => loc.role === role));
  const seatedSummary =
    missingRoles.length > 0
      ? `${working.slots.length}/${targetPlayers} seated · needs ${missingRoles.map((role) => ROLE_LABELS[role]).join(' + ')}`
      : `${working.slots.length}/${targetPlayers} seated`;
  lines.push(seatedSummary, '');

  for (const team of teamsForFormat(pickup.format)) {
    lines.push(...renderTeamBlock(working.slots, team));
    lines.push('');
  }

  if (working.unseatedUserIds.length > 0) {
    // boundedLines' default budget (DISCORD_MESSAGE_LIMIT - 100) assumes it
    // owns the whole message -- here the header, seated summary and every
    // team block above have already spent part of that budget, so it must
    // be given only what's actually left, or a roster with a long eligibility
    // mention and a big bench could still push the combined message over
    // Discord's cap despite this call looking bounded on its own.
    const remainingBudget = DISCORD_MESSAGE_LIMIT - 100 - lines.join('\n').length;
    lines.push(
      ...boundedLines(
        ['**Unseated eligible signups**'],
        working.unseatedUserIds.map((userId) => {
          const roles = declaredRoleLabels(eligibleRecords, userId);
          return `<@${userId}>${roles ? ` · ${roles}` : ''}`;
        }),
        (remaining) => (remaining > 0 ? `...and ${remaining} more.` : ''),
        remainingBudget,
      ),
    );
    lines.push('');
  }

  return { title: 'Pickup Open', description: lines.join('\n').trimEnd(), color: CARD_COLOR.open };
}

/**
 * A quiet per-pickup fingerprint appended to bot-authored messages that
 * `create()`/publish only ever send ONCE and whose ID is then relied on for
 * every later edit -- so startup recovery (see reconcile.ts) can recognise a
 * message that was already sent even if the write recording its ID never
 * landed, instead of guessing and risking a second, duplicate post. Discord's
 * small "subtext" syntax keeps it out of the way of the real content.
 *
 * Deliberately never added to renderSignupPost: that one is genuinely
 * plain, hand-written-looking text (see this file's header comment), and it
 * isn't at risk of this class of duplicate anyway -- create.ts posts it
 * before writing anything to the database, so a lost ID there just means no
 * pickup was ever created, not an orphaned message.
 *
 * For 'roster' (still plain content, see renderPublicRoster) this is baked
 * directly into the rendered text. For 'control' (now an embed, see
 * renderControlCard's own doc comment) every call site instead passes this
 * as the message's `content` field alongside the embed -- message-recovery.ts
 * only ever searches `message.content`, never embed fields.
 */
export function reconciliationMarker(kind: 'control' | 'roster', pickupId: number): string {
  return `-# lucid:${kind}:${pickupId}`;
}

/** The published public roster. */
export function renderPublicRoster(
  pickup: Pickup,
  slots: RosterSlot[],
  options: { finished?: boolean } = {},
): string {
  const lines: string[] = ['## Pickup Roster', ''];
  lines.push(`**Start:** ${discordShortTime(pickup.startAt)} ${discordRelative(pickup.startAt)}`);
  lines.push('');

  const replacementNeededUserIds = new Set(
    slots.filter((slot) => slot.replacementNeeded).map((slot) => slot.userId),
  );
  for (const team of teamsForFormat(pickup.format)) {
    lines.push(...renderTeamBlock(slots, team, { bold: true, replacementNeededUserIds }));
    lines.push('');
  }

  // Pickup vs Premade shows the opponent by name only. There are deliberately
  // no roster slots for them — Lucid never tracks the other team's players.
  if (pickup.format === 'pickup_vs_premade') {
    lines.push('### Premade Team');
    lines.push(pickup.premadeName ? `**${pickup.premadeName}**` : '_Premade team_');
    lines.push('');
  }

  if (options.finished) {
    lines.push('✅ This pickup is finished. Roster changes are closed.', '');
  }

  lines.push('', reconciliationMarker('roster', pickup.id));
  return lines.join('\n').trimEnd();
}

export function renderCancelledCard(pickup: Pickup): CardEmbed {
  return {
    title: '🚫 Pickup Cancelled',
    description: [
      `**Start was:** ${discordShortTime(pickup.startAt)}`,
      '',
      'This pickup was cancelled and is no longer collecting signups.',
    ].join('\n'),
    color: CARD_COLOR.cancelled,
  };
}

/**
 * A jump link to one of a pickup's canonical Discord messages, or null when
 * that message was never recorded.
 *
 * Never invent a link Lucid cannot stand behind: a missing ID means startup
 * reconciliation has not (yet) recovered that message, and a notification is
 * expected to simply omit the link rather than point somewhere misleading
 * (issue #36's navigation requirements).
 */
export function messageLink(
  guildId: string,
  channelId: string | null,
  messageId: string | null,
): string | null {
  if (!channelId || !messageId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Jump link to the public roster post — "View Roster" on player-facing notices. */
export function rosterMessageLink(pickup: Pickup): string | null {
  return messageLink(pickup.guildId, pickup.rosterChannelId, pickup.rosterMessageId);
}

/** Jump link to the public signup post — "View Signup" (issue #37). */
export function signupMessageLink(pickup: Pickup): string | null {
  return messageLink(pickup.guildId, pickup.signupChannelId, pickup.signupMessageId);
}

/**
 * Jump link to the persistent staff card — what "Manage Pickup" means (issue
 * #36), deliberately NOT the origin channel, which is routing context rather
 * than somewhere staff want to be sent.
 */
export function staffCardLink(pickup: Pickup): string | null {
  return messageLink(pickup.guildId, pickup.reviewChannelId, pickup.reviewMessageId);
}

/**
 * [View Signup]/[Manage Pickup] navigation links for the published public
 * roster message (issue #37) -- shared by every call site that renders
 * publishedRosterRows, so the same pair of links (or fewer, when a message
 * hasn't been recovered yet) shows up identically everywhere that surface is
 * drawn.
 *
 * "Manage Pickup" is deliberately dropped once the pickup is `finished` --
 * issue #37's own worked example for the finished roster shows only
 * `[View Signup]`. There is nothing left to manage on a closed-out roster,
 * and offering a deep link into the staff channel for a surface with no
 * remaining controls is exactly the "navigation action that loops uselessly"
 * the issue's own test list (#5) warns against.
 */
export function rosterNavLinks(pickup: Pickup): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  const signup = signupMessageLink(pickup);
  if (signup) links.push({ label: 'View Signup', url: signup });
  if (pickup.status !== 'finished') {
    const manage = staffCardLink(pickup);
    if (manage) links.push({ label: 'Manage Pickup', url: manage });
  }
  return links;
}

/**
 * The finished form of the public signup post (issue #37) -- mirrors
 * writeCancelledMessages' own struck-through rewrite of this same surface
 * for the OTHER terminal status, but finish and cancellation are mutually
 * exclusive (a pickup reaches exactly one terminal status), so there is no
 * risk of the two writers racing each other for the same message.
 */
export function renderFinishedSignupPost(pickup: Pickup): string {
  const lines = ['✓ Pickup finished'];
  const link = rosterMessageLink(pickup);
  if (link) lines.push(`[View Final Roster](${link})`);
  return lines.join('\n');
}

/**
 * The public notice posted when a replacement lands (issue #36).
 *
 * Written primarily FOR the incoming player rather than as a neutral log
 * line: they are the one who needs to know they are now playing, where, and
 * in place of whom. Only the incoming player is mentioned — see the
 * `allowedUserIds` the notification resolver pairs with this.
 */
export function renderReplacementNotice(params: {
  incomingUserId: string;
  outgoingUserId: string;
  slot: RosterSlot;
  pickup: Pickup;
}): string {
  const { incomingUserId, outgoingUserId, slot, pickup } = params;
  const teamPart = pickup.format === 'pickup_vs_pickup' ? `${TEAM_LABELS[slot.team]} · ` : '';
  const lines = [
    `<@${incomingUserId}>, you're in for the ${discordShortTime(pickup.startAt)} pickup.`,
    `${teamPart}${ROLE_LABELS[slot.role]} · replacing <@${outgoingUserId}>`,
  ];
  const link = rosterMessageLink(pickup);
  if (link) lines.push('', `[View Roster](${link})`);
  return lines.join('\n');
}

/**
 * The staff alert raised when a seated player says they can't play (issue
 * #36). Routed to the pickup's own snapshotted staff channel, never DMed and
 * never posted into another Pickup Space.
 */
export function renderAvailabilityAlert(params: {
  pickup: Pickup;
  slot: RosterSlot;
}): string {
  const { pickup, slot } = params;
  const mentions = [`<@${pickup.createdBy}>`];
  if (pickup.organizerPingRoleId) mentions.push(`<@&${pickup.organizerPingRoleId}>`);
  const lines = [
    `${mentions.join(' ')} · ⚠️ Replacement needed for the ${discordShortTime(pickup.startAt)} pickup`,
    `<@${slot.userId}> can no longer play ${slotLabel(slot, pickup.format)}.`,
  ];
  const links: string[] = [];
  const rosterLink = rosterMessageLink(pickup);
  if (rosterLink) links.push(`[View Roster](${rosterLink})`);
  const manageLink = staffCardLink(pickup);
  if (manageLink) links.push(`[Manage Pickup](${manageLink})`);
  if (links.length > 0) lines.push('', links.join(' · '));
  return lines.join('\n');
}

/**
 * The T-15 reminder posted to the current roster (issue #36).
 *
 * Recipients are resolved at DELIVERY time by the caller, not when the
 * reminder was scheduled — a player replaced in the meantime must not be
 * pinged, and the player who replaced them must.
 */
export function renderRosterReminder(params: { pickup: Pickup; userIds: string[] }): string {
  const { pickup, userIds } = params;
  const lines = [
    userIds.map((id) => `<@${id}>`).join(' '),
    `**Pickup starts in 15 minutes.** ${discordRelative(pickup.startAt)}`,
  ];
  const link = rosterMessageLink(pickup);
  if (link) lines.push('', `[View Roster](${link})`);
  return lines.join('\n');
}

/** "Order Solo — @player", used to label slots in select menus. */
export function slotLabel(slot: RosterSlot, format: Pickup['format']): string {
  const teamPart = format === 'pickup_vs_pickup' ? `${TEAM_LABELS[slot.team]} ` : '';
  return `${teamPart}${ROLE_LABELS[slot.role]}`;
}
