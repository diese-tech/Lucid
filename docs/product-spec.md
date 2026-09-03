# Lucid Product Specification

## Purpose

Lucid coordinates scheduled pickup scrims inside Discord.

The bot handles the operational flow between a coordinator deciding to host a pickup and the final roster being published to players.

The primary workflow is:

`Create pickup → collect role signups → roster ready → staff review → publish roster`

Published rosters also support direct player replacement when roster changes are needed afterward.

# 1. Pickup Creation

Authorized staff begin with:

`/pickup create`

Lucid opens an ephemeral setup flow for the coordinator.

The coordinator provides:

- Pickup format
- Start time
- Signup role limit
- Optional note
- Optional premade team name when applicable

Supported formats:

- Pickup vs Pickup
- Pickup vs Premade

Before anything is posted publicly, Lucid shows an ephemeral preview of the pickup.

The coordinator may optionally select one Discord eligibility role. The preview names it without pinging it. If that coordinator already has an active pickup at the exact same time, Lucid shows the existing pickup and asks for explicit confirmation instead of blocking the second post.

The coordinator can:

- Post Pickup
- Edit
- Cancel

# 2. Start Time

Start time accepts natural-language input.

Examples:

- `tonight at 8`
- `tomorrow at 7pm`
- `Friday at 9:30`
- `8/29 at 6pm`

Lucid interprets this input relative to:

`America/New_York`

The resulting time is stored as an absolute timestamp.

Discord timestamp syntax is used when displaying the event publicly so users automatically see the time in their own local timezone.

# 3. Public Signup Post

After confirmation, Lucid posts a short plain-text signup message in the configured signup channel.

The public post should preserve the familiar style already used in the Dream Walkers server.

For Pickup vs Pickup:

**Pickup games at <t:TIMESTAMP:t> <t:TIMESTAMP:R>**

React with the role(s) you want to play.  
You may select **{role_limit} role(s)**.

For Pickup vs Premade:

**Pickup games vs [Premade Name] at <t:TIMESTAMP:t> <t:TIMESTAMP:R>**

React with the role(s) you want to play.  
You may select **{role_limit} role(s)**.

Lucid then immediately adds the five required SMITE 2 role reactions and optional Fill to the same message in fixed order:

1. `S2_Role_Solo`
2. `S2_Role_Jungle`
3. `S2_Role_Mid`
4. `S2_Role_Support`
5. `S2_Role_Carry`
6. Optional `Fill`

Players sign up by adding their reactions to the icons Lucid has already placed.

Lucid tracks reactions by custom emoji ID.

Fill counts toward the normal per-player role limit and can satisfy any standard role during matching. Explicit role signups are preferred over Fill-only signups.

# 4. Concurrent Pickups

Every pickup is tracked independently.

Players may interact with multiple active pickup posts without signups being mixed between events.

Each pickup maintains its own:

- Event information
- Signup pool
- Roster draft
- Published roster

# 5. Signup Tracking

Lucid tracks:

- Pickup
- Discord user
- Selected role or roles

Each pickup defines how many roles an individual player may select.

Adding one of the configured role reactions adds that role to the player's signup.

Removing the reaction removes that role from the player's signup.

Lucid ignores:

- Its own seeded reactions as player signups
- Reactions using unconfigured emoji
- Reactions that do not belong to the pickup's configured SMITE 2 role icons

When an eligibility role is set, Lucid checks it at the moment of the reaction: a member who does not currently hold the role never gets a signup row for that reaction. Lucid removes the reaction where it has permission to and sends the player a DM explaining why. A member who already signed up and later loses the role keeps their stored signup, but every roster operation re-checks current Discord membership and ignores them until they hold the role again — this applies to both pickup formats, generation, Shuffle, routine replacement, publication, and post-publication replacement. If the configured eligibility role itself is deleted or unreadable, Lucid fails closed (nobody is treated as eligible) and shows staff an explicit error on the control card rather than silently lifting the restriction.

Lucid continuously evaluates whether the current signup pool contains enough valid role coverage to construct the required roster, and shows staff live readiness telemetry — unique eligible players, per-role coverage, and Fill availability — on the same control card. That telemetry is diagnostic only; it never decides roster-ready itself.

# 6. Roster Ready

A pickup becomes roster-ready when enough unique players and valid role assignments exist to fill every required roster slot.

For Pickup vs Pickup, Lucid requires enough coverage for:

- 2 Solo
- 2 Jungle
- 2 Mid
- 2 Support
- 2 Carry

For Pickup vs Premade, Lucid requires enough coverage for:

- 1 Solo
- 1 Jungle
- 1 Mid
- 1 Support
- 1 Carry

Once roster-ready, Lucid generates a valid draft and posts a review card in the configured staff channel.

# 7. Roster Generation

Lucid automatically creates an initial roster draft.

Roster generation must:

- Fill every required role
- Assign only players who signed up for that role
- Use each player no more than once
- Produce complete teams

For Pickup vs Pickup, the draft contains:

## Order

- Solo
- Jungle
- Mid
- Support
- Carry

## Chaos

- Solo
- Jungle
- Mid
- Support
- Carry

For Pickup vs Premade, the draft contains:

## Pickup Team

- Solo
- Jungle
- Mid
- Support
- Carry

## Opponent

The configured premade team information.

# 8. Staff Review

The generated roster is posted privately in the configured staff review channel.

Authorized staff can:

- Shuffle the roster
- Reorder assignments
- Swap players
- Manually edit roster slots
- Publish the roster

The staff review card represents the current working roster until publication.

# 9. Roster Publication

When authorized staff select Publish, Lucid posts the finalized roster in the configured public roster channel.

The published roster includes:

- Pickup time
- Team names
- Role assignments
- Discord mentions for selected players

For Pickup vs Pickup:

## Order

- Solo
- Jungle
- Mid
- Support
- Carry

## Chaos

- Solo
- Jungle
- Mid
- Support
- Carry

For Pickup vs Premade:

## Pickup Team

- Solo
- Jungle
- Mid
- Support
- Carry

## Premade Team

The supplied premade team name or information.

# 10. Player Replacement

Published rosters support player replacement.

The published roster contains a:

`Replace Player`

button.

Only authorized staff can successfully execute the action.

Replacement flow:

1. Coordinator selects Replace Player.
2. Lucid displays the current roster slots.
3. Coordinator selects the outgoing player or slot.
4. Lucid opens a modal requesting the replacement player's Discord name.
5. Coordinator enters the replacement name.
6. Lucid attempts to resolve the matching server member.
7. If multiple matches exist, Lucid presents the matching candidates rather than guessing.
8. Lucid displays the proposed replacement for confirmation.
9. Coordinator confirms.
10. Lucid edits the original published roster.
11. Lucid posts a short public roster update.

Example:

`Roster updated: @NewPlayer replaces @OldPlayer at Support.`

The replacement inherits the outgoing player's:

- Team
- Role
- Roster slot

# 11. Finish

Authorized staff can explicitly close out a pickup after its roster has been
published:

`Finish`

button, alongside `Replace Player` on the published roster post.

There is always exactly one confirmation step, matching Cancellation (§12) —
finishing turns off further roster changes for good.

Only a `published` pickup can be finished; a pickup that has not yet been
published, or one already finished, is refused with an explanation. Once
finished, **Replace Player** is no longer available.

On confirmation:

- The published roster post gains a closing note (`✅ This pickup is
  finished. Roster changes are closed.`) and its buttons grey out rather than
  disappearing — the same "greyed-out reads as done" principle Cancellation's
  staff card follows.
- The staff review card gains the same closing note and stays disabled.

Finish never happens automatically by elapsed time — like Cancellation, it is
always an explicit staff action; Lucid does not track whether a game actually
started or ended.

# 12. Pickup Cancellation

Authorized staff can close a pickup before it is published:

`/pickup cancel`

with no arguments — Lucid works out what there is to cancel. With exactly one
open pickup, Lucid goes straight to confirmation. With several, it first asks
which one. The same confirmation is also reachable from a Cancel button on the
pickup's staff review card.

There is always exactly one confirmation step, regardless of how the
coordinator got there — cancelling rewrites a message players have already
reacted to and closes signups for good.

Only pickups in `open` or `roster_ready` are offered — a published pickup
never appears as something to cancel, so a coordinator running `/pickup
cancel` when the only pickup has already been published simply gets "There
are no open pickups to cancel." Staff need **Replace Player** (§10) instead,
since pulling a public roster out from under players who are already
organizing around it is not what cancellation should do — but reaching for it
is on staff, not something Lucid points to on the spot.

The one narrow exception: if a pickup is offered for cancellation and then
gets published in the moment before the coordinator confirms, the confirmed
cancel is refused with an explicit message naming Replace Player. This is a
race-window safeguard, not the normal response to trying to cancel an
already-published pickup.

On confirmation:

- The public signup post is rewritten to a struck-through, closed form.
- The staff review card's buttons stay visible but disabled, rather than
  disappearing — a greyed-out control reads as "already done"; a vanished one
  reads as a bug.

# 13. Permissions

Lucid authorizes management actions using configured Discord role IDs.

Initial staff roles may include:

- Admin
- Mods
- Competitive Coordinator

Authorized staff can perform actions such as:

- Creating pickups
- Reviewing rosters
- Editing roster drafts
- Publishing rosters
- Replacing published players
- Finishing published pickups

Authorization is determined through explicit configuration.

# 14. Server Configuration

Lucid requires configuration for:

- Signup channel
- Public roster channel
- Staff review channel
- Public pickup ping role
- Authorized staff roles
- Solo custom emoji ID
- Jungle custom emoji ID
- Mid custom emoji ID
- Support custom emoji ID
- Carry custom emoji ID

Dream Walkers currently uses:

- `S2_Role_Solo`
- `S2_Role_Jungle`
- `S2_Role_Mid`
- `S2_Role_Support`
- `S2_Role_Carry`

Configuration should use Discord IDs rather than names.

# 15. Core Flow

The complete Lucid workflow is:

`/pickup create`

↓

`Ephemeral setup`

↓

`Preview`

↓

`Public signup post`

↓

`Lucid seeds role reactions`

↓

`Role reactions collected`

↓

`Roster-ready condition reached`

↓

`Automatic roster draft`

↓

`Private staff review`

↓

`Shuffle / reorder / edit`

↓

`Publish`

↓

`Public roster`

↓

`Optional player replacement`

↓

`Finish`

`/pickup cancel` is available from `Public signup post` through
`Private staff review` — any point before `Publish` — and ends the workflow by
rewriting the signup post as struck-through and closed, instead of continuing
on to `Publish`.

`Finish` is available any time after `Public roster`, closing the workflow
out explicitly rather than leaving player replacement available indefinitely.
