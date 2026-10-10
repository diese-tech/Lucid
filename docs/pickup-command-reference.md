# Pickup command reference

This reference follows the registered commands and runtime guards. `/help` is private and available to any guild member. No command runs in DMs.

## Permissions

- **Pickup Staff:** a current member with a currently authorized role in the pickup's own Pickup Space, or Discord Administrator. Authorization is checked on every private action and before confirmation. Staff-channel visibility does not grant authority; access in one space does not grant access in another.
- **Manage Server:** Discord's native Manage Server (`ManageGuild`) permission, required for `/pickup config` and every `/pickup space` command. Administrator also satisfies it. Pickup Staff alone does not grant configuration access.
- **Player:** a currently seated player may use Can't Play on the current public roster. It keeps their seat, flags replacement-needed state and schedules an organizer alert.

## Commands

| Syntax | Who / where | Behavior |
| --- | --- | --- |
| `/help` | Any guild member | Private quickstart, permissions, confirmation and recovery guidance. |
| `/pickup create` | Pickup Staff; configured origin channel | Private wizard: format, role limit, optional eligibility roles, start time, optional note/premade name, preview, post. Confirm overlaps explicitly when offered. |
| `/pickup manage` | Pickup Staff; any guild channel | Paginated private picker containing only active pickups the member can manage; reopens saved work and recovery. |
| `/pickup cancel` | Pickup Staff; any guild channel | Private picker restricted to open/roster-ready pickups, then cancellation preview. Published pickups must be finished instead. |
| `/pickup config [timezone:<IANA-zone>] [bind_emoji:true]` | Manage Server | Inspect/update guild timezone and bind five role emoji, optionally Fill. Channels and staff roles belong to Pickup Spaces. |
| `/pickup space create name:<name>` | Manage Server | Create and configure an independently routed/staffed space. |
| `/pickup space edit space:<space>` | Manage Server | Select by autocomplete; edit channels, staff roles, ping roles and default eligibility. Individual settings save immediately. Existing pickups retain snapshotted routing. |
| `/pickup space list` | Manage Server | List this guild's configured spaces. |
| `/pickup space delete space:<space>` | Manage Server | Preview then confirm deletion; refuses a space with pickup history. |

## Management workspace

Press **Manage** on the current staff card or run `/pickup manage`. Healthy published cards stay compact; the private workspace contains the full roster and valid controls.

- **Collecting signups:** filled/open seats, unseated signups, Seat Player, Refresh, Cancel. Seating permits an explicitly warned off-role assignment to an eligible signed-up member.
- **Roster ready:** Shuffle, Swap Players (same role across Order/Chaos), Change Role (any two assignments), Replace, Publish, Cancel. Pickup vs Premade has one rostered team and no cross-team Swap Players.
- **Published:** Swap any two assignments, Replace, Finish. Replacement offers current eligible unseated signups and a server-member selector for emergency substitutes.
- **Publication failed:** correct the retained draft or fix destination access, then Retry Publication.
- **Publication pending/uncertain or message projection unresolved:** Repair Delivery and navigation; further changes cannot commit until delivery is reconciled.
- **Finished/cancelled:** status and recorded links are read-only. Previously opened editors cannot reopen the lifecycle.

Every staff roster change, Publish, Cancel and Finish shows an exact preview and requires **Confirm**. Selecting a player/assignment does not save a mutation. Shuffle saves the displayed assignments instead of generating another roster at confirmation.

Back or Close discards the proposal. Proposals expire after ten minutes; restart discards unsaved private state. Reopen from the persistent card or command: canonical records, seats and message IDs remain stored. Older private controls refuse changes and explain how to reopen. Existing persistent entry identifiers retain canonical-message and version checks.

Selection values are stable user/slot IDs. Off-role overrides do not bypass current membership, non-bot or configured eligibility checks. Draft replacement remains in the selected role/Fill signup pool; emergency non-signup replacement is available only after publication. No Unseat operation is added.

## Delivery and errors

- **Retry Publication** follows a confirmed failure. Publication succeeds only after Discord confirms a message ID and Lucid links it durably.
- **Repair Delivery** reconciles the snapshotted destination before any resend. Unknown delivery is not confirmed absence.
- **Change saved; Discord refresh pending:** the database mutation succeeded. Repair delivery or restore access for reconciliation; do not repeat the roster change.
- **No changes were made:** the proposal did not commit. Reopen after correcting the stated version, permission, eligibility or destination problem.
- Configuration edits never silently reroute existing pickups. Diagnose the destination shown in that pickup's workspace.

## Discord copy/paste guide

**Lucid Pickup Guide**

**Permissions**
Pickup Staff = this Pickup Space's configured staff roles or Administrator.
Manage Server = Discord Manage Server permission; required for configuration.

**Players**
`/help` — Read the private quickstart — Anyone
React to the signup post for roles, including optional Fill.
**Can't Play** — Flag your seat for replacement — Seated player

**Staff**
`/pickup create` — Preview and post a pickup — Pickup Staff, origin channel
`/pickup manage` — Reopen saved pickup work privately — Pickup Staff
`/pickup cancel` — Preview cancellation of an unpublished pickup — Pickup Staff
**Manage** — Open the full roster and current controls — Pickup Staff
**Confirm** — Apply exactly the previewed change — Pickup Staff
**Back / Close** — Discard the pending change — Pickup Staff
**Finish** — Permanently close a published pickup — Pickup Staff

**Setup**
`/pickup config timezone:<zone>` — Set the guild timezone — Manage Server
`/pickup config bind_emoji:true` — Bind reactions and optional Fill — Manage Server
`/pickup space create name:<name>` — Create a Pickup Space — Manage Server
`/pickup space edit space:<space>` — Configure channels, roles and eligibility — Manage Server
`/pickup space list` — List configured spaces — Manage Server
`/pickup space delete space:<space>` — Confirm deletion of an unused space — Manage Server

**Recovery**
Previews expire after ten minutes or restart; reopen Manage.
**Retry Publication** — Retry a confirmed failure.
**Repair Delivery** — Reconcile an uncertain send before retrying.
“Change saved, refresh pending” — Repair delivery; do not repeat the change.
