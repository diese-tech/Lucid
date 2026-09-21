# Lucid Setup

Everything here is one-time setup. The bot code is complete and waiting on these
steps — none of them require writing any code.

## 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application named **Lucid**.
2. Open **Bot** in the sidebar and add a bot user.
3. Copy the **token** — this becomes `DISCORD_TOKEN`. It is shown once; regenerate it if you lose it.
4. From **General Information**, copy the **Application ID** — this becomes `DISCORD_CLIENT_ID`.

### Enable the privileged intent

Still under **Bot**, scroll to **Privileged Gateway Intents** and turn on:

- **Server Members Intent**

Lucid needs this to search members by name when staff replace a player on a
published roster. Without it the bot will fail to log in.

The other intents Lucid uses (Guilds, Guild Message Reactions, Guild
Expressions — the last one is what lets Lucid recognize the custom emoji you
react with during `/pickup config bind_emoji`) are not privileged and need no
toggle. **Message Content is deliberately not used** —
every interaction is a slash command, button, select or modal, so Lucid never
reads the text of anyone's messages.

## 2. Invite the bot

The invite link needs the `bot` and `applications.commands` scopes, plus a
permissions integer covering:

| Permission | Why |
|---|---|
| View Channels | Read the channels it posts in |
| Send Messages | Post signup, review and roster messages |
| Add Reactions | Seed the five role icons and optional Fill on a signup post |
| Read Message History | Edit messages it posted earlier |
| Manage Messages | Remove a reaction that would put a player over their role limit |
| Mention @everyone, @here, and All Roles | Actually notify the configured ping role, including one your server has deliberately left non-mentionable by regular members |
| Embed Links | Send the staff control/review/published/finished/cancelled cards, which render as embeds (issue #53) — without this, Discord rejects every one of those messages outright |

That permission set is defined once, in code, as `REQUIRED_PERMISSIONS` in
[`src/discord/commands.ts`](../src/discord/commands.ts) — it sums to **224320**.
The invite link for Lucid's application:

```
https://discord.com/api/oauth2/authorize?client_id=1543455231222743200&scope=bot+applications.commands&permissions=224320
```

(Same result as using **OAuth2 → URL Generator** in the Developer Portal and
ticking each permission above by hand — this is just the direct link. Running
a separate dev bot per the token-collision note below? Swap in *that*
application's Client ID instead.)

If `REQUIRED_PERMISSIONS` ever changes, this number goes stale; recompute it
with:

```bash
npx tsx -e "
import { PermissionsBitField } from 'discord.js';
import { REQUIRED_PERMISSIONS } from './src/discord/commands.ts';
console.log(new PermissionsBitField(REQUIRED_PERMISSIONS).bitfield.toString());
"
```

Open the link and add Lucid to your server.

## 3. Configure the environment

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. Leave `DATABASE_PATH` at its
default for local development. Also set `LUCID_API_KEY` to any value (e.g.
`openssl rand -hex 32`) — the read-only pickup data API (see **7. Read-only
pickup data API** below) refuses to boot without one, exactly like
`DISCORD_TOKEN`. `PORT` can stay at its default locally.

## 4. Install and run

```bash
npm install
npm run dev        # starts the bot with hot reload
```

There is no separate command-registration step — Lucid publishes `/pickup` to
Discord itself, automatically, every time it starts.

### Command registration

`src/discord/register.ts` registers Lucid's slash commands guild-by-guild
rather than globally. `index.ts` calls it twice: once on every boot, for
every guild Lucid is already in, and again the moment it joins a new one.
Guild-scoped registration applies within seconds — there's no up-to-an-hour
global propagation delay to wait out, and nothing to configure per
environment. Inviting the bot to a server and starting it (or restarting a
running one) is the whole process.

Running a second long-lived instance against the same guild — already
discouraged, see **Never run two instances on one bot token** below — makes
this run twice concurrently too. Harmless: both boots register the exact same
command definitions, so the second registration is a same-content overwrite,
not a conflict.

**One-time cleanup if you ran an older version of Lucid:** earlier versions
registered globally instead. Run `npm run unregister-global` once to clear
that global registration. Otherwise every server Lucid is in shows each
command **twice** — Discord stores global and guild-scoped registrations
independently and never deduplicates them. The bot's own guild-scoped
registration is untouched by this and simply re-applies on its next boot.

## 5. Configure the server

Configuration is split between per-space setup (channels, roles — a guild can
run more than one independently configured pickup lane) and a small
guild-wide remainder (timezone, role emoji).

**Step one — create a Pickup Space.** Run `/pickup space create
name:"Public Pickups"`, admin-only (Manage Server). Lucid shows a two-page
panel: the first page has four channel dropdowns — origin channel (where
`/pickup create` must be run to reach this space), signup channel, roster
channel, staff review channel — with a **Next: Roles →** button; the second
has authorized staff roles plus the optional signup ping role and default
eligibility roles (any one qualifies a new pickup), with a **← Back**
button.
Each dropdown saves the moment you pick it — there is no Save button. Come
back anytime with `/pickup space edit space:"Public Pickups"` to change a
field, or `/pickup space list` to see every space's status at a glance.

Running a second, differently-routed space later (for example a restricted
lower-skill lane) is the same command with a different name and channels —
there is no separate "multi-tenant" setup step.

**Step two — role emoji (guild-wide).** Run `/pickup config bind_emoji:true`.
Lucid posts a message; react with the five required role icons **in this
order**: Solo, Jungle, Mid, Support, Carry, then optionally react with Fill or
press **Skip Fill**. Lucid binds each one by its custom emoji ID. For Dream
Walkers these are `S2_Role_Solo`, `S2_Role_Jungle`, `S2_Role_Mid`,
`S2_Role_Support`, `S2_Role_Carry`. Every space shares the same emoji.

**Optional — timezone (guild-wide).** `/pickup config timezone:America/New_York`.
This is what natural-language start times like "tonight at 8" are interpreted
against. It defaults to `America/New_York`, so Dream Walkers never needs to
set it; other leagues should. The field autocompletes. Every space shares the
same timezone.

`/pickup create`, run from a space's configured origin channel, will refuse to
run until that space and the guild-wide emoji are both complete, and will tell
you exactly which fields are still missing and where to set them.

## 6. Deploy to Railway

1. Create a Railway project from this repository.
2. Add a **volume** and mount it (for example at `/data`).
3. Set the service variables:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `DATABASE_PATH=/data/lucid.sqlite`

**The `DATABASE_PATH` must point inside the mounted volume.** Railway's
container filesystem is replaced on every deploy, so a database written anywhere
else is silently destroyed each time you ship — taking every pickup, signup and
roster with it.

Railway runs `npm run build` then `npm start` from the committed
`package.json`. No separate registration step is needed — the bot registers
its own commands, per guild, the moment it comes online (see **Command
registration** above), so deploying a change to `commands.ts` is enough on
its own.

## 7. Read-only pickup data API

Lucid also serves a small read-only HTTP API for external integrations (the
Dream Walkers website, or any other trusted server-side consumer) — see
[`docs/api.md`](./api.md) for the endpoints and response schema. It runs
inside the same process as the bot, on the same Railway service, and needs
one thing this deployment didn't need before: an **inbound** port. Until now
Lucid only ever made outbound connections (the Discord gateway).

1. In the Railway service's **Settings → Networking**, enable **public
   networking**. Railway assigns a domain and injects a `PORT` environment
   variable automatically — `loadEnv()` reads it, so no manual `PORT` setting
   is needed on Railway (only for local dev, where it defaults to `8080`).
2. Set the service variable `LUCID_API_KEY` to a long random value (e.g.
   `openssl rand -hex 32`). **Never commit this value and never post it in
   Discord** — anyone holding it can read every pickup this instance
   manages, across every guild it's in.
3. Hand the generated Railway domain and the API key to the consumer's
   backend directly (email, a password manager, a secrets store) — never
   through Discord or a commit. The key must only ever be held server-side;
   see `docs/api.md`'s consumption-model note for why.

## 8. Player vetting (optional)

Lucid can optionally sync guild membership and role state to a Google
Sheets-backed vetting workflow (issue #54) and apply a human vetting
decision back as a Discord tier role. It's fully opt-in — leave
`VETTING_ENABLED` unset and none of this applies.

As of Phase 3, once running (with vetting enabled) Lucid keeps the `SYSTEM`
tab current automatically as members join, leave, or change roles/nickname/
username (`src/vetting/sync.ts`) — bootstrap (`src/vetting/bootstrap.ts`) is
only needed once, to populate `SYSTEM` for the first time, and again if you
ever suspect the sheet has drifted (a missed event during downtime, say).
This section covers getting the credentials working end-to-end and running
that first bootstrap.

**Row layout, on both tabs:** row 1 is a title, row 2 the column headers,
and row 3 is the first real data row. Every formula Lucid installs (steps
8-9 below) targets row 3 onward and never touches row 1 or 2 — those stay
entirely human-owned (or, for `SYSTEM`'s headers, whatever the reference
template shipped with). If you ever see `#REF!` in `VETTING`'s Discord
ID/Player/Current Roles cells, it means an older version of Lucid installed
formulas starting at row 2 instead of row 3, writing directly into your
header row and blocking the formula from spilling into the real data below.
Fixing that on an already-affected sheet takes one manual step this code
can't do for you, since Lucid never learned what your original header text
said: clear whatever's currently sitting in `VETTING!A2:C2` (the `#REF!`
cells, or any stray formula) and retype the header labels ("Discord ID",
"Player", "Current Roles"). Once that's done, re-running steps 8 and 9
below is safe — the current versions clear their own row-3-onward spill
range before writing, and only ever touch row 3 and beyond.

1. In a Google Cloud project, create a dedicated service account (e.g.
   `lucid-vetting-sync`) under **IAM & Admin → Service Accounts**. It needs
   **no project-level IAM role** — access comes entirely from sharing the
   spreadsheet with it directly (step 4).
2. Enable the **Google Sheets API** for that project (**APIs & Services →
   Library**). The Drive API is not needed.
3. Create a JSON key for the service account (**Keys → Add Key → Create new
   key → JSON**) and download it. If key creation is blocked by an
   organization policy (`iam.disableServiceAccountKeyCreation`), see if you
   can override it for the project under **IAM & Admin → Organization
   Policies**, or ask whoever administers the org to.
4. Share the vetting spreadsheet with the service account's `...@<project>.
   iam.gserviceaccount.com` email as **Editor**.
5. Fill in the vetting section of `.env.example` in your `.env` (or Railway
   service variables): `VETTING_ENABLED=true`, `VETTING_GUILD_ID` (the one
   Discord server this configuration applies to — right-click the server
   icon → Copy Server ID, with Developer Mode on), `VETTING_SPREADSHEET_ID`
   (the `/d/<this part>/edit` segment of the sheet's URL), one
   `VETTING_TIER_<N>_ROLE_ID` per configured tier, and
   `GOOGLE_SERVICE_ACCOUNT_JSON` — the entire downloaded key file's contents,
   pasted as one value. **Never commit any of these filled-in values.**
   `VETTING_GUILD_ID` matters even if Lucid is only in one guild today — it's
   what keeps a member of any other guild Lucid is in from ever being
   written into this spreadsheet or evaluated against these tier role IDs.
6. Run `npm run vetting:smoke-test` to confirm the credentials actually work:
   it reads the `SYSTEM` tab's first few rows, then round-trips a harmless
   write to a cell outside the real column range and clears it again. A
   `403`/permission error here almost always means step 4 (the spreadsheet
   share) was skipped or used the wrong email, or a `sheets.googleapis.com`
   403 naming a project means the Sheets API (step 2) isn't enabled yet.
7. Run `npm run vetting:bootstrap` to populate `SYSTEM` from the guild's
   actual membership — one row per non-bot member, with their current roles
   rendered in plain English and their tier auto-detected from the
   `VETTING_TIER_<N>_ROLE_ID` mapping. Safe to re-run any time: an existing
   member's row is refreshed in place, never duplicated. A member printed as
   a conflict (multiple configured tier roles at once) is left with a blank
   `Current Tier Role` and `Sync Status = Conflict` in the sheet — resolve it
   by removing the extra Discord role, then re-run.
8. Before running either setup script below, make sure `VETTING`'s row 2
   (the header row) actually has the required structural headers, in
   order: `Discord ID`, `Player`, `Current Roles`, one or more reviewer
   columns (any names you like), `Vote Summary`, `Consensus`, `Final
   Decision`. Both setup scripts (and any future repair tooling) resolve
   every VETTING coordinate from this header row via a shared layout
   resolver (`src/vetting/vetting-layout.ts`, issue #71) instead of
   assuming a fixed `D:K`/`L:M`/`N` shape — see "Changing your reviewer
   team" below for the full contract and how to safely add/remove/rename
   reviewer columns later, including on a live sheet with existing votes.
9. Run `npm run vetting:setup-relational-view` once to make the `VETTING`
   tab actually show your active players: it installs formulas in
   `VETTING`'s resolved Discord ID/Player/Current Roles columns (typically
   `A3:C3`, spilling down automatically as `SYSTEM` grows) that mirror
   `SYSTEM` by row position, keyed by Discord ID. Safe to re-run any time
   — it clears only its own resolved spill range before writing, so a
   stale previous install or leftover content can never block the
   formula, and it never touches row 1, row 2, the reviewer columns, Vote
   Summary, Consensus, or Final Decision. Until this step runs, `VETTING`
   stays empty even though `SYSTEM` is fully populated — that's expected,
   not a bug: nothing connects the two tabs until this formula install
   happens. A row goes fully blank the moment its `SYSTEM.Active` flips to
   `FALSE` (a departed member), so departed players don't clutter the
   active queue — the underlying row never moves, so any votes already
   recorded on it are untouched and reappear the moment that same player
   rejoins. A malformed VETTING header row (see "Changing your reviewer
   team" below) makes this fail loudly and cleanly before touching
   anything.
10. Run `npm run vetting:setup-voting` once to wire up the human voting
    workflow: it resolves VETTING's current reviewer block from the header
    row and installs a Vote Summary and Consensus formula immediately
    after it (each row tallies only that row's own resolved reviewer
    columns, spilling down automatically as rows are added), plus a Final
    Decision lookup in `SYSTEM!I3`. That lookup finds each player's
    `VETTING.Final Decision` **by Discord ID**, never by row position or
    display name (issue #72) — `SYSTEM` and `VETTING` no longer need to
    stay row-aligned, and a display-name change or a reordered VETTING row
    can never surface on the wrong player. If the same Discord ID somehow
    appears more than once in `VETTING`, `SYSTEM!I` shows a
    `#DUPLICATE VETTING DISCORD ID` marker instead of guessing — this is
    intentionally non-numeric, so the reconciliation step below already
    treats it as an invalid Final Decision (error, no mutation) with no
    extra handling needed; fix the duplicate row in `VETTING` and the next
    poll/setup re-run picks up the corrected value. Safe to re-run any
    time — it also clears only its own resolved spill ranges before
    writing, never the reviewer vote block or Final Decision itself. Make
    sure the reviewer columns' and `Final Decision`'s dropdowns are
    restricted to your actual configured tier range — currently **1–5**,
    `VETTING_TIERS` in `src/vetting/config.ts` — not the reference
    template's original 1–7, which predates that narrower range. Lucid
    never installs or requires a specific set of validation rules there,
    and never writes to any of those cells itself, so an out-of-range value
    (a leftover 6/7 dropdown option, or the box left unrestricted entirely)
    won't be rejected on entry — it just won't count toward Vote Summary or
    Consensus, either of which only ever tally the resolved reviewer
    columns. Rename the reviewer columns' headers to your actual vetting
    team once — Lucid never hard-codes them. Consensus reads `Unanimous N`
    when every vote cast on a row agrees, `Majority N` when one tier has
    strictly more than half the votes cast, and `Split` otherwise; a row
    with no votes yet (or only out-of-range ones) shows blank in both
    columns. None of this reaches Discord by itself — Vote Summary and
    Consensus are purely informational, and only a human-set `Final
    Decision` (read from `SYSTEM!I`) will ever change a tier role, via the
    automatic reconciliation covered next.

### Changing your reviewer team (issue #71)

The reviewer/vetter block's width is never hard-coded and never
configured through an environment variable — it's derived from
`VETTING`'s own row-2 header text every time either setup script runs, so
staff can add, remove, or rename reviewer columns entirely on the live
sheet.

The required structural headers, in order, are:

```text
Discord ID | Player | Current Roles | <one or more reviewer columns> | Vote Summary | Consensus | Final Decision | <optional columns, e.g. OSL/BSL>
```

- Reviewer column **names** are entirely yours — rename them to your
  actual vetting team's names any time; Lucid never reads or depends on
  the text itself, only the fact that they sit between `Current Roles`
  and `Vote Summary`.
- To **add** a reviewer, insert a new column anywhere between the last
  reviewer column and `Vote Summary`, give it a header, then re-run
  `npm run vetting:setup-voting` (and, if `Current Roles` itself shifted,
  `vetting:setup-relational-view` too). The new column is automatically
  included in the next Vote Summary/Consensus tally. Existing votes in the
  other reviewer columns, and every `Final Decision`, are untouched —
  the setup scripts only ever clear/rewrite their own resolved
  formula-owned columns.
- To **remove** a reviewer, **delete their column** (not just its header
  text), then re-run setup. The reviewer block is every column between
  `Current Roles` and `Vote Summary` by *position*, not by whether a
  header is filled in — merely clearing a reviewer's header still leaves
  their now-blank-headed column inside that range, so any vote already in
  it would keep affecting the tally. Actually deleting the column shrinks
  the reviewer block to the remaining reviewers automatically.
- `Vote Summary`, `Consensus`, and `Final Decision` must stay in that
  exact order, each immediately after the previous one, with at least one
  reviewer column before `Vote Summary`. If a header is missing,
  duplicated, out of order, or the reviewer block is empty, both setup
  scripts throw a `VettingLayoutError` describing exactly what's wrong
  and perform **no** clear or write at all — a staff typo (e.g. renaming
  `Vote Summary` to `Votes`) can never silently redirect a formula install
  into the wrong columns.
- Columns after `Final Decision` (the live sheet's `OSL`/`BSL`) are
  ordinary product fields, not reviewers — they're never touched by
  either setup script and never counted toward Vote Summary/Consensus,
  regardless of how many reviewer columns exist before them.
- Multi-letter columns (`AA`, `AB`, …) are fully supported if your
  reviewer team is large enough to push Vote Summary past column `Z`.
- This same header-driven layout is what makes vetter count "configurable"
  (issue #72 Goal B) — no `VETTING_VETTER_COUNT`-style env var, redeploy,
  or source-code edit is ever needed; the sheet's own header row is the
  configuration.

Once running (with vetting enabled), Lucid also polls `SYSTEM!I` (Final
Decision) every `VETTING_POLL_INTERVAL_SECONDS` (default 120) and applies it
as a Discord tier role change (issue #54 Phase 6) — no manual step needed.
For each active player with a valid, non-blank Final Decision that differs
from the tier role they actually, currently hold, Lucid removes their old
managed tier role and adds the new one, then records `Last Applied Tier`/
`Sync Status`/`Last Synced` in `SYSTEM!J:L`. A blank Final Decision changes
nothing. A player holding two managed tier roles at once, or a Final
Decision outside the configured tier range, is left alone and marked
`Conflict`/`Error` respectively rather than guessed at — fix the underlying
Discord roles or the dropdown value and the next poll (or the live sync
listeners, for a role fixed by hand) picks it up. Only the five configured
tier roles are ever touched; nothing else on a member is ever added,
removed, or inspected.

Separately, every `VETTING_DRIFT_REPAIR_INTERVAL_SECONDS` (default 1800 —
30 minutes) Lucid also runs a slower, full drift-repair pass (issue #54
Phase 7) — the safety net under everything above. Discord events and the
faster poll only help while Lucid is actually running; this pass re-derives
correct state from scratch regardless of what was missed while it wasn't
(a restart, an outage, a rate limit). It re-bootstraps every current guild
member (catching a missed join, a historical player's rejoin, or any
username/role/tier drift), marks any `SYSTEM` row still `Active = TRUE` for
someone no longer actually in the guild as departed, and re-runs Final
Decision reconciliation. Safe to think of as "what would running bootstrap
and reconciliation by hand right now do" — nothing here is a new kind of
action, just the existing ones run automatically on a schedule.

**Reading `Sync Status` (`SYSTEM!K`) and the logs (issue #54 Phase 8):**
`Synced` means the last thing Lucid checked for this player matched (or was
successfully applied); `Conflict` means the player currently holds two or
more of the configured tier roles at once and Lucid is deliberately not
guessing which one is "right" — remove the extra role by hand and the next
pass clears it; `Error` means the last write/mutation attempt for this row
failed (an invalid Final Decision value, a Discord API failure) and will be
retried automatically on the next pass. Application logs (`[vetting-reconcile]`/
`[vetting-drift-repair]` prefixes) record every applied role change as
`<discord id>: tier <old> -> <new> applied`, and every failure with enough
detail to tell a Discord-side problem (a specific `RESTJSONErrorCodes`
value — e.g. a deleted/misconfigured tier role, or Lucid missing the
"Manage Roles" permission) apart from a Sheets-side one (an auth or API
failure, logged separately at the poll-tick level since it aborts that
whole pass rather than one player). Nothing here ever logs the service
account's credentials or any other secret value.

From this point on, no more manual steps are needed to keep `SYSTEM` (and,
through it, `VETTING`'s Discord ID/Player/Current Roles) current — the
running bot listens for member joins/leaves/role/nickname/username changes
and syncs each one automatically, the moment it happens. Re-running
`npm run vetting:bootstrap` is only for the initial population above, or to
force a full resync if you suspect drift (e.g. the bot was offline during a
role change).

**If `SYSTEM` was ever pre-populated from another source** (a prior bot's
own export, a manually built starter template, etc.) before Lucid's own
bootstrap first ran, some rows may not correspond to anyone who was ever
actually a member of this Discord server. Nothing Lucid runs automatically
ever looks at a row like that a second time once it's been marked inactive
(the automated passes only ever check rows *they* wrote from real Discord
state), so it can sit there silently forever. Run
`npm run vetting:audit-orphans` any time to list every `SYSTEM` row whose
Discord ID doesn't match a current guild member — including real players
who have genuinely left, so review the list rather than assuming everything
on it is bad data. It's read-only; nothing it finds gets touched
automatically, and deleting a confirmed-stray row is a manual edit.

**Protecting `SYSTEM`, and what's safe to edit by hand (issue #54 Phase
9):** `SYSTEM` is Lucid's own machine-facing interface — protect it from
routine vetting-team edits under **Data → Protect sheets and ranges** in
Google Sheets, selecting the `SYSTEM` tab and leaving only yourself (the
spreadsheet owner) and the service account's email as editors. `VETTING`
should stay broadly editable by the whole vetting team; no protection is
needed there beyond what a normal shared spreadsheet already has, since the
columns humans aren't meant to touch (Discord ID/Player/Current Roles, Vote
Summary/Consensus — all formula-driven, per Phases 4-5) simply show
blank/computed values rather than anything worth guarding. Their exact
column letters depend on your current reviewer count (see "Changing your
reviewer team" above) rather than being permanently `A`-`C`/`L`-`M`.

Every write Lucid ever makes — bootstrap, live sync, reconciliation, drift
repair, and the two one-time formula installers — is scoped to specific
bounded columns, never a full-tab replace, and each one only ever touches
columns it owns. The two setup scripts resolve exactly which VETTING
columns those are from the header row (via `resolveVettingLayout`) instead
of assuming fixed letters:

| Who may edit | `VETTING` | `SYSTEM` |
|---|---|---|
| **Humans** | Reviewer column headers (staff names/renames/adds/removes these freely — see "Changing your reviewer team"); each reviewer's `1`-`5` vote; `Final Decision` | Nothing — read-only in normal use |
| **Lucid** | Discord ID/Player/Current Roles (Phase 4 formulas); Vote Summary/Consensus (Phase 5 formulas) — resolved from the header row, never the reviewer columns or Final Decision | Humans should treat all of `SYSTEM` as read-only. Bootstrap and live sync write Discord facts only to `A`-`H` and sync metadata only to `K`-`L`; reconciliation alone writes Last Applied Tier in `J`. The one-time `vetting:setup-voting` script owns installation of the `I` Final Decision lookup formula, which now finds each player's decision in `VETTING` by Discord ID rather than by row position. Routine row creation and updates never write `I` or `J`, including placeholder blanks, so they cannot block the `I` ARRAYFORMULA spill. |

A normal vetter only ever needs to touch `VETTING`'s vote columns and
`Final Decision` — nothing about Discord IDs or how the rest of the sheet
works. Because Lucid's writes are always bounded to the columns above and
never clear or replace a whole tab, a human's votes, Final Decision, and
any formatting/dropdowns on those cells are never at risk from a bootstrap
run, a live sync event, or either poll worker, even if a vetter is actively
editing `VETTING` at the same moment.

## Never run two instances on one bot token

A Discord bot token identifies **one** running bot. If a deployed instance and
a local `npm run dev` are both logged in with the same `DISCORD_TOKEN`, Discord
delivers each interaction to both, they both try to answer it, and only the
first response wins. The loser fails with:

```
DiscordAPIError[10062]: Unknown interaction
DiscordAPIError[40060]: Interaction has already been acknowledged
```

The cloud instance usually wins the race, so **local development appears
completely broken while production works fine** — every command, button and
select fails instantly, with healthy-looking logs on both sides. Nothing in the
logs points at the other instance; this is the only symptom.

To develop locally, do one of the following:

- **Recommended — use a second bot.** Create a separate Discord application
  ("Lucid Dev"), invite it to a test server, and put *its* token and client ID
  in your local `.env`. Production and local development then never collide,
  and you can leave Railway running.
- **Or stop the deployed instance** while you work locally (in Railway: remove
  the active deployment or scale the service to zero). Wait ~60 seconds after
  stopping before testing — Discord takes a few heartbeat intervals to release
  the old gateway session, so testing immediately can still hit the ghost.

The same applies to two local terminals: only ever run one `npm run dev`.

**One-shot scripts are fine.** `npm run unregister-global` logs in with the
same token while the deployed bot is running, and that is safe: it never
registers an interaction handler, and it exits immediately. Only two
*long-lived* processes that both answer interactions collide. This is an easy
distinction to miss — running a one-off script against a live deployment
looks identical from the outside and causes no trouble at all.

## Daily use

| Command | Who | What |
|---|---|---|
| `/help` | Everyone | Private quickstart for Lucid's commands and roster controls |
| `/pickup create` | Staff | Setup wizard → preview → public signup post |
| `/pickup cancel` | Staff | Close an open pickup; also available as a button on the staff card |
| `/pickup space create\|edit\|list\|delete` | Admins | Per-space channels, staff roles, and ping/eligibility roles |
| `/pickup config` | Admins | Guild-wide timezone and role emoji |

Players never run commands — they just react to the signup post.
