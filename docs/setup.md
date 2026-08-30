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
| Add Reactions | Seed the five role icons on a signup post |
| Read Message History | Edit messages it posted earlier |
| Manage Messages | Remove a reaction that would put a player over their role limit |
| Mention @everyone, @here, and All Roles | Actually notify the configured ping role, including one your server has deliberately left non-mentionable by regular members |

That permission set is defined once, in code, as `REQUIRED_PERMISSIONS` in
[`src/discord/commands.ts`](../src/discord/commands.ts) — it sums to **207936**.
The invite link for Lucid's application:

```
https://discord.com/api/oauth2/authorize?client_id=1543455231222743200&scope=bot+applications.commands&permissions=207936
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
default for local development.

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

In Discord, run `/pickup config`. This is admin-only (Manage Server).

**Step one — channels and roles.** Five dropdowns appear: signup channel, roster
channel, staff review channel, ping role, and authorized staff roles. Each one
saves the moment you pick it — there is no Save button, so you can set some now
and the rest later, and re-running the command to change one field won't make
you re-pick the others. The message shows ✅ / ⬜ for what's set.

**Step two — role emoji.** Run `/pickup config bind_emoji:true`. Lucid posts a
message; react to it with your five role icons **in this order**: Solo, Jungle,
Mid, Support, Carry. Lucid binds each one by its custom emoji ID. For Dream
Walkers these are `S2_Role_Solo`, `S2_Role_Jungle`, `S2_Role_Mid`,
`S2_Role_Support`, `S2_Role_Carry`.

**Optional — timezone.** `/pickup config timezone:America/New_York`. This is
what natural-language start times like "tonight at 8" are interpreted against.
It defaults to `America/New_York`, so Dream Walkers never needs to set it; other
leagues should. The field autocompletes.

`/pickup create` will refuse to run until configuration is complete, and will
tell you exactly which fields are still missing.

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
| `/pickup create` | Staff | Setup wizard → preview → public signup post |
| `/pickup cancel` | Staff | Close an open pickup; also available as a button on the staff card |
| `/pickup config` | Admins | Server configuration |

Players never run commands — they just react to the signup post.
