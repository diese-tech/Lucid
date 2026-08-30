# Lucid Discord UX Flow

This document defines how coordinators and players interact with Lucid inside Discord.

# 1. Create Pickup

A coordinator runs:

`/pickup create`

Lucid responds ephemerally.

## Step 1: Format

Coordinator chooses:

- Pickup vs Pickup
- Pickup vs Premade

If Pickup vs Premade is selected, Lucid also allows the coordinator to provide the premade team name.

## Step 2: Start Time

Coordinator enters a natural-language value.

Examples:

- `tonight at 8`
- `tomorrow 7pm`
- `Friday 9:30pm`
- `8/29 at 6`

Lucid interprets the input using `America/New_York`.

## Step 3: Signup Role Limit

Coordinator chooses:

- 1 role
- Up to 2 roles

## Step 4: Optional Note

Coordinator may provide additional context for the pickup.

# 2. Pickup Preview

Lucid shows an ephemeral preview before anything is posted publicly.

The preview should reflect the actual public message style rather than introducing a separate embed format.

Example:

**Pickup games at <t:TIMESTAMP:t> <t:TIMESTAMP:R>**

React with the role(s) you want to play.  
You may select **2 roles**.

Actions:

- Post Pickup
- Edit
- Cancel

Selecting Edit returns the coordinator to the setup flow.

Selecting Post Pickup creates the public signup message.

# 3. Public Signup Experience

Lucid posts a short plain-text message in the configured signup channel.

## Pickup vs Pickup

**Pickup games at <t:TIMESTAMP:t> <t:TIMESTAMP:R>**

React with the role(s) you want to play.  
You may select **{role_limit} role(s)**.

## Pickup vs Premade

**Pickup games vs [Premade Name] at <t:TIMESTAMP:t> <t:TIMESTAMP:R>**

React with the role(s) you want to play.  
You may select **{role_limit} role(s)**.

Immediately after posting the message, Lucid adds the five configured server role reactions in this order:

1. `S2_Role_Solo`
2. `S2_Role_Jungle`
3. `S2_Role_Mid`
4. `S2_Role_Support`
5. `S2_Role_Carry`

Players use Lucid's existing reactions rather than adding role icons manually.

# 4. Player Signup

Players click the role reactions already added by Lucid.

Lucid records each player's selected roles for that pickup.

If the event allows one role, Lucid maintains one active role selection for that user.

If the event allows two roles, Lucid maintains up to two active role selections.

Removing a reaction removes that role from the player's signup.

Lucid tracks each role reaction using its configured Discord custom emoji ID.

# 5. Roster Ready

Lucid evaluates the signup pool whenever role selections change.

Once every required roster slot can be filled using unique eligible players, Lucid creates the initial roster draft.

Lucid then posts a roster-ready card in the configured staff review channel.

# 6. Staff Review Card

Example:

## Pickup Ready

**Start:** `<Discord timestamp>`

### Order

Solo: @Player  
Jungle: @Player  
Mid: @Player  
Support: @Player  
Carry: @Player

### Chaos

Solo: @Player  
Jungle: @Player  
Mid: @Player  
Support: @Player  
Carry: @Player

Actions:

- Shuffle
- Edit Roster
- Publish

# 7. Shuffle

Selecting Shuffle asks Lucid to generate another valid roster arrangement from the available signup pool.

The updated roster replaces the current staff review draft.

The coordinator remains on the review card afterward.

# 8. Edit Roster

Selecting Edit Roster allows staff to modify current roster assignments.

Supported actions include:

- Swap players
- Change a player's role assignment
- Replace a roster slot with another eligible signup
- Reorder team assignments

Lucid updates the staff review card after each confirmed change.

# 9. Publish Roster

Selecting Publish displays a final confirmation to the coordinator.

Example:

`Publish this roster to #pickup-rosters?`

Actions:

- Publish
- Back

After confirmation, Lucid posts the finalized roster publicly.

# 10. Public Roster

Example:

## Pickup Roster

**Start:** `<Discord timestamp>`

### Order

**Solo:** @Player  
**Jungle:** @Player  
**Mid:** @Player  
**Support:** @Player  
**Carry:** @Player

### Chaos

**Solo:** @Player  
**Jungle:** @Player  
**Mid:** @Player  
**Support:** @Player  
**Carry:** @Player

Selected players are mentioned in the published roster.

The roster includes:

`Replace Player`

# 11. Cancel Pickup

A coordinator runs:

`/pickup cancel`

with no arguments, or presses **Cancel** on the staff review card.

## Step 1: Pick a Pickup (only if more than one is open)

"Open" here means `open` or `roster_ready` — a published pickup is never
listed. If the guild's only pickup has already been published, `/pickup
cancel` replies "There are no open pickups to cancel" and stops; there is
nothing to pick or confirm. If exactly one pickup is open, Lucid skips
straight to Step 2. Otherwise it shows a select menu of open pickups.

## Step 2: Confirm

Lucid always shows exactly one confirmation, regardless of entry point:

`Cancel **Pickup vs Pickup — <time>**?`

`The public signup post will be struck through and signups will close. This cannot be undone.`

Actions:

- Cancel Pickup
- Keep It

## Step 3: Result

On confirmation, Lucid:

1. Rewrites the public signup post with a struck-through title.
2. Redraws the staff review card's buttons disabled, rather than removing them.

One race is still possible: if the pickup gets published in the moment
between Step 1 and confirming Step 2, the confirmation is refused rather than
applied, with a message naming **Replace Player** (§12) — a public roster
cannot be cancelled out from under players who are already organizing around
it. Outside that narrow window, a coordinator never reaches Step 2 for a
published pickup in the first place; see Step 1.

# 12. Replace Player

An authorized coordinator selects:

`Replace Player`

Lucid responds ephemerally.

## Step 1: Select Slot

Lucid displays the current roster slots.

Coordinator selects the player who is being replaced.

Example:

`Chaos Support - @OldPlayer`

## Step 2: Enter Replacement

Lucid opens a modal.

Field:

`Replacement player`

Coordinator types a Discord username or display name.

Example:

`Dreamer123`

## Step 3: Member Resolution

Lucid searches server members for the entered name.

If one clear match exists, Lucid continues.

If multiple plausible matches exist, Lucid displays a short candidate list for the coordinator to choose from.

## Step 4: Confirmation

Lucid displays:

`Replace @OldPlayer with @NewPlayer at Chaos Support?`

Actions:

- Confirm
- Cancel

## Step 5: Update

After confirmation:

1. Lucid updates the roster data.
2. Lucid edits the original public roster message.
3. Lucid posts a short public update.

Example:

`Roster updated: @NewPlayer replaces @OldPlayer at Support.`

The replacement automatically inherits the outgoing player's team and role slot.
