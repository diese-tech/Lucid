import type Database from 'better-sqlite3';
import { getDatabase } from '../index.js';
import { ROLES, type Role } from '../../domain/roles.js';
import type { GuildConfig } from './types.js';

interface GuildConfigRow {
  guild_id: string;
  signup_channel_id: string | null;
  roster_channel_id: string | null;
  review_channel_id: string | null;
  ping_role_id: string | null;
  authorized_role_ids: string;
  solo_emoji_id: string | null;
  jungle_emoji_id: string | null;
  mid_emoji_id: string | null;
  support_emoji_id: string | null;
  carry_emoji_id: string | null;
  timezone: string;
  created_at: number;
  updated_at: number;
}

function hydrate(row: GuildConfigRow): GuildConfig {
  let authorizedRoleIds: string[] = [];
  try {
    const parsed = JSON.parse(row.authorized_role_ids);
    if (Array.isArray(parsed)) authorizedRoleIds = parsed.filter((id) => typeof id === 'string');
  } catch {
    // A corrupt blob shouldn't take the bot down; an empty list simply means
    // nobody is authorized, which fails safe.
    authorizedRoleIds = [];
  }

  return {
    guildId: row.guild_id,
    signupChannelId: row.signup_channel_id,
    rosterChannelId: row.roster_channel_id,
    reviewChannelId: row.review_channel_id,
    pingRoleId: row.ping_role_id,
    authorizedRoleIds,
    soloEmojiId: row.solo_emoji_id,
    jungleEmojiId: row.jungle_emoji_id,
    midEmojiId: row.mid_emoji_id,
    supportEmojiId: row.support_emoji_id,
    carryEmojiId: row.carry_emoji_id,
    timezone: row.timezone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Column name holding each role's custom emoji ID. */
const EMOJI_COLUMN: Record<Role, string> = {
  solo: 'solo_emoji_id',
  jungle: 'jungle_emoji_id',
  mid: 'mid_emoji_id',
  support: 'support_emoji_id',
  carry: 'carry_emoji_id',
};

export type ConfigField =
  | 'signup_channel_id'
  | 'roster_channel_id'
  | 'review_channel_id'
  | 'ping_role_id'
  | 'authorized_role_ids'
  | 'timezone'
  | (typeof EMOJI_COLUMN)[Role];

export class GuildConfigRepository {
  constructor(private readonly db: Database.Database = getDatabase()) {}

  get(guildId: string): GuildConfig | null {
    const row = this.db
      .prepare('SELECT * FROM guild_config WHERE guild_id = ?')
      .get(guildId) as GuildConfigRow | undefined;
    return row ? hydrate(row) : null;
  }

  /** Create the row if absent so partial configuration can be saved as it happens. */
  ensure(guildId: string): GuildConfig {
    const existing = this.get(guildId);
    if (existing) return existing;

    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO guild_config (guild_id, authorized_role_ids, created_at, updated_at)
         VALUES (?, '[]', ?, ?)`,
      )
      .run(guildId, now, now);
    return this.get(guildId)!;
  }

  /**
   * Persist one field.
   *
   * The config panel commits each select as it changes rather than batching
   * behind a Save button — a Discord message allows only five action rows and a
   * select menu occupies a whole row, so five selects leave nowhere to put one.
   */
  setField(guildId: string, field: ConfigField, value: string | string[] | null): void {
    this.ensure(guildId);
    const stored = Array.isArray(value) ? JSON.stringify(value) : value;
    this.db
      .prepare(`UPDATE guild_config SET ${field} = ?, updated_at = ? WHERE guild_id = ?`)
      .run(stored, Date.now(), guildId);
  }

  setEmoji(guildId: string, role: Role, emojiId: string): void {
    this.setField(guildId, EMOJI_COLUMN[role] as ConfigField, emojiId);
  }

  /** Set all five role emoji at once, as the react-to-bind step completes. */
  setAllEmoji(guildId: string, emojiByRole: Record<Role, string>): void {
    this.ensure(guildId);
    this.db.transaction(() => {
      for (const role of ROLES) {
        this.db
          .prepare(
            `UPDATE guild_config SET ${EMOJI_COLUMN[role]} = ?, updated_at = ? WHERE guild_id = ?`,
          )
          .run(emojiByRole[role], Date.now(), guildId);
      }
    })();
  }

  /** role -> emoji ID, for seeding reactions and matching incoming ones. */
  emojiMap(config: GuildConfig): Partial<Record<Role, string>> {
    return {
      solo: config.soloEmojiId ?? undefined,
      jungle: config.jungleEmojiId ?? undefined,
      mid: config.midEmojiId ?? undefined,
      support: config.supportEmojiId ?? undefined,
      carry: config.carryEmojiId ?? undefined,
    };
  }

  /** Reverse lookup used by the reaction handlers. */
  roleForEmoji(config: GuildConfig, emojiId: string): Role | null {
    for (const role of ROLES) {
      const configured = this.emojiMap(config)[role];
      if (configured && configured === emojiId) return role;
    }
    return null;
  }
}

/**
 * Which required fields are still unset.
 *
 * Because the panel saves field-by-field, a half-configured guild is a normal
 * state rather than an error — so callers must check completeness, not mere
 * existence of the row, before letting anyone create a pickup.
 */
export function missingConfigFields(config: GuildConfig | null): string[] {
  if (!config) return ['everything — run `/pickup config` first'];

  const missing: string[] = [];
  if (!config.signupChannelId) missing.push('signup channel');
  if (!config.rosterChannelId) missing.push('roster channel');
  if (!config.reviewChannelId) missing.push('staff review channel');
  if (config.authorizedRoleIds.length === 0) missing.push('authorized staff roles');
  if (!config.soloEmojiId) missing.push('Solo emoji');
  if (!config.jungleEmojiId) missing.push('Jungle emoji');
  if (!config.midEmojiId) missing.push('Mid emoji');
  if (!config.supportEmojiId) missing.push('Support emoji');
  if (!config.carryEmojiId) missing.push('Carry emoji');
  return missing;
}

export function isConfigComplete(config: GuildConfig | null): boolean {
  return missingConfigFields(config).length === 0;
}
