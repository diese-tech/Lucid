/**
 * Interaction routing.
 *
 * Every button, select and modal in Lucid resolves through here by decoding its
 * custom ID. Nothing is looked up in memory, so a control clicked long after a
 * redeploy behaves exactly like one clicked a second after it was rendered.
 */

import { MessageFlags } from 'discord.js';
import type { Interaction } from 'discord.js';
import { Action, decodeId } from './ids.js';
import { handleConfigAutocomplete, handleConfigCommand, handleConfigComponent } from './flows/config.js';
import { handleCreateCommand, handleCreateComponent, handleCreateModal } from './flows/create.js';
import { handleReviewComponent } from './flows/review.js';
import { handleReplaceComponent, handleReplaceModal } from './flows/replace.js';
import { handleCancelCommand, handleCancelComponent } from './flows/cancel.js';

/** Which flow module owns each action prefix. */
const CREATE_ACTIONS = new Set<string>([
  Action.CreateFormat,
  Action.CreateRoleLimit,
  Action.CreateOpenDetails,
  Action.CreateDetailsModal,
  Action.CreatePost,
  Action.CreatePostAnyway,
  Action.CreateEdit,
  Action.CreateCancel,
]);

const CONFIG_ACTIONS = new Set<string>([
  Action.ConfigChannel,
  Action.ConfigRole,
  Action.ConfigBindEmoji,
]);

const REVIEW_ACTIONS = new Set<string>([
  Action.Shuffle,
  Action.EditRoster,
  Action.Publish,
  Action.PublishConfirm,
  Action.PublishBack,
  Action.EditSwap,
  Action.EditChangeRole,
  Action.EditReplaceSlot,
  Action.EditPickSlot,
  Action.EditPickTarget,
  Action.EditBack,
]);

const REPLACE_ACTIONS = new Set<string>([
  Action.Replace,
  Action.ReplacePickSlot,
  Action.ReplacePickBench,
  Action.ReplaceSearch,
  Action.ReplaceSearchModal,
  Action.ReplacePickCandidate,
  Action.ReplaceConfirm,
]);

const CANCEL_ACTIONS = new Set<string>([Action.Cancel, Action.CancelPick, Action.CancelConfirm]);

export async function routeInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'pickup') await handleConfigAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'pickup') return;
      const sub = interaction.options.getSubcommand();
      if (sub === 'create') await handleCreateCommand(interaction);
      else if (sub === 'config') await handleConfigCommand(interaction);
      else if (sub === 'cancel') await handleCancelCommand(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      const decoded = decodeId(interaction.customId);
      if (!decoded) return;
      if (decoded.action === Action.ReplaceSearchModal) {
        await handleReplaceModal(interaction, decoded);
      } else if (CREATE_ACTIONS.has(decoded.action)) {
        await handleCreateModal(interaction, decoded);
      }
      return;
    }

    if (interaction.isMessageComponent()) {
      const decoded = decodeId(interaction.customId);
      if (!decoded) return;

      if (CREATE_ACTIONS.has(decoded.action)) await handleCreateComponent(interaction, decoded);
      else if (CONFIG_ACTIONS.has(decoded.action)) await handleConfigComponent(interaction, decoded);
      else if (REVIEW_ACTIONS.has(decoded.action)) await handleReviewComponent(interaction, decoded);
      else if (REPLACE_ACTIONS.has(decoded.action)) await handleReplaceComponent(interaction, decoded);
      else if (CANCEL_ACTIONS.has(decoded.action)) await handleCancelComponent(interaction, decoded);
      return;
    }
  } catch (error) {
    console.error('Interaction handler failed:', error);
    // Never leave the user staring at "This interaction failed" with no
    // explanation if we can still get a message to them.
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: 'Something went wrong handling that action.', flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
  }
}
