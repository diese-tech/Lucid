# Lucid Read-Only Pickup Data API

A small, read-only HTTP surface for external integrations (issue #45) — e.g.
the Dream Walkers website showing active/historical pickups without
scraping Discord messages. There are **no mutation endpoints** of any kind;
every route here is `GET`.

## Consumption model — server-side only

This API is meant to be called by a trusted backend (the website's own
server), **never directly from a browser**. The single API key (below)
grants read access to every pickup this Lucid instance manages, across
every guild it's in — shipping that key to client-side JavaScript leaks it
to anyone who opens the page's network tab. There is deliberately no CORS
support: its absence is part of communicating "this isn't meant to be
called from a browser," since CORS is a browser-enforced policy that does
nothing to stop a server-side caller either way.

Lucid currently serves one guild. "One key sees every guild this instance
manages" is therefore equivalent to "one key sees the one guild." If this
instance ever serves multiple, unrelated guilds, a per-key guild scope
would need to be built before handing this key to more than one consumer —
it isn't today.

## Authentication

Every route except `/api/health` requires an `X-API-Key` header:

```
X-API-Key: <LUCID_API_KEY>
```

A missing or incorrect key returns `401`:

```json
{ "error": "unauthorized" }
```

## `GET /api/health`

Unauthenticated liveness probe — confirms the process is up, nothing more.
Intended for Railway's own health checking.

```
$ curl https://your-lucid-instance.example/api/health
{"status":"ok"}
```

## `GET /api/pickups`

Query parameters:

| Param | Required | Description |
|---|---|---|
| `status` | **Yes** | Comma-separated list of one or more of `open`, `roster_ready`, `published`, `cancelled`, `finished`. |
| `guild_id` | No | Restrict to one guild. Omitted, spans every guild this instance manages. |
| `limit` | No | Max records returned. Defaults to 100, hard-capped at 500 regardless of what's requested. |

`status` has no default — an unfiltered, cross-status, cross-guild dump has
no natural bound, so a request without it is rejected with `400` rather
than silently returning "everything":

```json
{ "error": "status query parameter is required" }
```

An unrecognized status value is also rejected, naming the bad value (never
silently dropped, which would make a typo look like "no results due" rather
than a mistake):

```json
{ "error": "invalid status value", "value": "compelted" }
```

### Mapping the issue's own examples to this API

- **Active pickups**: `?status=open,roster_ready,published`
- **Completed pickups**: `?status=finished` — Lucid's own vocabulary calls
  this state `finished`, not `completed`; they mean the same thing.
- **Cancelled pickups**: `?status=cancelled`

### Example

```
$ curl -H "X-API-Key: $LUCID_API_KEY" \
    "https://your-lucid-instance.example/api/pickups?status=open,roster_ready,published"
```

```json
{
  "pickups": [
    {
      "schema_version": 1,
      "id": 42,
      "guild_id": "123456789012345678",
      "status": "published",
      "format": "pickup_vs_pickup",
      "premade_name": null,
      "created_by": "234567890123456789",
      "created_at": "2026-09-17T18:00:00.000Z",
      "updated_at": "2026-09-17T18:04:12.000Z",
      "scheduled_start_at": "2026-09-17T20:00:00.000Z",
      "finished_at": null,
      "finished_by": null,
      "finish_reason": null,
      "required_players": 10,
      "signup_count": 12,
      "signups": [
        { "discord_id": "345678901234567890", "roles": ["solo", "fill"] }
      ],
      "roster": [
        { "team": "order", "role": "solo", "discord_id": "345678901234567890" }
      ],
      "discord": {
        "guild_id": "123456789012345678",
        "signup_channel_id": "456789012345678901",
        "roster_channel_id": "567890123456789012",
        "review_channel_id": "678901234567890123",
        "signup_message_id": "789012345678901234",
        "roster_message_id": "890123456789012345",
        "review_message_id": "901234567890123456"
      }
    }
  ]
}
```

## `GET /api/pickups/:id`

The same record shape as above, for exactly one pickup, regardless of
status — this is also how you look up historical (finished/cancelled)
pickups by id. `404` if the id doesn't exist:

```json
{ "error": "not_found" }
```

## Response schema notes

- **`schema_version`** is the compatibility contract. A future breaking
  change to this shape bumps it; existing consumers can branch on it rather
  than being surprised by a silent reshape.
- **Timestamps** are ISO 8601 strings. Every one of them is a straight
  conversion except `scheduled_start_at`, which Lucid stores internally in
  Unix *seconds* rather than milliseconds (a Discord-timestamp-formatting
  detail, not a semantic difference).
- **`signup_count`** counts unique participants, not signup rows — a player
  who declared two roles (e.g. `solo` and `fill`) is one signer-upper, and
  appears once in `signups` with both roles listed.
- **`roster`** is always an array, `[]` before a roster has been generated —
  never a missing key.
- **`required_players`** is the pickup's full roster size (roles × teams for
  its format); useful for rendering "8/10 signed up" style progress without
  the consumer needing to know Lucid's own role/team constants.
- Fields not in this response — the pickup's internal origin channel, ping
  role configuration, eligibility role list, staff-facing note, roster
  version — were not requested by the integration this API exists for and
  are left out rather than guessed into a "might as well include it" v1.
  Easy additions later, behind a `schema_version` bump if needed.

## Non-goals

No mutation endpoints, no webhooks or real-time push (poll this API on your
own schedule), no multi-key/per-guild access control in v1, no
cursor/offset pagination beyond `status` filtering plus `limit`.
