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

### `pickup_space_id`

The Pickup Space (§4) this pickup belongs to. Nullable only for a pickup that predates the introduction of Pickup Spaces in a guild whose legacy configuration was never completed, so there was nothing to assign it to.

### `origin_channel_id`, `signup_channel_id`, `roster_channel_id`, `review_channel_id`, `signup_ping_role_id`, `organizer_ping_role_id`

A snapshot of the owning Pickup Space's routing and ping role, taken at creation time. Routing and policy chosen when a pickup is created must not silently move if the space is edited afterward — every message this pickup posts or edits uses these snapshotted values, not the space's current configuration.

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

# 4. Pickup Space

A guild can run several independently configured pickup lanes — for example a
public lane and a separate restricted lower-skill lane — each with its own
channels, staff, and optional ping/eligibility roles. Each is a Pickup Space.
A guild with only one lane still has exactly one space; there is no
guild-wide fallback once spaces exist.

Authorization for every state-changing action (creating a pickup, all roster
mutations, Cancel, Finish, Replace Player) is checked against the current
`authorized_role_ids` of the pickup's own space, not the guild as a whole —
removing someone from a space's staff role revokes their authority over that
space's pickups immediately, and has no effect on any other space.

## Fields

### `id`

Unique Pickup Space identifier.

### `guild_id`

Discord server ID. Kept for ownership/safety even though Lucid currently
serves one guild per deployment.

### `name`

Admin-chosen label, unique within the guild (e.g. `Public Pickups`).

### `origin_channel_id`

The channel where `/pickup create` must be run to resolve to this space. A
guild with more than one space requires an unambiguous origin channel per
space; `/pickup create` run outside any configured origin channel is refused
rather than falling back to a default.

### `signup_channel_id`

Channel where this space's pickup signup posts are created.

### `roster_channel_id`

Channel where this space's finalized rosters are published.

### `review_channel_id`

Private channel where this space's roster-ready review cards are posted.

### `signup_ping_role_id`

Optional role mentioned when a new pickup opens in this space.

### `organizer_ping_role_id`

Optional staff/organizer role that may be mentioned for readiness or
exception alerts, separate from the pickup's human creator.

### `default_eligibility_role_id`

Optional default eligibility role for pickups created in this space.

### `authorized_role_ids`

Discord role IDs allowed to create and manage pickups in this space.

### `created_at`

Space creation timestamp.

### `updated_at`

Most recent configuration change.

## Migration from the single guild-wide configuration

Before Pickup Spaces existed, each guild had exactly one configuration row.
On upgrade, a guild with a complete legacy configuration gets exactly one
space, named `Public Pickups`, carrying over its channels, ping role, and
authorized staff roles; its old review channel becomes the initial origin
channel. A guild whose legacy configuration was never completed gets no
space — there was nothing usable to copy — and an admin creates one fresh
with `/pickup space create`. Existing pickups are backfilled onto their
guild's new default space with the same snapshot described in §1.

## What stays guild-scoped

Timezone (used to parse natural-language start times) and the six role
emoji IDs stay on the one guild-wide configuration row rather than moving
into spaces — every space in a guild reads the same values, set via
`/pickup config`.

### `guild_id`

Discord server ID.

### `timezone`

IANA timezone used to interpret natural-language start times.

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

### `fill_emoji_id`

Optional custom emoji ID for the Fill signup reaction.

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
