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

### `eligibility_role_ids`

Zero or more Discord roles snapshotted for one pickup. A member is eligible if they currently hold ANY one of these roles (OR semantics) — a pickup restricted to both "Verified" and "Trusted" does not require both. A reaction from a member who holds none of the configured roles is rejected at signup time — no `signups` row is written for it. A signup written while the member was eligible is not deleted if they later lose every configured role, but only current guild members who still hold at least one of them may be generated, shuffled, seated as replacements, or published. An empty list keeps the original unrestricted behavior.

### `pickup_space_id`

The Pickup Space (§4) this pickup belongs to. Nullable only for a pickup that predates the introduction of Pickup Spaces in a guild whose legacy configuration was never completed, so there was nothing to assign it to.

### `origin_channel_id`, `signup_channel_id`, `roster_channel_id`, `review_channel_id`, `signup_ping_role_id`

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

### `ready_notified_at`

Set once, the first time this pickup's working roster becomes complete (see
§3's Working Roster section) — the moment staff's control card is frozen and
replaced by the review card. Drives a one-time DM to the pickup's creator;
never cleared, so a roster that later goes incomplete (a withdrawal) and is
refilled does not notify the creator a second time. Null until then.

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

Represents one role assignment on a pickup's roster.

## Working roster

Roster slot rows are not written only once a pickup becomes fully
roster-ready — while a pickup is `open`, Lucid persists the best current
PARTIAL roster the signup pool supports, recalculating it after every signup
change. A team+role combination with no row for it is simply an open seat;
the `UNIQUE(pickup_id, team, role)` constraint means at most one row can ever
claim a given seat. Once the working roster is complete, generation freezes
exactly as it always has — no further recalculation touches it until Shuffle
or an Edit Roster action explicitly changes it.

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

### `staff_assigned`

True when staff placed this player here directly — either by hand while the
roster is still partial (Seat Player, see product-spec.md), or later via an
Edit Roster override or a post-publish Replace Player. Such a slot is pinned: every later
automatic recalculation (while the pickup is still `open`) works around it
rather than reassigning or removing it, and it is exempt from the
withdrawn-signup check that would otherwise flag an occupant with no matching
signup for their slot's role.

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

### `default_eligibility_role_ids`

Zero or more default eligibility roles seeded onto a new pickup's own `eligibility_role_ids` when it's created in this space (OR semantics — see §1). Fully overridable/clearable per pickup in the creation wizard.

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

A player may only be assigned to a role they selected during signup, or to any standard role when they selected Fill. Explicit role signups are preferred over Fill-only signups. When the pickup has `eligibility_role_ids`, the player must also currently hold at least one of those Discord roles.

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

# 12. Pickup Projection Update

Audit and delivery are separate concerns (issue #35). A pickup's `pickup_events` history (§ above at the domain level; see the repository doc comment) proves a semantic mutation happened; `pickup_projection_updates` proves — or honestly leaves unresolved — whether Lucid has since confirmed some Discord message actually shows it. The database transition is the source of truth the instant its transaction commits; this table only tracks whether the corresponding Discord edit/send has landed.

## Fields

### `id`

Unique projection-update identifier.

### `pickup_id`

The pickup this delivery attempt belongs to. Rows are deleted along with their pickup (`ON DELETE CASCADE`).

### `pickup_version`

The pickup's own `version` at the moment this attempt was recorded, captured in the same `INSERT` statement — mirrors `pickup_events.pickup_version`'s own idiom, so a concurrent bump can never land in the gap between "this is the version being projected" and the row describing it.

### `surface`

Which persisted message this attempt targets: `signup`, `review`, or `roster`.

### `message_id`

The Discord message this attempt edited, or `null` for the one case where none exists yet — the very first publish send.

### `status`

- `pending` — not yet confirmed applied; either never attempted, or a confirmed Discord rejection safe to simply retry later.
- `applied` — confirmed the edit/send landed.
- `uncertain` — Discord's response was ambiguous (a timeout, a dropped connection); whether the edit actually landed is genuinely unknown, and is never treated as a confirmed failure (which could duplicate an already-landed send on retry) or a confirmed success.

Only the LATEST row per `(pickup_id, surface)` is ever considered when checking for something unresolved — once a newer attempt for a surface exists, an older uncertain/pending one is simply superseded history, not independently retried.

### `attempted_at`, `applied_at`, `error_context`

When the attempt was made, when it was confirmed applied (if it was), and a short machine-readable note about the failure otherwise (e.g. `discord-error-10008`, or `transport-uncertain: <message>`).

## Recovery behavior

- Every roster-mutation commit site records a `pending` row (see `src/discord/projection.ts`'s `projectSurface`) immediately before attempting the corresponding Discord edit/send, and resolves it to `applied`, `pending`, or `uncertain` once that call settles. A Discord failure never rolls back the database mutation it was projecting — the mutation already committed and stands regardless (replacing an earlier compensating-rollback pattern on Publish that was unsafe under transport uncertainty).
- Startup reconciliation (`reconcileOnStartup`, § above) and the guard before every version-claiming roster mutation (`resolveUnresolvedProjections`) both idempotently retry an unresolved `roster` surface attempt against current state. A mutation that would land on top of a still-unresolved `roster` delivery for the pickup's current version is refused rather than allowed to compound it.
- `review` surface attempts are tracked the same way but never block a new mutation: every write to that surface is an edit-in-place against an already-known message ID, and `refreshReviewCard`'s own ticket ordering already prevents a stale redraw from clobbering a newer one, so there is no genuine duplicate-post or stale-overwrite risk left for a fresh mutation to make unsafe.

# 13. Pickup Notification

Issue #36's durable substrate for one-shot, player-facing coordination messages: the T-15 roster reminder, the organizer availability alert, and the contextual replacement notice.

Deliberately separate from both neighbours above. `pickup_events` proves a mutation happened; `pickup_projection_updates` tracks whether an existing Discord message reflects an already-committed mutation; `pickup_notifications` tracks whether a one-shot, time- or event-triggered message has been sent at all.

## Fields

### `id`, `pickup_id`

Unique identifier, and the pickup this notification belongs to. Rows are deleted along with their pickup (`ON DELETE CASCADE`).

### `kind`

`roster_reminder`, `availability_alert`, or `replacement_notice`.

### `dedupe_key`

Deterministic per-notification identity, and the only source of truth for "has this already been scheduled":

- `roster_reminder:<pickupId>`
- `availability_alert:<pickupId>:<slotId>`
- `replacement_notice:<pickupId>:<slotId>:<pickupVersion>`

Scheduling goes through `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING`, so re-running the same scheduling call after a crash — or a lifecycle transition evaluated more than once — can never produce a second row for the same thing. The entity identity is decoded back out of this key at delivery time rather than stored in extra columns.

### `channel_id`, `due_at`

Where the message goes, and when it becomes eligible (epoch milliseconds, unlike `pickups.start_at`'s Discord-timestamp seconds). Routing is snapshotted per pickup, so a notification can never be delivered into another Pickup Space's channel.

### `payload_snapshot`

What the process was about to send, frozen at the moment of the atomic claim. Recipients and content are otherwise never cached at scheduling time — they are resolved fresh from live pickup/roster state on every delivery attempt, so a reminder scheduled hours earlier still reflects a replacement made since. This column exists only so a delivery left `uncertain` has a durable record for human review, never so it can be replayed automatically.

### `status`

- `pending` — not yet due, or due but unclaimed.
- `attempted` — claimed; a send is in flight. A row should not observably sit here between worker ticks.
- `sent` — confirmed delivered.
- `skipped` — resolved at delivery time that sending is no longer appropriate, with `skipped_reason` recording which rule fired (`too_late`, `resolved_availability`, `published_after_due`, `pickup_cancelled`, …).
- `uncertain` — terminal; the send's outcome is genuinely unknown. Never auto-retried, for the same reason `pickup_projection_updates` never retries its own `uncertain` rows: retrying could duplicate a message that already went out.

## Delivery behavior

- A background worker (`src/discord/notifications.ts`, started once per process from the ready handler) polls for due rows. Scheduling is durable in SQLite rather than held in an in-memory `setTimeout`, so a restart loses nothing.
- Each delivery resolves content from current state, then atomically claims the row (`pending → attempted`, compare-and-swap) immediately before sending. A tick that loses that race has mutated nothing.
- A confirmed Discord rejection releases the row back to `pending` for a later tick; retries are bounded by the resolver itself rather than an attempt counter — a roster reminder stops resolving as deliverable once its pickup has started, so a permanently broken channel ends as a durable `skipped` row instead of retrying forever.
- At startup, any row still `attempted` cannot be an in-flight delivery from this process, so it is reconciled into `uncertain` and reported for review rather than silently stranded.
- Mentions are always explicit allow-lists (`allowedMentions: { parse: [], users, roles }`), so only the intended recipients are ever pinged.

# 14. Replacement-Needed Seats

A published player who reports they can't play (issue #36's Can't Play control) is **not** removed from the roster. `roster_slots.replacement_needed` flags the seat and `replacement_requested_at` records when, leaving the occupant in place so staff keep full roster context — and so nobody reads a silently-empty slot as "nobody was ever here".

- `markReplacementNeeded(slotId, expectedUserId)` is an atomic compare-and-swap: it only flags a seat that still holds exactly that player and is not already flagged. A repeated Can't Play is therefore a true no-op — no second audit event, no duplicate organizer alert — and a seat whose occupant changed underneath the interaction is refused rather than flagged for the wrong player.
- Seating a new occupant clears the flag: a replacement IS the resolution of a seat that needed one. A swap instead carries each player's own flag with them, since a player who can't play still can't play in a different seat.
- `pickup_spaces.organizer_ping_role_id` (snapshotted onto each pickup like the rest of a space's routing) is an optional staff-facing role pinged alongside the pickup's creator on the alert. It is distinct from `signup_ping_role_id`, which is player-facing.
