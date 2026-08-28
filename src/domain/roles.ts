/**
 * The five SMITE 2 Conquest roles, and the fixed order Lucid presents them in.
 *
 * This order is not cosmetic. It is the order Lucid seeds reactions onto the
 * signup post, the order roles are listed on every roster, and the order the
 * config command binds custom emoji in. Changing it changes all three at once.
 */

export const ROLES = ['solo', 'jungle', 'mid', 'support', 'carry'] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  solo: 'Solo',
  jungle: 'Jungle',
  mid: 'Mid',
  support: 'Support',
  carry: 'Carry',
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Team sides. `pickup` is the lone team in a Pickup vs Premade event. */
export const TEAMS = ['order', 'chaos', 'pickup'] as const;
export type Team = (typeof TEAMS)[number];

export const TEAM_LABELS: Record<Team, string> = {
  order: 'Order',
  chaos: 'Chaos',
  pickup: 'Pickup Team',
};

export type PickupFormat = 'pickup_vs_pickup' | 'pickup_vs_premade';

/**
 * Teams that actually hold roster slots for a given format.
 *
 * Note that Pickup vs Premade returns only `pickup`. The premade opponent is
 * never stored as roster slots — it is just the `premade_name` string on the
 * pickup. Do not add a phantom "opponent" team here to make rendering
 * symmetrical; the renderer handles that difference on purpose.
 */
export function teamsForFormat(format: PickupFormat): Team[] {
  return format === 'pickup_vs_pickup' ? ['order', 'chaos'] : ['pickup'];
}

/** How many players each role needs across the whole event. */
export function capacityForFormat(format: PickupFormat): number {
  return format === 'pickup_vs_pickup' ? 2 : 1;
}
