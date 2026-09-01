import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

export const helpCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription("Show a quick guide to Lucid's commands.")
  .setDMPermission(false);

function helpEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Lucid Quickstart')
    .setColor(0x5865f2)
    .setDescription('Lucid collects pickup signups, builds valid teams, and gives staff private roster controls.')
    .addFields(
      {
        name: 'Create a pickup',
        value: [
          '`/pickup create`',
          'Choose the game format, signup limit, optional eligibility role, start time, and note. Review the private preview, then post it.',
          'If you already opened another pickup at the same time, Lucid asks you to confirm before creating a separate game.',
        ].join('\n'),
      },
      {
        name: 'Manage a pickup',
        value: [
          '`/pickup cancel` — choose an open pickup and confirm its cancellation.',
          'When enough eligible players react, use the staff review card to **Shuffle**, edit, and **Publish** the roster.',
          'After publication, use **Replace Player** on the public roster when someone drops.',
        ].join('\n'),
      },
      {
        name: 'Configure Lucid',
        value: [
          '`/pickup config`',
          'Admins choose the signup, staff-review, and final-roster channels plus the ping and staff roles. Each selection saves immediately.',
          'Use `bind_emoji:true` to bind the five role icons and optional **Fill** icon. Fill may play any missing role.',
        ].join('\n'),
      },
    );
}

export async function handleHelpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ embeds: [helpEmbed()], flags: MessageFlags.Ephemeral });
}
