# Lucid

Lucid is a lightweight Discord bot built for coordinating pickup scrims in the Dream Walkers community.

It helps staff create scheduled pickup events, collect player signups by SMITE 2 Conquest role, generate valid roster drafts, review and adjust those rosters privately, and publish the final teams publicly.

The core flow is:

`Create pickup → collect signups → generate roster → staff review → publish`

If a player drops after publication, authorized staff can replace that player directly from the published roster. Lucid updates the original roster and posts a short public notice showing the change.

## Core Features

- `/pickup create` event creation flow
- Natural-language start time input
- Discord-localized timestamps
- Pickup vs Pickup format
- Pickup vs Premade format
- Role-based player signups using server custom role icons
- Independent tracking for concurrent pickups
- Automatic roster-ready detection
- Automatic valid roster generation
- Private staff roster review
- Shuffle, reorder, swap, and edit controls
- Public roster publication
- Post-publication player replacement
- Configurable Discord permissions and channels

## Supported Roles

Lucid uses the five SMITE 2 Conquest roles:

- Solo
- Jungle
- Mid
- Support
- Carry

Dream Walkers currently uses these custom server icons:

- `S2_Role_Solo`
- `S2_Role_Jungle`
- `S2_Role_Mid`
- `S2_Role_Support`
- `S2_Role_Carry`

Lucid should resolve and track these reactions by custom emoji ID.

## Pickup Formats

### Pickup vs Pickup

Lucid collects enough players to create two complete teams.

Each team contains:

- 1 Solo
- 1 Jungle
- 1 Mid
- 1 Support
- 1 Carry

### Pickup vs Premade

Lucid collects enough players to create one complete pickup team against an existing premade team.

The pickup team contains:

- 1 Solo
- 1 Jungle
- 1 Mid
- 1 Support
- 1 Carry

The coordinator may provide the premade team's name when creating the event.

## Time Handling

Coordinators can enter start times naturally, such as:

- `tonight at 8`
- `tomorrow at 7pm`
- `Friday at 9:30`
- `8/29 at 6pm`

Lucid interprets event creation times using the `America/New_York` timezone and stores the resulting absolute timestamp.

Public messages use Discord timestamp formatting so every player sees the event time converted to their own local timezone.

## Project Documentation

Detailed behavior is documented in:

- [`docs/product-spec.md`](docs/product-spec.md)
- [`docs/ux-flow.md`](docs/ux-flow.md)
- [`docs/data-model.md`](docs/data-model.md)
