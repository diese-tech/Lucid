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
  ConfigChannel: 'cfgc',
  ConfigRole: 'cfgr',
  ConfigBindEmoji: 'cfgb',
  ConfigSkipFill: 'cfgsf',

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

  // Post-publish replacement
  Replace: 'rep',
  ReplacePickSlot: 'reps',
  ReplacePickBench: 'repb',
  ReplaceSearch: 'repse',
  ReplaceSearchModal: 'repsm',
  ReplacePickCandidate: 'repc',
  ReplaceConfirm: 'repcf',
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
