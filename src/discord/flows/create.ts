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
import { PickupRepository } from '../../db/repositories/pickups.js';
import { requireAuthorized } from '../permissions.js';
import type { GuildConfig, Pickup } from '../../db/repositories/types.js';
import { SIGNUP_ROLES, type PickupFormat } from '../../domain/roles.js';
import { parseStartTime } from '../../domain/time.js';
import { controlCardRows } from '../components.js';
import { Action, encodeDraftId, type DecodedId } from '../ids.js';
import { renderControlCard, renderSignupPost } from '../render.js';

// ---------------------------------------------------------------------------
// Wizard state
// ---------------------------------------------------------------------------

interface Draft {
  guildId: string;
  userId: string;
  format: PickupFormat;
  /** Exactly what the coordinator typed, kept so Edit can pre-fill the modal. */
  startAtInput: string | null;
  /** Unix seconds, once the typed text has been understood. */
  startAt: number | null;
  roleLimit: number;
  note: string | null;
  premadeName: string | null;
  eligibilityRoleId: string | null;
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
    .setPlaceholder('Eligibility role (optional — clear selection for everyone)')
    .setMinValues(0)
    .setMaxValues(1);

  const lines = [
    '## New pickup',
    '',
    `**Format:** ${FORMAT_LABELS[draft.format]}`,
    `**Role limit:** ${draft.roleLimit === 1 ? '1 role' : '2 roles'}`,
    `**Start time:** ${draft.startAtInput ? `\`${draft.startAtInput}\`` : '_not set_'}`,
    `**Eligibility:** ${draft.eligibilityRoleId ? `<@&${draft.eligibilityRoleId}>` : 'Everyone'}`,
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
function previewContent(draft: Draft, config: GuildConfig, startAt: number): string {
  return renderSignupPost({
    format: draft.format,
    startAt,
    roleLimit: draft.roleLimit,
    note: draft.note,
    premadeName: draft.premadeName,
    pingRoleId: config.pingRoleId,
    eligibilityRoleId: draft.eligibilityRoleId,
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

  const config = await requireStaff(interaction);
  if (!config) return;

  // A half-configured guild is a normal state, so check completeness rather
  // than mere existence — and say exactly what is missing instead of failing
  // later, halfway through posting.
  if (!isConfigComplete(config)) {
    await interaction.reply({
      content: [
        'Lucid is not fully configured yet, so pickups cannot be created.',
        '',
        'Still missing:',
        ...missingConfigFields(config).map((field) => `• ${field}`),
        '',
        'An admin can finish setup with `/pickup config`.',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const draftId = newDraftId();
  const draft: Draft = {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    format: 'pickup_vs_pickup',
    startAtInput: null,
    startAt: null,
    roleLimit: 2,
    note: null,
    premadeName: null,
    eligibilityRoleId: null,
  };
  drafts.set(draftId, draft);

  await interaction.reply({ ...wizardView(draftId, draft), flags: MessageFlags.Ephemeral });
}

/**
 * The staff guard.
 *
 * `requireAuthorized` replies with the standard refusal itself, so callers only
 * need to check for null. The cast is needed because that helper is typed
 * against discord.js's `Interaction` union, which names the concrete component
 * classes; `MessageComponentInteraction` is their shared base class, so it
 * satisfies the guard in practice but not by name.
 */
async function requireStaff(
  interaction: ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction,
): Promise<GuildConfig | null> {
  return requireAuthorized(interaction as Parameters<typeof requireAuthorized>[0]);
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

  const config = await requireStaff(interaction);
  if (!config) return;

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
      await postPickup(interaction, draftId, draft, config, false);
      return;
    }

    case Action.CreateEligibilityRole: {
      if (!interaction.isRoleSelectMenu()) return;
      draft.eligibilityRoleId = interaction.values[0] ?? null;
      await interaction.update(wizardView(draftId, draft));
      return;
    }

    case Action.CreatePostAnyway: {
      await postPickup(interaction, draftId, draft, config, true);
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

  const config = await requireStaff(interaction);
  if (!config) return;

  const startInput = interaction.fields.getTextInputValue('start_time');
  draft.startAtInput = startInput;

  const note = safeField(interaction, 'note');
  draft.note = note && note.trim() ? note.trim() : null;

  if (draft.format === 'pickup_vs_premade') {
    const premade = safeField(interaction, 'premade_name');
    draft.premadeName = premade && premade.trim() ? premade.trim() : null;
  }

  const parsed = parseStartTime(startInput, config.timezone);
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

  const payload = {
    content: previewContent(draft, config, parsed.startAt),
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

async function postPickup(
  interaction: MessageComponentInteraction,
  draftId: string,
  draft: Draft,
  config: GuildConfig,
  overlapConfirmed: boolean,
): Promise<void> {
  if (draft.startAt === null) {
    await interaction.reply({
      content: 'Enter a start time before posting.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!config.signupChannelId || !config.reviewChannelId) {
    await interaction.reply({
      content: 'The signup or staff review channel is no longer configured. Run `/pickup config`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const pickups = new PickupRepository();
  const overlaps = pickups.overlappingForCoordinator(draft.guildId, draft.userId, draft.startAt);
  if (!overlapConfirmed && overlaps.length > 0) {
    const rows = overlaps.map((pickup) => {
      const link = pickup.signupMessageId
        ? `https://discord.com/channels/${pickup.guildId}/${config.signupChannelId}/${pickup.signupMessageId}`
        : null;
      return `• ${FORMAT_LABELS[pickup.format]} — ${pickup.status}${link ? ` — [open signup](${link})` : ''}`;
    });
    await interaction.update({
      content: [
        `You already created ${overlaps.length === 1 ? 'a pickup' : `${overlaps.length} pickups`} for <t:${draft.startAt}:F>.`,
        ...rows,
        '',
        'This may be intentional. Create another independent pickup at the same time?',
      ].join('\n'),
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

  const signupChannel = await interaction.client.channels.fetch(config.signupChannelId);
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
      content: previewContent(draft, config, draft.startAt),
      // The real post pings for real — but only the one configured role.
      allowedMentions: config.pingRoleId ? { roles: [config.pingRoleId] } : { parse: [] },
    });
  } catch (error) {
    console.error('[create] failed to post the signup message', error);
    await interaction.editReply({
      content: "Couldn't post the signup message. Check Lucid's permissions and try again.",
      components: [],
    });
    return;
  }

  // From here on the pickup is real. Everything before this line was a draft.
  const pickup = pickups.create({
    guildId: draft.guildId,
    createdBy: draft.userId,
    format: draft.format,
    startAt: draft.startAt,
    roleLimit: draft.roleLimit,
    note: draft.note,
    premadeName: draft.premadeName,
    eligibilityRoleId: draft.eligibilityRoleId,
  });

  pickups.setMessageIds(pickup.id, { signupMessageId: signupMessage.id });

  await seedReactions(signupMessage, config, pickup.id);
  await postControlCard(interaction, pickup, config.reviewChannelId, pickups);

  drafts.delete(draftId);

  await interaction.editReply({
    content: `Pickup posted: ${signupMessage.url}`,
    components: [],
  });
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
  config: GuildConfig,
  pickupId: number,
): Promise<void> {
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
      content: renderControlCard(pickup, 0),
      components: controlCardRows(pickup.id),
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
