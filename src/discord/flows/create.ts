/**
 * `/pickup create` — the ephemeral setup wizard, the preview, and posting.
 *
 * The shape of this flow matters: a coordinator answers a few questions, sees
 * exactly what players will see, and only then does anything become real. Up
 * until the Post Pickup button, Lucid has written nothing anywhere — no rows,
 * no messages. That is what makes abandoning a half-finished wizard completely
 * harmless.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Message,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import {
  GuildConfigRepository,
  isConfigComplete,
  missingConfigFields,
} from '../../db/repositories/guild-config.js';
import {
  PickupSpaceRepository,
  isSpaceComplete,
  missingSpaceFields,
} from '../../db/repositories/pickup-spaces.js';
import { PickupRepository } from '../../db/repositories/pickups.js';
import { requireAuthorizedForSpace } from '../permissions.js';
import type { GuildConfig, Pickup, PickupSpace } from '../../db/repositories/types.js';
import { generateWorkingRoster } from '../../domain/roster.js';
import { SIGNUP_ROLES, type PickupFormat } from '../../domain/roles.js';
import { parseStartTime } from '../../domain/time.js';
import { controlCardRows } from '../components.js';
import { Action, encodeDraftId, type DecodedId } from '../ids.js';
import {
  boundedLines,
  DISCORD_MESSAGE_LIMIT,
  eligibilityMentions,
  renderControlCard,
  renderSignupPost,
} from '../render.js';

// ---------------------------------------------------------------------------
// Wizard state
// ---------------------------------------------------------------------------

interface Draft {
  guildId: string;
  userId: string;
  /** Resolved once, from the channel `/pickup create` was run in — see resolveSpace. */
  spaceId: number;
  format: PickupFormat;
  /** Exactly what the coordinator typed, kept so Edit can pre-fill the modal. */
  startAtInput: string | null;
  /** Unix seconds, once the typed text has been understood. */
  startAt: number | null;
  roleLimit: number;
  note: string | null;
  premadeName: string | null;
  eligibilityRoleIds: string[];
}

/**
 * In-flight wizards, keyed by a random draft ID.
 *
 * Holding this in memory is acceptable ONLY because nothing is persisted until
 * Post Pickup is clicked. If Lucid restarts mid-wizard the draft is simply gone
 * and the coordinator runs the command again — there is no orphaned pickup, no
 * stray message, and nothing to clean up. Do not start writing rows earlier
 * without moving this state into the database first.
 */
const drafts = new Map<string, Draft>();

/**
 * A fresh, unguessable draft ID.
 *
 * Digits only, and short enough to stay an exact integer, because the shared
 * router decodes EVERY custom ID with `decodeId()` and throws away any ID whose
 * second segment isn't an integer. The wizard has no pickup row yet, so that
 * segment carries this draft ID instead (see `encodeDraftId`) — if it were a
 * plain UUID the router would silently drop every wizard click.
 */
function newDraftId(): string {
  return randomUUID().replace(/\D/g, '').slice(0, 15);
}

/**
 * Pull the draft ID back out of a component or modal custom ID.
 *
 * Read from the raw custom ID rather than `decoded.pickupId`: the decoder turns
 * that segment into a number, which drops any leading zero and would no longer
 * match the key we stored.
 */
function draftIdFrom(customId: string, decoded: DecodedId): string | null {
  const segment = customId.split(':')[1];
  if (segment) return segment;
  // Fallback, should the router ever hand us only the decoded form.
  return Number.isInteger(decoded.pickupId) ? String(decoded.pickupId) : null;
}

// ---------------------------------------------------------------------------
// Wizard rendering
// ---------------------------------------------------------------------------

const FORMAT_LABELS: Record<PickupFormat, string> = {
  pickup_vs_pickup: 'Pickup vs Pickup',
  pickup_vs_premade: 'Pickup vs Premade',
};

function wizardView(draftId: string, draft: Draft): {
  content: string;
  components: ActionRowBuilder<StringSelectMenuBuilder | RoleSelectMenuBuilder | ButtonBuilder>[];
} {
  const formatSelect = new StringSelectMenuBuilder()
    .setCustomId(encodeDraftId(Action.CreateFormat, draftId))
    .setPlaceholder('Format')
    .addOptions(
      {
        label: FORMAT_LABELS.pickup_vs_pickup,
        description: 'Two pickup teams, Order and Chaos.',
        value: 'pickup_vs_pickup',
        default: draft.format === 'pickup_vs_pickup',
      },
      {
        label: FORMAT_LABELS.pickup_vs_premade,
        description: 'One pickup team against a named premade.',
        value: 'pickup_vs_premade',
        default: draft.format === 'pickup_vs_premade',
      },
    );

  const roleLimitSelect = new StringSelectMenuBuilder()
    .setCustomId(encodeDraftId(Action.CreateRoleLimit, draftId))
    .setPlaceholder('Signup role limit')
    .addOptions(
      {
        label: '1 role',
        description: 'Each player may sign up for one role.',
        value: '1',
        default: draft.roleLimit === 1,
      },
      {
        label: '2 roles',
        description: 'Each player may sign up for up to two roles.',
        value: '2',
        default: draft.roleLimit === 2,
      },
    );

  const detailsButton = new ButtonBuilder()
    .setCustomId(encodeDraftId(Action.CreateOpenDetails, draftId))
    .setLabel(draft.startAt ? 'Edit details' : 'Enter details')
    .setStyle(ButtonStyle.Primary);

  const eligibilityRole = new RoleSelectMenuBuilder()
    .setCustomId(encodeDraftId(Action.CreateEligibilityRole, draftId))
    .setPlaceholder('Eligibility roles (optional — clear selection for everyone)')
    .setMinValues(0)
    .setMaxValues(25);

  const lines = [
    '## New pickup',
    '',
    `**Format:** ${FORMAT_LABELS[draft.format]}`,
    `**Role limit:** ${draft.roleLimit === 1 ? '1 role' : '2 roles'}`,
    `**Start time:** ${draft.startAtInput ? `\`${draft.startAtInput}\`` : '_not set_'}`,
    `**Eligibility:** ${eligibilityMentions(draft.eligibilityRoleIds)}`,
  ];
  if (draft.format === 'pickup_vs_premade') {
    lines.push(`**Premade team:** ${draft.premadeName ? draft.premadeName : '_not set_'}`);
  }
  lines.push('');
  lines.push('Pick the format and role limit, then press the button to enter the start time.');
  lines.push('Nothing is posted until you approve the preview.');

  return {
    content: lines.join('\n'),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder | RoleSelectMenuBuilder | ButtonBuilder>().addComponents(formatSelect),
      new ActionRowBuilder<StringSelectMenuBuilder | RoleSelectMenuBuilder | ButtonBuilder>().addComponents(roleLimitSelect),
      new ActionRowBuilder<StringSelectMenuBuilder | RoleSelectMenuBuilder | ButtonBuilder>().addComponents(eligibilityRole),
      new ActionRowBuilder<StringSelectMenuBuilder | RoleSelectMenuBuilder | ButtonBuilder>().addComponents(detailsButton),
    ],
  };
}

function detailsModal(draftId: string, draft: Draft): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(encodeDraftId(Action.CreateDetailsModal, draftId))
    .setTitle('Pickup details');

  const startTime = new TextInputBuilder()
    .setCustomId('start_time')
    .setLabel('Start time')
    .setPlaceholder('tonight at 8')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  if (draft.startAtInput) startTime.setValue(draft.startAtInput);

  const note = new TextInputBuilder()
    .setCustomId('note')
    .setLabel('Note (optional)')
    .setPlaceholder('Anything else players should know.')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);
  if (draft.note) note.setValue(draft.note);

  const rows = [
    new ActionRowBuilder<TextInputBuilder>().addComponents(startTime),
    new ActionRowBuilder<TextInputBuilder>().addComponents(note),
  ];

  // Only Pickup vs Premade has an opponent to name, so the field only exists
  // for that format rather than sitting there confusingly blank.
  if (draft.format === 'pickup_vs_premade') {
    const premade = new TextInputBuilder()
      .setCustomId('premade_name')
      .setLabel('Premade team name')
      .setPlaceholder('Dream Walkers')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (draft.premadeName) premade.setValue(draft.premadeName);
    rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(premade));
  }

  modal.addComponents(...rows);
  return modal;
}

function previewButtons(draftId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeDraftId(Action.CreatePost, draftId))
        .setLabel('Post Pickup')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(encodeDraftId(Action.CreateEdit, draftId))
        .setLabel('Edit')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(encodeDraftId(Action.CreateCancel, draftId))
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

/**
 * Render the preview using the exact arguments the public post will use.
 *
 * Same function, same inputs, same output — what the coordinator approves is
 * character-for-character what players get.
 */
function previewContent(draft: Draft, pingRoleId: string | null, startAt: number): string {
  return renderSignupPost({
    format: draft.format,
    startAt,
    roleLimit: draft.roleLimit,
    note: draft.note,
    premadeName: draft.premadeName,
    pingRoleId,
    eligibilityRoleIds: draft.eligibilityRoleIds,
  });
}

// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------

export async function handleCreateCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'Run this inside a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const space = new PickupSpaceRepository().byOriginChannel(interaction.guildId, interaction.channelId);
  if (!space) {
    await interaction.reply({
      content: await noOriginChannelMessage(interaction.guildId),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const authorized = await requireAuthorizedForSpace(interaction, space);
  if (!authorized) return;

  // A half-configured space is a normal state, so check completeness rather
  // than mere existence — and say exactly what is missing instead of failing
  // later, halfway through posting.
  if (!isSpaceComplete(space)) {
    await interaction.reply({
      content: [
        `**${space.name}** is not fully configured yet, so pickups cannot be created here.`,
        '',
        'Still missing:',
        ...missingSpaceFields(space).map((field) => `• ${field}`),
        '',
        'An admin can finish setup with `/pickup space edit`.',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const config = new GuildConfigRepository().get(interaction.guildId);
  if (!isConfigComplete(config)) {
    await interaction.reply({
      content: [
        'Lucid is not fully configured yet, so pickups cannot be created.',
        '',
        'Still missing:',
        ...missingConfigFields(config).map((field) => `• ${field}`),
        '',
        'An admin can finish setup with `/pickup config bind_emoji:true`.',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const draftId = newDraftId();
  const draft: Draft = {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    spaceId: space.id,
    format: 'pickup_vs_pickup',
    startAtInput: null,
    startAt: null,
    roleLimit: 2,
    note: null,
    premadeName: null,
    // Seeded from the space's defaults, not hardcoded unrestricted — a
    // restricted space's whole policy would otherwise silently not apply
    // unless the coordinator remembered to reselect it every time. Still
    // fully overridable/clearable in the wizard, same as before.
    eligibilityRoleIds: [...space.defaultEligibilityRoleIds],
  };
  drafts.set(draftId, draft);

  await interaction.reply({ ...wizardView(draftId, draft), flags: MessageFlags.Ephemeral });
}

/**
 * What to tell a coordinator who ran `/pickup create` outside any configured
 * origin channel.
 *
 * Bulleted and bounded with `boundedLines()` rather than one long
 * comma-joined sentence -- a guild running enough Pickup Spaces could
 * otherwise blow past Discord's 2000-character cap, same failure class as
 * the codex review finding on `/pickup space list`.
 */
async function noOriginChannelMessage(guildId: string): Promise<string> {
  const spaces = new PickupSpaceRepository().list(guildId).filter((space) => space.originChannelId);
  if (spaces.length === 0) {
    return 'No Pickup Space is configured yet. An admin can create one with `/pickup space create`.';
  }
  const lines = boundedLines(
    ['Run `/pickup create` from a configured origin channel:', ''],
    spaces.map((space) => `• <#${space.originChannelId}>`),
    (remaining) => (remaining > 0 ? `...and ${remaining} more.` : ''),
  );
  return lines.join('\n');
}

/**
 * The staff guard, resolved fresh against the wizard's own space on every
 * interaction — not just once at command time. `requireAuthorizedForSpace`
 * replies with the standard refusal itself, so callers only need to check for
 * null. The cast is needed because that helper is typed against discord.js's
 * `Interaction` union, which names the concrete component classes;
 * `MessageComponentInteraction` is their shared base class, so it satisfies
 * the guard in practice but not by name.
 */
async function requireStaff(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  draft: Draft,
): Promise<PickupSpace | null> {
  const space = new PickupSpaceRepository().get(draft.spaceId);
  return requireAuthorizedForSpace(interaction as Parameters<typeof requireAuthorizedForSpace>[0], space);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export async function handleCreateComponent(
  interaction: MessageComponentInteraction,
  decoded: DecodedId,
): Promise<void> {
  if (!interaction.guildId) return;

  const draftId = draftIdFrom(interaction.customId, decoded);
  const draft = draftId ? drafts.get(draftId) : undefined;

  if (!draftId || !draft) {
    await interaction.update({
      content:
        'This setup is no longer active — it may have expired or Lucid restarted. Run `/pickup create` again. Nothing was posted.',
      components: [],
    });
    return;
  }

  // The wizard is ephemeral, but authorization is re-checked on every
  // interaction regardless: who can see a message is not an access boundary.
  if (draft.userId !== interaction.user.id) {
    await interaction.reply({ content: 'That setup belongs to someone else.', flags: MessageFlags.Ephemeral });
    return;
  }

  const space = await requireStaff(interaction, draft);
  if (!space) return;

  switch (decoded.action) {
    case Action.CreateFormat: {
      if (!interaction.isStringSelectMenu()) return;
      const value = interaction.values[0];
      draft.format = value === 'pickup_vs_premade' ? 'pickup_vs_premade' : 'pickup_vs_pickup';
      // Switching away from a premade match drops the now-meaningless name.
      if (draft.format === 'pickup_vs_pickup') draft.premadeName = null;
      await interaction.update(wizardView(draftId, draft));
      return;
    }

    case Action.CreateRoleLimit: {
      if (!interaction.isStringSelectMenu()) return;
      draft.roleLimit = interaction.values[0] === '1' ? 1 : 2;
      await interaction.update(wizardView(draftId, draft));
      return;
    }

    case Action.CreateOpenDetails: {
      await interaction.showModal(detailsModal(draftId, draft));
      return;
    }

    case Action.CreateEdit: {
      // Back to the first step with every earlier answer intact.
      await interaction.update(wizardView(draftId, draft));
      return;
    }

    case Action.CreateCancel: {
      drafts.delete(draftId);
      await interaction.update({ content: 'Cancelled.', components: [] });
      return;
    }

    case Action.CreatePost: {
      await postPickup(interaction, draftId, draft, space, false);
      return;
    }

    case Action.CreateEligibilityRole: {
      if (!interaction.isRoleSelectMenu()) return;
      draft.eligibilityRoleIds = [...interaction.values];
      await interaction.update(wizardView(draftId, draft));
      return;
    }

    case Action.CreatePostAnyway: {
      await postPickup(interaction, draftId, draft, space, true);
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export async function handleCreateModal(
  interaction: ModalSubmitInteraction,
  decoded: DecodedId,
): Promise<void> {
  if (!interaction.guildId) return;

  const draftId = draftIdFrom(interaction.customId, decoded);
  const draft = draftId ? drafts.get(draftId) : undefined;

  if (!draftId || !draft) {
    await interaction.reply({
      content:
        'This setup is no longer active — it may have expired or Lucid restarted. Run `/pickup create` again. Nothing was posted.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (draft.userId !== interaction.user.id) {
    await interaction.reply({ content: 'That setup belongs to someone else.', flags: MessageFlags.Ephemeral });
    return;
  }

  const space = await requireStaff(interaction, draft);
  if (!space) return;

  const startInput = interaction.fields.getTextInputValue('start_time');
  draft.startAtInput = startInput;

  const note = safeField(interaction, 'note');
  draft.note = note && note.trim() ? note.trim() : null;

  if (draft.format === 'pickup_vs_premade') {
    const premade = safeField(interaction, 'premade_name');
    draft.premadeName = premade && premade.trim() ? premade.trim() : null;
  }

  const timezone = new GuildConfigRepository().get(interaction.guildId)?.timezone ?? 'America/New_York';
  const parsed = parseStartTime(startInput, timezone);
  if (!parsed.ok) {
    // The wizard message is still on screen with its button, so the coordinator
    // just presses it again — their text is pre-filled next time.
    await interaction.reply({
      content: `${parsed.message}\n\nPress **Edit details** on the setup message to try again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  draft.startAt = parsed.startAt;

  const previewText = previewContent(draft, space.signupPingRoleId, parsed.startAt);
  if (previewText.length > DISCORD_MESSAGE_LIMIT) {
    // codex review finding on PR #38: enough eligibility roles plus a note
    // that's individually well within the modal's own limit can still push
    // the assembled post over Discord's 2000-character cap. Never silently
    // truncate a coordinator-authored note -- that could cut off exactly the
    // detail players needed -- so refuse with the overage and leave the
    // wizard message (and its pre-filled fields) on screen to edit.
    await interaction.reply({
      content:
        `This post is ${previewText.length - DISCORD_MESSAGE_LIMIT} characters over Discord's ` +
        `${DISCORD_MESSAGE_LIMIT}-character limit. Shorten the note or select fewer eligibility roles.\n\n` +
        'Press **Edit details** on the setup message to try again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const payload = {
    content: previewText,
    components: previewButtons(draftId),
    // The preview renders the real ping text, but must not actually ping
    // anyone — suppressing mentions leaves the text untouched while making the
    // mention inert. Do NOT strip the ping from the text instead; the preview
    // would then stop matching the real post.
    allowedMentions: { parse: [] as const },
  };

  if (interaction.isFromMessage()) {
    await interaction.update(payload);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

/** Optional modal inputs throw if absent, which is not an error for us. */
function safeField(interaction: ModalSubmitInteraction, id: string): string | null {
  try {
    return interaction.fields.getTextInputValue(id);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Posting — the only place anything is written
// ---------------------------------------------------------------------------

/** Retry a Discord call a couple of times before giving up. */
async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  const backoffMs = [500, 1000];
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      const delay = backoffMs[attempt] ?? 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/** One line per overlapping pickup, with a link to its signup post when it has one. */
function overlapRows(overlaps: Pickup[]): string[] {
  return overlaps.map((pickup) => {
    const link =
      pickup.signupMessageId && pickup.signupChannelId
        ? `https://discord.com/channels/${pickup.guildId}/${pickup.signupChannelId}/${pickup.signupMessageId}`
        : null;
    return `• ${FORMAT_LABELS[pickup.format]} — ${pickup.status}${link ? ` — [open signup](${link})` : ''}`;
  });
}

async function postPickup(
  interaction: MessageComponentInteraction,
  draftId: string,
  draft: Draft,
  space: PickupSpace,
  overlapConfirmed: boolean,
): Promise<void> {
  if (draft.startAt === null) {
    await interaction.reply({
      content: 'Enter a start time before posting.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!space.signupChannelId || !space.rosterChannelId || !space.reviewChannelId) {
    await interaction.reply({
      content: `The signup, roster, or staff review channel for **${space.name}** is no longer configured. Run \`/pickup space edit\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Narrowed to plain locals rather than relying on `space.xChannelId` staying
  // narrowed across the several awaits below.
  const signupChannelId = space.signupChannelId;
  const rosterChannelId = space.rosterChannelId;
  const reviewChannelId = space.reviewChannelId;

  const pickups = new PickupRepository();
  const overlaps = pickups.overlappingForCoordinator(draft.guildId, draft.userId, draft.startAt);
  if (!overlapConfirmed && overlaps.length > 0) {
    const rows = overlapRows(overlaps);
    // A coordinator running enough overlapping pickups could otherwise blow
    // past Discord's 2000-character cap, same failure class as the codex
    // review finding on `/pickup space list` -- bound this list too.
    const lines = boundedLines(
      [`You already created ${overlaps.length === 1 ? 'a pickup' : `${overlaps.length} pickups`} for <t:${draft.startAt}:F>.`],
      rows,
      (remaining) =>
        remaining > 0
          ? `...and ${remaining} more.\n\nThis may be intentional. Create another independent pickup at the same time?`
          : 'This may be intentional. Create another independent pickup at the same time?',
    );
    await interaction.update({
      content: lines.join('\n'),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeDraftId(Action.CreatePostAnyway, draftId))
          .setLabel('Create another pickup')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(encodeDraftId(Action.CreateEdit, draftId))
          .setLabel('Go back')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(encodeDraftId(Action.CreateCancel, draftId))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      )],
      allowedMentions: { parse: [] },
    });
    return;
  }

  // Posting, seeding configured reactions and writing the staff card takes longer
  // than Discord's three-second response window.
  await interaction.deferUpdate();

  const signupChannel = await interaction.client.channels.fetch(signupChannelId);
  if (!signupChannel || !signupChannel.isSendable()) {
    await interaction.editReply({
      content: 'Lucid cannot post in the configured signup channel. Check its permissions.',
      components: [],
    });
    return;
  }

  // Post first, persist second. If the send fails — a transient Discord
  // outage, a permission pulled between the isSendable() check above and now —
  // there is nothing left behind: no pickup row, nothing to notice or clean
  // up. The coordinator just sees an error and tries again. Creating the row
  // first would leave a permanently `open` pickup pointing at a message that
  // never existed, showing up in cancellation pickers with nothing to cancel.
  let signupMessage: Message;
  try {
    signupMessage = await signupChannel.send({
      content: previewContent(draft, space.signupPingRoleId, draft.startAt),
      // The real post pings for real — but only the one configured role.
      allowedMentions: space.signupPingRoleId ? { roles: [space.signupPingRoleId] } : { parse: [] },
    });
  } catch (error) {
    console.error('[create] failed to post the signup message', error);
    await interaction.editReply({
      content: "Couldn't post the signup message. Check Lucid's permissions and try again.",
      components: [],
    });
    return;
  }

  // Re-run the overlap check right here, in the same synchronous step as the
  // write below -- the check above ran before three real awaits (defer,
  // channel fetch, send), wide enough for a second `/pickup create` from this
  // same coordinator to run its own unconfirmed check, see zero overlaps, and
  // slip through undetected (issue #40). Nothing awaits between this line and
  // pickups.create(), so nothing can interleave and invalidate it again. The
  // signup message above is already posted by this point, so there's no
  // prompt left to show -- surface it as a note on the final reply instead.
  const raceOverlaps = overlapConfirmed
    ? []
    : pickups.overlappingForCoordinator(draft.guildId, draft.userId, draft.startAt);

  // From here on the pickup is real. Everything before this line was a draft.
  // Channels/roles are snapshotted from the space as it stood right now, not
  // resolved live later — editing the space afterwards must not silently move
  // where this pickup posts. See the Pickup doc comment in types.ts.
  let pickup: Pickup;
  try {
    pickup = pickups.create({
      guildId: draft.guildId,
      createdBy: draft.userId,
      format: draft.format,
      startAt: draft.startAt,
      roleLimit: draft.roleLimit,
      note: draft.note,
      premadeName: draft.premadeName,
      eligibilityRoleIds: draft.eligibilityRoleIds,
      pickupSpaceId: space.id,
      originChannelId: space.originChannelId,
      signupChannelId,
      rosterChannelId,
      reviewChannelId,
      signupPingRoleId: space.signupPingRoleId,
      organizerPingRoleId: space.organizerPingRoleId,
    });
  } catch (error) {
    // pickup_space_id is a real foreign key, so this can only mean the space
    // was deleted in the narrow window between resolving it and reaching
    // this line — PickupSpaceRepository.delete refuses unless a space has
    // zero pickups, so this one must have had none until now. codex review
    // finding on PR #38: the signup message above is already public by this
    // point; clean it up rather than leaving an orphaned post with no
    // pickup row behind it and no answer on the deferred interaction.
    console.error(
      `[create] pickup row could not be created after the signup message was already posted -- ` +
        `Pickup Space ${space.id} was likely deleted mid-flow`,
      error,
    );
    await signupMessage.delete().catch(() => undefined);
    await interaction.editReply({
      content: 'This Pickup Space was deleted while posting. Nothing was created; try again.',
      components: [],
    });
    return;
  }

  pickups.setMessageIds(pickup.id, { signupMessageId: signupMessage.id });

  const config = new GuildConfigRepository().get(draft.guildId);
  await seedReactions(signupMessage, config, pickup.id);
  await postControlCard(interaction, pickup, reviewChannelId, pickups);

  drafts.delete(draftId);

  // codex/Half-Shell review finding on PR #48: enough raced overlaps here
  // could otherwise blow past Discord's 2000-character cap on this editReply
  // -- same failure class as the entry-time prompt above, and worse here
  // since the pickup is already persisted by this point; bound it the same way.
  const content =
    raceOverlaps.length > 0
      ? boundedLines(
          [
            `Pickup posted: ${signupMessage.url}`,
            '',
            `You already have ${raceOverlaps.length === 1 ? 'a pickup' : `${raceOverlaps.length} pickups`} at this same time:`,
          ],
          overlapRows(raceOverlaps),
          (remaining) => (remaining > 0 ? `...and ${remaining} more.` : ''),
        ).join('\n')
      : `Pickup posted: ${signupMessage.url}`;

  await interaction.editReply({ content, components: [] });
}

/**
 * Seed the five required role reactions and optional Fill.
 *
 * Order is fixed (Solo → Jungle → Mid → Support → Carry) and awaited one at a
 * time on purpose: players read the reaction bar left to right and expect the
 * same order on every post, and Discord shows reactions in the order they were
 * added. Firing them in parallel would scramble that order.
 *
 * Each add retries, because a rate limit that drops one emoji leaves a role
 * nobody can sign up for — a silent failure that only surfaces when the roster
 * never fills.
 */
async function seedReactions(
  message: Message,
  config: GuildConfig | null,
  pickupId: number,
): Promise<void> {
  if (!config) return;
  const emojiByRole = new GuildConfigRepository().emojiMap(config);

  for (const role of SIGNUP_ROLES) {
    const emojiId = emojiByRole[role];
    if (!emojiId) continue;
    try {
      await withRetry(() => message.react(emojiId));
    } catch (error) {
      console.error(
        `[create] Failed to seed the ${role} reaction on pickup ${pickupId}. ` +
          'Players will not be able to sign up for that role until it is added manually.',
        error,
      );
    }
  }
}

/**
 * Post the staff control card alongside the public post.
 *
 * This happens in the same operation as posting, not lazily later, because the
 * Cancel button lives on this card — without it, a pickup that never fills up
 * would have no button to cancel it.
 */
async function postControlCard(
  interaction: MessageComponentInteraction,
  pickup: Pickup,
  reviewChannelId: string,
  pickups: PickupRepository,
): Promise<void> {
  try {
    const reviewChannel = await interaction.client.channels.fetch(reviewChannelId);
    if (!reviewChannel || !reviewChannel.isSendable()) {
      throw new Error(`Review channel ${reviewChannelId} is not sendable.`);
    }

    const reviewMessage = await reviewChannel.send({
      // No signups exist yet, so there is nothing to fetch from the guild —
      // an empty working roster is the same all-OPEN reading a real empty
      // pool would produce, and gets redrawn for real by evaluateRosterReady
      // the moment the first reaction comes in.
      content: renderControlCard(pickup, generateWorkingRoster([], pickup.format), []),
      components: controlCardRows(pickup.id),
      // The card can render <@&eligibilityRoleId> — every later edit already
      // suppresses mentions (review.ts's SILENT), and this first post must
      // too, or posting a restricted pickup pings its entire eligibility role.
      allowedMentions: { parse: [] },
    });
    pickups.setMessageIds(pickup.id, { reviewMessageId: reviewMessage.id });
  } catch (error) {
    console.error(
      `[create] Pickup ${pickup.id} was posted publicly but its staff control card could not be ` +
        `posted to channel ${reviewChannelId}. Staff have no Cancel button for it until this is fixed.`,
      error,
    );
  }
}
