# Lucid Data Model

Lucid requires a small persistent data model centered around pickups, signups, and roster assignments.

# 1. Pickup

Represents one scheduled pickup event.

## Fields

### `id`

Unique Lucid pickup identifier.

### `guild_id`

Discord server containing the pickup.

### `created_by`

Discord user ID of the coordinator who created the pickup.

### `format`

Pickup format.

Values:

- `pickup_vs_pickup`
- `pickup_vs_premade`

### `start_at`

Absolute event timestamp.

Natural-language time input is parsed using `America/New_York` before being stored.

### `role_limit`

Maximum number of roles each player may select.

Expected values:

- `1`
- `2`

### `note`

Optional coordinator-provided event note.

### `eligibility_role_id`

Optional Discord role snapshotted for one pickup. A reaction from a member who does not currently hold this role is rejected at signup time — no `signups` row is written for it. A signup written while the member was eligible is not deleted if they later lose the role, but only current guild members who still hold this role may be generated, shuffled, seated as replacements, or published. A null value keeps the original unrestricted behavior.

### `premade_name`

Optional opponent name for Pickup vs Premade events.

### `status`

Current pickup state.

Values:

- `open`
- `roster_ready`
- `published`
- `cancelled`
- `finished`

A pickup moves to `cancelled` from `open` or `roster_ready` via `/pickup cancel`
or the staff card's Cancel button — never from `published`; see §10.

A pickup moves to `finished` from `published` only, via the Finish button on
the published roster post — the staff-only counterpart to Cancel for after
the roster has already gone out; see §9. Both `cancelled` and `finished` are
terminal: neither ever transitions again.

### `signup_message_id`

Discord message ID of the public signup post.

### `review_message_id`

Discord message ID of the staff roster review card.

### `roster_message_id`

Discord message ID of the published public roster.

### `created_at`

Pickup creation timestamp.

### `updated_at`

Most recent pickup update timestamp.

# 2. Signup

Represents a player's role selection for a specific pickup.

A player may have multiple signup rows when the pickup allows multiple roles.

## Fields

### `id`

Unique signup identifier.

### `pickup_id`

Associated pickup.

### `user_id`

Discord user ID.

### `role`

Selected Conquest role.

Values:

- `solo`
- `jungle`
- `mid`
- `support`
- `carry`

### `created_at`

Timestamp when the signup was recorded.

# 3. Roster Slot

Represents one role assignment in the current roster.

## Fields

### `id`

Unique roster slot identifier.

### `pickup_id`

Associated pickup.

### `team`

Assigned side.

Pickup vs Pickup values:

- `order`
- `chaos`

Pickup vs Premade value:

- `pickup`

### `role`

Assigned Conquest role.

Values:

- `solo`
- `jungle`
- `mid`
- `support`
- `carry`

### `user_id`

Discord user currently assigned to the slot.

### `created_at`

Initial assignment timestamp.

### `updated_at`

Most recent assignment change.

# 4. Pickup Configuration

Server-specific Lucid settings should be stored independently from individual pickups.

## Fields

### `guild_id`

Discord server ID.

### `signup_channel_id`

Channel where pickup signup posts are created.

### `roster_channel_id`

Channel where finalized rosters are published.

### `review_channel_id`

Private channel where roster-ready review cards are posted.

### `ping_role_id`

Role mentioned when a new pickup opens.

### `authorized_role_ids`

Discord role IDs allowed to create and manage pickups.

### `solo_emoji_id`

Custom emoji ID for `S2_Role_Solo`.

### `jungle_emoji_id`

Custom emoji ID for `S2_Role_Jungle`.

### `mid_emoji_id`

Custom emoji ID for `S2_Role_Mid`.

### `support_emoji_id`

Custom emoji ID for `S2_Role_Support`.

### `carry_emoji_id`

Custom emoji ID for `S2_Role_Carry`.

# 5. Relationships

## Pickup → Signups

One pickup may contain many signup records.

Each signup belongs to exactly one pickup.

## Pickup → Roster Slots

One pickup may contain:

- 10 roster slots for Pickup vs Pickup
- 5 roster slots for Pickup vs Premade

Each roster slot belongs to exactly one pickup.

## User → Signup

A Discord user may sign up for multiple pickups.

The allowed number of roles within one pickup is determined by that pickup's `role_limit`.

# 6. Roster Constraints

A valid roster must satisfy the following rules:

### Unique Player Assignment

A Discord user may occupy no more than one roster slot within a pickup.

### Role Eligibility

A player may only be assigned to a role they selected during signup, or to any standard role when they selected Fill. Explicit role signups are preferred over Fill-only signups. When the pickup has an `eligibility_role_id`, the player must also currently hold that Discord role.

### Pickup vs Pickup

The roster must contain exactly:

- 2 Solo
- 2 Jungle
- 2 Mid
- 2 Support
- 2 Carry

Distributed across Order and Chaos.

Each team contains exactly one player per role.

### Pickup vs Premade

The pickup roster must contain exactly:

- 1 Solo
- 1 Jungle
- 1 Mid
- 1 Support
- 1 Carry

# 7. Reaction Tracking

Lucid seeds the configured role reactions immediately after creating the public signup message.

Role reactions are tracked using Discord custom emoji IDs rather than emoji names.

Valid signup reactions correspond to:

- `S2_Role_Solo`
- `S2_Role_Jungle`
- `S2_Role_Mid`
- `S2_Role_Support`
- `S2_Role_Carry`
- optional `Fill`

Fill counts against `role_limit`, can satisfy any standard roster slot, and never becomes a roster role itself.

Lucid records reaction additions and removals against the associated pickup and user.

# 8. Player Replacement

Replacing a player updates the existing roster slot.

The following values remain unchanged:

- `pickup_id`
- `team`
- `role`

Only:

`user_id`

is replaced with the incoming Discord user.

The roster message is then regenerated from the current roster-slot records and edited in place.

# 9. Finish

Authorized staff can explicitly close a `published` pickup via the Finish
button on the published roster post — the post-publish counterpart to
Cancellation (§10).

The transition from `published` to `finished` is a single conditional write
keyed on the pickup's current status, same guard as Cancellation.

On finishing:

- The published roster post gains a closing note and its buttons (including
  Replace Player) are redrawn disabled rather than removed.
- The staff review card gains the same closing note and stays disabled.

`finished` is terminal — it never transitions again, and Replace Player
refuses a `finished` pickup once it does.

# 10. Cancellation

Authorized staff can close a pickup before it publishes, via `/pickup cancel`
or the Cancel button on the staff review card.

Only `open` and `roster_ready` pickups are offered for cancellation — a
`published` pickup never appears, so `/pickup cancel` on a guild with only a
published pickup just reports there is nothing open to cancel, not a redirect.
Staff need **Replace Player** (§8) instead, since a public roster is already
out and people are organizing around it, but reaching for it is on staff, not
something Lucid volunteers there. The one exception: if a pickup gets
published in the narrow window between being offered and being confirmed, the
confirmation is refused with a message naming Replace Player explicitly — a
race-window safeguard, not the everyday response.

The transition from `open`/`roster_ready` to `cancelled` is a single
conditional write keyed on the pickup's current status, so two coordinators
confirming at the same instant cannot both act on it.

On cancellation:

- The public signup post is rewritten to a struck-through, closed form.
  Existing reactions on it are left alone; the reaction handlers already
  ignore any pickup that is `cancelled`, `published`, or `finished` (§7) — `roster_ready`
  pickups still accept reaction changes, right up until cancellation flips
  the status.
- The staff review card keeps its buttons, redrawn disabled rather than
  removed, so it reads as "already handled" rather than as broken.

# 11. Message Persistence

Lucid stores Discord message IDs so interactive workflows can survive process restarts and future bot deployments.

Relevant IDs include:

- Public signup message
- Staff review message
- Published roster message

Persistent component handlers should resolve the pickup using stored identifiers rather than relying only on in-memory state.
