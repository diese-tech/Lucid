/**
 * Reaction handling for the public signup post.
 *
 * Players sign up by reacting to the signup message with the guild's configured
 * role emoji. There is no command and no form — the reaction IS the signup, and
 * removing it IS the withdrawal. Everything below exists to translate those two
 * gateway events into Signup rows without ever letting a bad event take the
 * process down.
 */

import type {
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from 'discord.js';
import { GuildConfigRepository } from '../../db/repositories/guild-config.js';
import { PickupRepository } from '../../db/repositories/pickups.js';
import { SignupRepository } from '../../db/repositories/signups.js';
import type { Pickup } from '../../db/repositories/types.js';
import type { SignupRole } from '../../domain/roles.js';
import { SIGNUP_ROLE_LABELS } from '../../domain/roles.js';
import { isMemberEligible } from '../eligibility.js';
import { roleLimitPhrase } from '../render.js';
import { evaluateRosterReady, refreshControlCard } from './review.js';

interface ResolvedReaction {
  pickup: Pickup;
  role: SignupRole;
  userId: string;
}

/**
 * Fill in partial structures.
 *
 * Discord delivers reactions on messages the bot hasn't cached (anything posted
 * before the last restart) as partials, which carry almost nothing but IDs.
 * The fetch can fail outright when the message was deleted in the meantime, so
 * a failure here means "there is nothing to act on", not "something is broken".
 */
async function hydratePartials(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<boolean> {
  try {
    if (reaction.partial) await reaction.fetch();
    if (user.partial) await user.fetch();
    return true;
  } catch {
    return false;
  }
}

/**
 * Work out which pickup and role a reaction refers to, or return null.
 *
 * Every "return null" below is a deliberate silent no-op. A reaction on an
 * unrelated message, a reaction with an emoji this guild never configured, or a
 * reaction on a finished pickup are all ordinary things for people to do, and
 * none of them deserves an error message.
 */
function resolveReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): ResolvedReaction | null {
  const pickup = new PickupRepository().bySignupMessageId(reaction.message.id);
  if (!pickup) return null;

  // A cancelled or already-published post is dead. Late reactions on it must
  // not accumulate signups that nobody will ever look at, and must never
  // reopen a roster that staff already sent to players.
  if (pickup.status === 'cancelled' || pickup.status === 'published') return null;

  const configs = new GuildConfigRepository();
  const config = configs.get(pickup.guildId);
  if (!config) return null;

  // Unicode emoji have no ID, so they can never match a configured custom
  // emoji. They are inert: no signup row, no error, and — importantly — the
  // reaction is left exactly where the player put it. Lucid does not police
  // what people react with, it only listens for the configured icons it seeded.
  const emojiId = reaction.emoji.id;
  if (!emojiId) return null;

  const role = configs.roleForEmoji(config, emojiId);
  if (!role) return null;

  return { pickup, role, userId: user.id };
}

/** Best-effort courtesy DM. Closed DMs are normal and must never break a handler. */
async function tryDirectMessage(user: User | PartialUser, content: string): Promise<void> {
  try {
    await user.send(content);
  } catch {
    // Player has DMs closed, or shares no mutual server setting that allows it.
    // The removed reaction is the real feedback; the DM is a bonus.
  }
}

export async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  try {
    // Lucid seeds the configured role reactions itself. Ignoring bots stops
    // those seeded reactions from being read back as five phantom signups.
    if (user.bot) return;
    if (!(await hydratePartials(reaction, user))) return;
    if (user.bot) return;

    const resolved = resolveReaction(reaction, user);
    if (!resolved) return;

    const { pickup, role, userId } = resolved;

    // ELIGIBILITY IS CHECKED BEFORE THE ROW IS EVER WRITTEN, not filtered out
    // afterwards. An ineligible reaction must never become a Signup — it would
    // otherwise sit in the database looking like a real signup to anything that
    // doesn't specifically re-filter by eligibility, and it would need its own
    // cleanup path if the player later regains the role and reacts again
    // (still an "over_limit"/"duplicate" collision waiting to happen).
    if (pickup.eligibilityRoleId) {
      const guild = reaction.message.guild;
      const eligible = guild ? await isMemberEligible(guild, userId, pickup.eligibilityRoleId) : false;
      if (!eligible) {
        // Track whether the removal actually succeeded — without Manage
        // Messages we can't pull the reaction back, and the DM must not claim
        // it was removed when it visibly wasn't; that would tell the player
        // their still-present reaction is safe to ignore.
        let removed = true;
        try {
          await reaction.users.remove(userId);
        } catch (error) {
          removed = false;
          console.error('[signups] could not remove ineligible reaction', error);
        }
        await tryDirectMessage(
          user,
          removed
            ? `You need <@&${pickup.eligibilityRoleId}> to sign up for that pickup, so your reaction was removed.`
            : `You need <@&${pickup.eligibilityRoleId}> to sign up for that pickup. Lucid could not remove your ` +
                'reaction — please remove it yourself; it will not count as a signup.',
        );
        // Nothing was added, so the roster pool didn't change — but the
        // control card must still refresh: if this pickup's eligibility role
        // has been deleted, THIS is the only path that would ever discover
        // that (a successful signup never reaches this branch), and staff
        // need to see that error instead of a stale "normal" readiness card.
        await refreshControlCard(reaction.client, pickup.id);
        return;
      }

      // The member fetch above is a real network wait, not a local check —
      // re-validate what could have changed during it before writing
      // anything. Without this, a pickup cancelled/published mid-wait could
      // still gain a signup, or a player who removed the very reaction we're
      // about to turn into a signup (handleReactionRemove running and
      // finding nothing to delete, since we hadn't inserted yet) would end up
      // with a phantom row despite having no reaction on the message at all.
      const freshPickup = new PickupRepository().byId(pickup.id);
      if (!freshPickup || freshPickup.status !== 'open') return;
      const stillReacting = await reaction.users
        .fetch()
        .then((users) => users.has(userId))
        .catch(() => false);
      if (!stillReacting) return;
    }

    const outcome = new SignupRepository().add(pickup.id, userId, role, pickup.roleLimit);

    if (outcome.status === 'duplicate') {
      // Already signed up for this exact role — nothing changed, so nothing to
      // redraw and nothing to tell anyone.
      return;
    }

    if (outcome.status === 'over_limit') {
      // The player is at their role limit. Remove ONLY the reaction they just
      // added — their earlier choices stand, because the newest click is the
      // one that broke the rule, not the older ones.
      try {
        await reaction.users.remove(userId);
      } catch (error) {
        // Removing someone else's reaction needs Manage Messages. If Lucid
        // doesn't have it the DM below is the player's only feedback, so we
        // still send it rather than bailing out here.
        console.error('[signups] could not remove over-limit reaction', error);
      }
      await tryDirectMessage(
        user,
        `You can only sign up for **${roleLimitPhrase(outcome.limit)}** on that pickup. ` +
          `Remove one of your current role reactions if you'd rather play ${SIGNUP_ROLE_LABELS[role]}.`,
      );
      return;
    }

    // Signup recorded. Check whether this was the reaction that completed the
    // roster, then keep the staff card's signup count honest.
    await evaluateRosterReady(reaction.client, pickup.id);
    await refreshControlCard(reaction.client, pickup.id);
  } catch (error) {
    // A throw inside a gateway event handler is an unhandled rejection, which
    // takes the whole process down. One bad reaction must never do that.
    console.error('[signups] reaction add failed', error);
  }
}

export async function handleReactionRemove(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  try {
    if (user.bot) return;
    if (!(await hydratePartials(reaction, user))) return;
    if (user.bot) return;

    const resolved = resolveReaction(reaction, user);
    if (!resolved) return;

    const { pickup, role, userId } = resolved;
    new SignupRepository().remove(pickup.id, userId, role);

    // Removing a signup can matter in two different ways: before a draft
    // exists it can un-fill the roster, and after one exists it can leave a
    // rostered player with no signup behind them. evaluateRosterReady handles
    // both cases, so the two flows do not need to be told apart here.
    await evaluateRosterReady(reaction.client, pickup.id);
    await refreshControlCard(reaction.client, pickup.id);
  } catch (error) {
    console.error('[signups] reaction remove failed', error);
  }
}
