/**
 * Custom ID encoding for buttons, selects and modals.
 *
 * RESTART SAFETY: Lucid keeps no in-memory map of "which message belongs to
 * which pickup". Every interactive component encodes everything its handler
 * needs directly in its custom ID, so a button clicked an hour after a redeploy
 * resolves exactly as well as one clicked a second after rendering.
 *
 * Format: action:pickupId:arg1:arg2
 * Discord caps custom IDs at 100 characters, which is ample for numeric IDs.
 */

export const Action = {
  // Pickup creation wizard
  CreateFormat: 'cf',
  CreateRoleLimit: 'crl',
  CreateEligibilityRole: 'cer',
  CreateOpenDetails: 'cod',
  CreateDetailsModal: 'cdm',
  CreatePost: 'cp',
  CreatePostAnyway: 'cpa',
  CreateEdit: 'ce',
  CreateCancel: 'cc',

  // Guild config panel
  ConfigBindEmoji: 'cfgb',
  ConfigSkipFill: 'cfgsf',

  // Pickup Space admin panel — the numeric ID slot carries the space's own
  // ID rather than a pickup ID, since spaces exist independently of pickups.
  SpaceChannel: 'spc',
  SpaceRole: 'spr',
  SpaceMore: 'spm',
  SpaceBack: 'spb',
  SpaceRename: 'spn',
  SpaceRenameModal: 'spnm',
  SpaceDelete: 'spd',
  SpaceDeleteConfirm: 'spdc',

  // Staff review card
  Shuffle: 'sh',
  EditRoster: 'er',
  Publish: 'pub',
  PublishConfirm: 'pubc',
  PublishBack: 'pubb',

  // Edit roster sub-actions
  EditSwap: 'esw',
  EditChangeRole: 'ecr',
  EditReplaceSlot: 'ers',
  EditPickSlot: 'eps',
  EditPickTarget: 'ept',
  EditBack: 'eb',

  // Cancel
  Cancel: 'can',
  CancelPick: 'canp',
  CancelConfirm: 'canc',

  // Manual seating (working roster, before full feasibility)
  SeatPlayer: 'seat',
  SeatPickSlot: 'seatps',
  SeatPickPlayer: 'seatpp',
  SeatNextPlayerPage: 'seatnp',
  SeatConfirm: 'seatc',

  // Post-publish replacement
  Replace: 'rep',
  ReplacePickSlot: 'reps',
  ReplacePickBench: 'repb',
  ReplaceSearch: 'repse',
  ReplaceSearchModal: 'repsm',
  ReplacePickCandidate: 'repc',
  ReplaceConfirm: 'repcf',

  // Finish (closing out a published roster)
  Finish: 'fin',
  FinishConfirm: 'finc',

  // Player-facing availability on a published roster (issue #36's Can't Play)
  Unavailable: 'una',
  UnavailableConfirm: 'unac',

  // Rebalancing a published roster from the expanded staff card (issue #37)
  PublishedSwap: 'pswp',
  PublishedSwapPickFirst: 'pswpf',
  PublishedSwapConfirm: 'pswpc',
} as const;

export type ActionName = (typeof Action)[keyof typeof Action];

export function encodeId(action: ActionName, pickupId: number, ...args: (string | number)[]): string {
  return [action, pickupId, ...args].join(':');
}

export interface DecodedId {
  action: string;
  pickupId: number;
  args: string[];
}

export function decodeId(customId: string): DecodedId | null {
  const parts = customId.split(':');
  if (parts.length < 2) return null;

  const action = parts[0]!;
  const pickupId = Number(parts[1]);
  if (!Number.isInteger(pickupId)) return null;

  return { action, pickupId, args: parts.slice(2) };
}

/** Session-scoped IDs for the creation wizard, which has no pickup row yet. */
export function encodeDraftId(action: ActionName, draftId: string, ...args: (string | number)[]): string {
  return [action, draftId, ...args].join(':');
}
