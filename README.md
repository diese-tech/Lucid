# Lucid

Lucid is a lightweight Discord bot for coordinating **SMITE 2 pickup scrims** in the Dream Walkers community.

It turns a staff-created pickup into a guided workflow: players sign up by role, Lucid tracks eligibility and readiness, staff review generated rosters privately, and the final teams are published back to Discord.

> **Status:** Active development. The core pickup workflow is implemented and designed for Railway-hosted, SQLite-backed operation.

## What Lucid Does

- Creates pickup-vs-pickup and pickup-vs-premade events with `/pickup create`
- Parses natural-language start times and renders Discord-localized timestamps
- Collects role signups for Solo, Jungle, Mid, Support, Carry, and optional Fill
- Supports per-pickup eligibility filters and role-selection limits
- Detects when enough eligible players exist to generate a valid roster
- Gives authorized staff private shuffle, reorder, swap, and edit controls
- Publishes final rosters publicly
- Supports guarded cancellation before publication
- Supports post-publication player replacement with a visible roster update
- Keeps concurrent pickup workflows isolated

Public signup posts stay intentionally simple. Staff controls live in private management surfaces rather than cluttering the player-facing flow.

## Workflow

```text
Create pickup
    ↓
Collect eligible role signups
    ↓
Roster becomes ready
    ↓
Staff review and adjustment
    ↓
Publish teams
    ↓
Replace players if needed
```

Lucid uses durable SQLite state for pickup lifecycle data. Discord messages and components are interaction surfaces, not the only source of truth for active workflows.

## Quick Start

### Requirements

- Node.js compatible with the version declared by the project
- A Discord application and bot token
- Required Discord permissions/intents described in [`docs/setup.md`](docs/setup.md)

### Install and run

```bash
npm install
cp .env.example .env
npm run dev
```

Running the development process also publishes the configured slash commands.

### Validate

```bash
npm test
```

See the package scripts for any additional typecheck/build checks required by the current branch.

## Configuration

Discord application setup, required permissions, channel configuration, environment variables, and Railway deployment are documented in [`docs/setup.md`](docs/setup.md).

Lucid currently uses the `America/New_York` timezone as its event-creation reference and stores absolute timestamps so Discord can render times locally for each player.

## Documentation

- [`docs/product-spec.md`](docs/product-spec.md) — product behavior and boundaries
- [`docs/ux-flow.md`](docs/ux-flow.md) — player and staff interaction flow
- [`docs/data-model.md`](docs/data-model.md) — persistence model
- [`docs/setup.md`](docs/setup.md) — Discord, local development, and deployment setup

## Design Principles

- **Low-friction player UX:** players should mostly react and read, not learn a complex command system.
- **Contextual staff controls:** once Lucid knows the pickup being managed, buttons/selects are preferred over redundant commands.
- **Server-side authorization:** component visibility is never treated as an authorization boundary.
- **Durable workflow state:** important lifecycle state should survive process restarts and Discord-side failures.
- **Small scope:** Lucid coordinates pickup scrims; it is not intended to become a general-purpose Discord utility bot.
