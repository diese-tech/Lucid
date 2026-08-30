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

Under **OAuth2 → URL Generator**, select scopes `bot` and `applications.commands`,
then these bot permissions:

| Permission | Why |
|---|---|
| View Channels | Read the channels it posts in |
| Send Messages | Post signup, review and roster messages |
| Add Reactions | Seed the five role icons on a signup post |
| Read Message History | Edit messages it posted earlier |
| Manage Messages | Remove a reaction that would put a player over their role limit |
| Mention @everyone, @here, and All Roles | Actually notify the configured ping role, including one your server has deliberately left non-mentionable by regular members |

Open the generated URL and add Lucid to your server.

## 3. Configure the environment

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. Leave `DATABASE_PATH` at its
default for local development.

## 4. Install and register commands

```bash
npm install
npm run register   # publishes the /pickup command to Discord
npm run dev        # starts the bot with hot reload
```

Commands are registered **globally**, so Lucid works in any server that adds it —
not just Dream Walkers. Global commands can take up to an hour to appear the
first time.

**While developing against one test server, skip that wait**: set
`DISCORD_TEST_GUILD_ID` in `.env` to your test server's ID (right-click the
server icon with Developer Mode on → Copy Server ID). `npm run register` then
publishes to that one guild instead, which Discord applies within seconds.
Leave it unset for a real deploy — that's what keeps registration global.

**Seeing every `/pickup` command listed twice?** That means this server has
both a global registration and a guild-scoped one — Discord stores them
independently and shows both, even though they're identical. This happens if
`register` ever ran without `DISCORD_TEST_GUILD_ID` (registering globally)
and later ran again with it set (adding a guild-scoped copy on top). Run
`npm run unregister-global` to clear the global set and keep only the fast
guild-scoped one while you're developing.

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

Do **not** set `DISCORD_TEST_GUILD_ID` on Railway. It is read only by
`npm run register` (`src/scripts/register-commands.ts`), never by the running
bot, and it exists purely to make local command registration instant.

Railway runs `npm run build` then `npm start` from the committed
`package.json`. Run `npm run register` once locally (or as a one-off Railway
command) after any change to the command definitions.

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

**One-shot scripts are fine.** `npm run register` and `npm run unregister-global`
log in with the same token while the deployed bot is running, and that is safe:
they never register an interaction handler, and they exit immediately. Only two
*long-lived* processes that both answer interactions collide. This is an easy
distinction to miss — running a bootstrap or registration script against a live
deployment looks identical from the outside and causes no trouble at all.

## Daily use

| Command | Who | What |
|---|---|---|
| `/pickup create` | Staff | Setup wizard → preview → public signup post |
| `/pickup cancel` | Staff | Close an open pickup; also available as a button on the staff card |
| `/pickup config` | Admins | Server configuration |

Players never run commands — they just react to the signup post.
