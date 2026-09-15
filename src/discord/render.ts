/**
 * Message rendering.
 *
 * The public signup post is intentionally plain text in the style the Dream
 * Walkers community already writes by hand. It is NOT an embed or an event
 * card, and it should not become one — the whole point is that it looks like a
 * person posted it. Keep additions here minimal and unlabelled.
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
): string {
  const lines: string[] = ['## Pickup Ready', ''];
  lines.push(`**Start:** ${discordShortTime(pickup.startAt)} ${discordRelative(pickup.startAt)}`);
  lines.push('');

  for (const team of teamsForFormat(pickup.format)) {
    lines.push(...renderTeamBlock(slots, team, options));
    lines.push('');
  }

  if (pickup.format === 'pickup_vs_premade') {
    lines.push('### Opponent');
    lines.push(pickup.premadeName ? `**${pickup.premadeName}**` : '_Premade team_');
    lines.push('');
  }

  if (options.withdrawnUserIds && options.withdrawnUserIds.size > 0) {
    lines.push(
      '⚠️ One or more players have withdrawn their signup. Use Shuffle or Edit Roster to replace them before publishing.',
    );
  }
  if (options.ineligibleUserIds && options.ineligibleUserIds.size > 0) {
    lines.push(
      '⚠️ One or more players no longer hold an eligibility role. Use Shuffle or Edit Roster before publishing.',
    );
  }
  if (options.finished) {
    lines.push('✅ This pickup is finished. Roster changes are closed.');
  }

  return lines.join('\n').trimEnd();
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
 */
export function renderControlCard(
  pickup: Pickup,
  working: WorkingRosterResult,
  eligibleRecords: readonly SignupRecord[],
  options: ControlCardOptions = {},
): string {
  const lines: string[] = ['## Pickup Open', ''];
  lines.push(`**Start:** ${discordShortTime(pickup.startAt)} ${discordRelative(pickup.startAt)}`);
  if (pickup.format === 'pickup_vs_premade' && pickup.premadeName) {
    lines.push(`**Opponent:** ${pickup.premadeName}`);
  }
  lines.push(`**Role limit:** ${roleLimitPhrase(pickup.roleLimit)}`);
  if (pickup.eligibilityRoleIds.length > 0) {
    lines.push(`**Eligibility:** ${eligibilityMentions(pickup.eligibilityRoleIds)}`);
  }
  lines.push('');

  // The marker is appended before every return below, not just the default
  // one -- reconcile.ts's search must be able to find this card by content
  // regardless of which state it currently shows (a working roster, a
  // missing role, or a failed lookup), or a legitimately-posted card caught
  // mid-error would look "never sent" and get duplicated.
  const marker = reconciliationMarker('control', pickup.id);

  if (options.eligibilityError === 'role-missing') {
    lines.push(
      '⚠️ **None of this pickup\'s eligibility roles exist anymore.** Reactions cannot be verified. There is no ' +
        'way to change a pickup\'s eligibility roles after it\'s posted — **Cancel** this pickup below and run ' +
        '`/pickup create` again once the roles are fixed.',
    );
    lines.push('', marker);
    return lines.join('\n').trimEnd();
  }
  if (options.eligibilityError === 'lookup-failed') {
    lines.push(
      '⚠️ **Lucid could not verify eligibility for this pickup right now** (a temporary error, not a ' +
        'configuration problem). The roster will resume updating automatically as reactions come in — no action needed.',
    );
    lines.push('', marker);
    return lines.join('\n').trimEnd();
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

  lines.push(marker);
  return lines.join('\n').trimEnd();
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

  for (const team of teamsForFormat(pickup.format)) {
    lines.push(...renderTeamBlock(slots, team, { bold: true }));
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

export function renderCancelledCard(pickup: Pickup): string {
  return [
    '## Pickup Cancelled',
    '',
    `**Start was:** ${discordShortTime(pickup.startAt)}`,
    '',
    'This pickup was cancelled and is no longer collecting signups.',
  ].join('\n');
}

export function renderReplacementNotice(
  newUserId: string,
  oldUserId: string,
  role: Role,
): string {
  return `Roster updated: <@${newUserId}> replaces <@${oldUserId}> at ${ROLE_LABELS[role]}.`;
}

/** "Order Solo — @player", used to label slots in select menus. */
export function slotLabel(slot: RosterSlot, format: Pickup['format']): string {
  const teamPart = format === 'pickup_vs_pickup' ? `${TEAM_LABELS[slot.team]} ` : '';
  return `${teamPart}${ROLE_LABELS[slot.role]}`;
}
