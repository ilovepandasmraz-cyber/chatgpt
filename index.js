// index.js - Fully customizable Discord ticket system using discord.js v14
// Setup:
// 1) npm install discord.js dotenv
// 2) Create .env with DISCORD_TOKEN=...\nCLIENT_ID=...\nGUILD_ID=...
// 3) node index.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionsBitField,
  REST,
  RoleSelectMenuBuilder,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'config.json');

// -----------------------------
// Config handling
// -----------------------------
const defaultConfig = {
  categoryId: null,
  logChannelId: null,
  panelChannelId: null,
  panelMessageId: null,
  namingScheme: 'ticket-<user>',
  counters: { tickets: 1 },
  staffRoles: [],
  adminRoles: [],
  manageRoles: [],
  ticketTypes: [],
  embed: {
    title: 'Support Tickets',
    description: 'Click a button below to open a ticket.',
    color: '#2b2d31',
    footer: 'We will assist you shortly',
    thumbnail: '',
    image: '',
  },
  logging: {
    opened: true,
    closed: true,
    renamed: true,
    claimed: true,
    members: true,
    closeRequest: true,
  },
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return { ...defaultConfig, ...data, counters: data.counters || { tickets: 1 } };
    }
  } catch (err) {
    console.error('Failed to load config', err);
  }
  return { ...defaultConfig };
}

let config = loadConfig();

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Failed to save config', err);
  }
}

// -----------------------------
// Discord client + commands
// -----------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
});

const commands = [
  new SlashCommandBuilder().setName('ticket-config').setDescription('Open the interactive ticket config dashboard.'),
  new SlashCommandBuilder()
    .setName('ticket-setup')
    .setDescription('Create or update the ticket panel message.')
    .addChannelOption((o) => o.setName('channel').setDescription('Channel override for the panel')),
  new SlashCommandBuilder()
    .setName('ticket-add')
    .setDescription('Add a member to this ticket channel')
    .addUserOption((o) => o.setName('user').setDescription('User to add').setRequired(true)),
  new SlashCommandBuilder()
    .setName('ticket-remove')
    .setDescription('Remove a member from this ticket channel')
    .addUserOption((o) => o.setName('user').setDescription('User to remove').setRequired(true)),
  new SlashCommandBuilder().setName('ticket-request').setDescription('Request the opener to close the ticket'),
  new SlashCommandBuilder()
    .setName('ticket-rename')
    .setDescription('Rename this ticket channel')
    .addStringOption((o) => o.setName('name').setDescription('New channel name').setRequired(true)),
  new SlashCommandBuilder().setName('ticket-claim').setDescription('Claim this ticket'),
  new SlashCommandBuilder().setName('ticket-unclaim').setDescription('Unclaim this ticket'),
  new SlashCommandBuilder().setName('ticket-close').setDescription('Close this ticket'),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands', err);
  }
}

// -----------------------------
// Utilities
// -----------------------------
function isAdmin(member) {
  return (
    member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    config.adminRoles.some((r) => member.roles.cache.has(r))
  );
}

function isStaff(member) {
  return (
    member.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
    config.staffRoles.some((r) => member.roles.cache.has(r)) ||
    config.manageRoles.some((r) => member.roles.cache.has(r))
  );
}

function enforceAdmin(interaction) {
  if (!isAdmin(interaction.member)) {
    interaction.reply({ content: 'Only admins can adjust configuration.', ephemeral: true }).catch(() => null);
    return false;
  }
  return true;
}

function basePermissionOverwrites(member) {
  const overwrites = [
    { id: member.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: member.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
        PermissionsBitField.Flags.ManageChannels,
      ],
    },
  ];
  config.staffRoles.concat(config.manageRoles).forEach((roleId) => {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    });
  });
  return overwrites;
}

function buildConfigEmbed() {
  const ticketTypeSummary = config.ticketTypes.length
    ? config.ticketTypes
        .map(
          (t, i) =>
            `${i + 1}. ${t.emoji ? `${t.emoji} ` : ''}${t.label} (ID: ${t.id})${
              t.pingRole ? ` → <@&${t.pingRole}>` : ''
            }`
        )
        .join('\n')
    : 'No ticket types configured.';

  return new EmbedBuilder()
    .setTitle('Ticket Config Dashboard')
    .setColor(config.embed.color || '#2b2d31')
    .setDescription('Use the buttons below to edit settings. Changes save instantly.')
    .addFields(
      {
        name: 'General',
        value: `Category: ${config.categoryId ? `<#${config.categoryId}>` : '`Not set`'}\nLog: ${
          config.logChannelId ? `<#${config.logChannelId}>` : '`Not set`'
        }\nNaming: \`${config.namingScheme}\``,
        inline: false,
      },
      {
        name: 'Panel',
        value: `Panel channel: ${config.panelChannelId ? `<#${config.panelChannelId}>` : '`Not set`'}\nEmbed title: **${
          config.embed.title || 'Not set'
        }**`,
        inline: false,
      },
      {
        name: 'Access',
        value: `Staff roles: ${config.staffRoles.length ? config.staffRoles.map((r) => `<@&${r}>`).join(', ') : '`None`'}\nAdmin roles: ${
          config.adminRoles.length ? config.adminRoles.map((r) => `<@&${r}>`).join(', ') : '`None`'
        }\nManagers: ${
          config.manageRoles.length ? config.manageRoles.map((r) => `<@&${r}>`).join(', ') : '`None`'
        }`,
        inline: false,
      },
      { name: 'Ticket Types', value: ticketTypeSummary, inline: false },
      {
        name: 'Logging',
        value: Object.entries(config.logging)
          .map(([k, v]) => `${v ? '✅' : '❌'} ${k}`)
          .join(' • '),
        inline: false,
      }
    )
    .setFooter({ text: 'Use Preview Panel to see the live ticket panel embed.' });
}

function mainDashboardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg_general').setLabel('General Settings').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg_panel').setLabel('Panel Settings').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg_permissions').setLabel('Permissions').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg_logging').setLabel('Logging').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg_preview').setLabel('Preview Panel').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cfg_raw').setLabel('View Raw Config').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function embedFromConfig() {
  const embed = new EmbedBuilder()
    .setTitle(config.embed.title)
    .setDescription(config.embed.description)
    .setColor(config.embed.color || '#2b2d31');
  if (config.embed.footer) embed.setFooter({ text: config.embed.footer });
  if (config.embed.thumbnail) embed.setThumbnail(config.embed.thumbnail);
  if (config.embed.image) embed.setImage(config.embed.image);
  return embed;
}

function ticketButtons() {
  const rows = [];
  let current = new ActionRowBuilder();
  config.ticketTypes.forEach((t) => {
    if (current.components.length === 5) {
      rows.push(current);
      current = new ActionRowBuilder();
    }
    current.addComponents(
      new ButtonBuilder()
        .setCustomId(`open_ticket:${t.id}`)
        .setLabel(t.label)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(t.emoji || null)
    );
  });
  if (current.components.length) rows.push(current);
  return rows;
}

function logEvent(guild, title, fields = [], color = '#2b2d31') {
  if (!config.logChannelId) return;
  const channel = guild.channels.cache.get(config.logChannelId);
  if (!channel) return;
  const embed = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp();
  if (fields.length) embed.addFields(fields);
  channel.send({ embeds: [embed] }).catch(() => null);
}

// -----------------------------
// Ticket helpers
// -----------------------------
const ticketData = new Map(); // channelId -> data

async function createTicket(interaction, typeId) {
  const type = config.ticketTypes.find((t) => t.id === typeId);
  if (!type) return interaction.reply({ content: 'This ticket type is not available.', ephemeral: true });
  if (!config.categoryId) return interaction.reply({ content: 'Ticket category is not configured yet.', ephemeral: true });

  const guild = interaction.guild;
  const name = config.namingScheme
    .replace('<user>', interaction.user.username.toLowerCase())
    .replace('<type>', type.id)
    .replace('<number>', config.counters.tickets);

  config.counters.tickets += 1;
  saveConfig();

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: config.categoryId,
    permissionOverwrites: basePermissionOverwrites(interaction.member),
  });

  const ping = type.pingRole ? `<@&${type.pingRole}>` : '';
  await channel.send({
    content: `${interaction.user} opened a ticket for **${type.label}** ${ping}`,
    embeds: [new EmbedBuilder().setColor('#2b2d31').setDescription('Staff will be with you shortly.')],
  });

  ticketData.set(channel.id, {
    openerId: interaction.user.id,
    typeId: type.id,
    createdAt: Date.now(),
    claimedBy: null,
  });

  if (config.logging.opened) {
    logEvent(
      guild,
      'Ticket Opened',
      [
        { name: 'Channel', value: channel.toString(), inline: true },
        { name: 'Opened by', value: interaction.user.toString(), inline: true },
        { name: 'Type', value: type.label, inline: true },
      ],
      '#2ecc71'
    );
  }

  return interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });
}

async function closeTicket(interaction, reason = 'Closed') {
  const data = ticketData.get(interaction.channel.id);
  if (!data) return interaction.reply({ content: 'This channel is not tracked as a ticket.', ephemeral: true });

  const duration = Math.round((Date.now() - data.createdAt) / 1000);
  const embed = new EmbedBuilder()
    .setTitle('Ticket Closed')
    .setColor('#e67e22')
    .addFields(
      { name: 'Closed by', value: interaction.user.toString(), inline: true },
      { name: 'Reason', value: reason, inline: true },
      { name: 'Duration', value: `${duration}s`, inline: true }
    )
    .setTimestamp();

  await interaction.channel.send({ embeds: [embed] });

  if (config.logging.closed) {
    const type = config.ticketTypes.find((t) => t.id === data.typeId);
    logEvent(
      interaction.guild,
      'Ticket Closed',
      [
        { name: 'Channel', value: interaction.channel.toString(), inline: true },
        { name: 'Opened by', value: `<@${data.openerId}>`, inline: true },
        { name: 'Closed by', value: interaction.user.toString(), inline: true },
        { name: 'Type', value: type ? type.label : data.typeId, inline: true },
        { name: 'Duration', value: `${duration}s`, inline: true },
      ],
      '#e67e22'
    );
  }

  ticketData.delete(interaction.channel.id);
  setTimeout(() => interaction.channel.delete().catch(() => null), 4000);
}

// -----------------------------
// Dashboard helpers
// -----------------------------
async function sendDashboard(interaction, ephemeral = true) {
  const embed = buildConfigEmbed();
  await interaction.reply({ ephemeral, embeds: [embed], components: mainDashboardComponents() });
}

async function updateDashboard(interaction) {
  const embed = buildConfigEmbed();
  await interaction.update({ embeds: [embed], components: mainDashboardComponents() });
}

// -----------------------------
// Client event handlers
// -----------------------------
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      if (commandName === 'ticket-config') {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: 'You need Manage Server or an admin role.', ephemeral: true });
        return sendDashboard(interaction);
      }

      if (commandName === 'ticket-setup') {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', ephemeral: true });
        if (!config.panelChannelId && !interaction.options.getChannel('channel'))
          return interaction.reply({ content: 'Set a panel channel first with the config dashboard.', ephemeral: true });

        const panelChannel = interaction.options.getChannel('channel') || interaction.guild.channels.cache.get(config.panelChannelId);
        if (!panelChannel || panelChannel.type !== ChannelType.GuildText)
          return interaction.reply({ content: 'Panel channel must be a text channel.', ephemeral: true });

        const panelEmbed = embedFromConfig();
        const components = ticketButtons();
        if (!components.length) return interaction.reply({ content: 'Add at least one ticket type first.', ephemeral: true });

        if (config.panelMessageId) {
          try {
            const msg = await panelChannel.messages.fetch(config.panelMessageId);
            await msg.edit({ embeds: [panelEmbed], components });
            await interaction.reply({ content: 'Ticket panel updated.', ephemeral: true });
            return;
          } catch (err) {
            console.warn('Failed to edit previous panel, sending new one.', err);
          }
        }

        const sent = await panelChannel.send({ embeds: [panelEmbed], components });
        config.panelChannelId = panelChannel.id;
        config.panelMessageId = sent.id;
        saveConfig();
        return interaction.reply({ content: 'Ticket panel posted.', ephemeral: true });
      }

      if (commandName === 'ticket-add') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const user = interaction.options.getUser('user', true);
        await interaction.channel.permissionOverwrites.edit(user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          EmbedLinks: true,
        });
        await interaction.reply({ content: `${user} has been added to the ticket.`, ephemeral: true });
        if (config.logging.members) {
          logEvent(
            interaction.guild,
            'Member Added to Ticket',
            [
              { name: 'Channel', value: interaction.channel.toString(), inline: true },
              { name: 'Member', value: user.toString(), inline: true },
              { name: 'By', value: interaction.user.toString(), inline: true },
            ],
            '#3498db'
          );
        }
        return;
      }

      if (commandName === 'ticket-remove') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const user = interaction.options.getUser('user', true);
        await interaction.channel.permissionOverwrites.delete(user.id).catch(() => null);
        await interaction.reply({ content: `${user} has been removed from the ticket.`, ephemeral: true });
        if (config.logging.members) {
          logEvent(
            interaction.guild,
            'Member Removed from Ticket',
            [
              { name: 'Channel', value: interaction.channel.toString(), inline: true },
              { name: 'Member', value: user.toString(), inline: true },
              { name: 'By', value: interaction.user.toString(), inline: true },
            ],
            '#e74c3c'
          );
        }
        return;
      }

      if (commandName === 'ticket-request') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const data = ticketData.get(interaction.channel.id);
        if (!data) return interaction.reply({ content: 'Not a tracked ticket channel.', ephemeral: true });
        const opener = await interaction.guild.members.fetch(data.openerId).catch(() => null);
        if (!opener) return interaction.reply({ content: 'Could not find the opener.', ephemeral: true });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('close_accept').setLabel('✅ Close Ticket').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('close_decline').setLabel('❌ Keep Open').setStyle(ButtonStyle.Secondary)
        );

        await interaction.channel.send({ content: `${opener}, staff requested to close this ticket.`, components: [row] });
        await interaction.reply({ content: 'Close request sent.', ephemeral: true });
        if (config.logging.closeRequest) {
          logEvent(
            interaction.guild,
            'Close Requested',
            [
              { name: 'Channel', value: interaction.channel.toString(), inline: true },
              { name: 'By', value: interaction.user.toString(), inline: true },
              { name: 'Opener', value: opener.toString(), inline: true },
            ],
            '#f1c40f'
          );
        }
        return;
      }

      if (commandName === 'ticket-rename') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const oldName = interaction.channel.name;
        const newName = interaction.options.getString('name', true);
        await interaction.channel.setName(newName);
        await interaction.reply({ content: `Channel renamed to ${newName}.`, ephemeral: true });
        if (config.logging.renamed) {
          logEvent(
            interaction.guild,
            'Ticket Renamed',
            [
              { name: 'Channel', value: interaction.channel.toString(), inline: true },
              { name: 'Old Name', value: oldName, inline: true },
              { name: 'New Name', value: newName, inline: true },
              { name: 'By', value: interaction.user.toString(), inline: true },
            ],
            '#9b59b6'
          );
        }
        return;
      }

      if (commandName === 'ticket-claim') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const data = ticketData.get(interaction.channel.id);
        if (!data) return interaction.reply({ content: 'Not a tracked ticket channel.', ephemeral: true });
        data.claimedBy = interaction.user.id;
        await interaction.reply({ content: `${interaction.user} claimed this ticket.`, ephemeral: true });
        await interaction.channel.send({ content: `${interaction.user} is handling this ticket.` });
        if (config.logging.claimed) {
          logEvent(
            interaction.guild,
            'Ticket Claimed',
            [
              { name: 'Channel', value: interaction.channel.toString(), inline: true },
              { name: 'By', value: interaction.user.toString(), inline: true },
            ],
            '#1abc9c'
          );
        }
        return;
      }

      if (commandName === 'ticket-unclaim') {
        const data = ticketData.get(interaction.channel.id);
        if (!data) return interaction.reply({ content: 'Not a tracked ticket channel.', ephemeral: true });
        if (data.claimedBy && data.claimedBy !== interaction.user.id && !isStaff(interaction.member))
          return interaction.reply({ content: 'Only the claimer or staff can unclaim.', ephemeral: true });
        data.claimedBy = null;
        await interaction.reply({ content: 'Ticket unclaimed.', ephemeral: true });
        await interaction.channel.send({ content: `${interaction.user} unclaimed this ticket.` });
        if (config.logging.claimed) {
          logEvent(
            interaction.guild,
            'Ticket Unclaimed',
            [
              { name: 'Channel', value: interaction.channel.toString(), inline: true },
              { name: 'By', value: interaction.user.toString(), inline: true },
            ],
            '#95a5a6'
          );
        }
        return;
      }

      if (commandName === 'ticket-close') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        return closeTicket(interaction, 'Closed via command');
      }
  } else if (interaction.isButton()) {
      const configIds = ['cfg_', 'set_', 'toggle_', 'add_type', 'edit_embed'];
      if (configIds.some((prefix) => interaction.customId.startsWith(prefix))) {
        if (!enforceAdmin(interaction)) return;
      }
      if (interaction.customId.startsWith('open_ticket:')) {
        const typeId = interaction.customId.split(':')[1];
        return createTicket(interaction, typeId);
      }

      if (interaction.customId === 'cfg_preview') {
        const previewEmbed = embedFromConfig();
        return interaction.reply({ ephemeral: true, content: 'Panel preview', embeds: [previewEmbed] });
      }

      if (interaction.customId === 'cfg_raw') {
        return interaction.reply({
          ephemeral: true,
          content: '```json\n' + JSON.stringify(config, null, 2) + '\n```',
        });
      }

      if (interaction.customId === 'cfg_general') {
        const rows = [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId('set_category')
              .setPlaceholder('Select ticket category')
              .setChannelTypes(ChannelType.GuildCategory)
          ),
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId('set_log')
              .setPlaceholder('Select log channel')
              .setChannelTypes(ChannelType.GuildText)
          ),
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId('set_staff').setPlaceholder('Set staff roles (multi)').setMinValues(0)
          ),
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId('set_admin').setPlaceholder('Set admin roles (multi)').setMinValues(0)
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_naming').setStyle(ButtonStyle.Primary).setLabel('Edit naming pattern')
          ),
        ];
        return interaction.reply({
          ephemeral: true,
          content: 'General settings: select options below. Naming supports `<user>`, `<type>`, `<number>`.',
          components: rows,
        });
      }

      if (interaction.customId === 'cfg_panel') {
        const removeOptions = config.ticketTypes.map((t) => ({ label: t.label, value: t.id, description: t.id }));
        const rows = [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId('set_panel_channel')
              .setPlaceholder('Select panel channel')
              .setChannelTypes(ChannelType.GuildText)
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('edit_embed').setStyle(ButtonStyle.Secondary).setLabel('Edit panel embed'),
            new ButtonBuilder().setCustomId('add_type').setStyle(ButtonStyle.Primary).setLabel('Add ticket type')
          ),
        ];
        if (removeOptions.length) {
          rows.push(
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('remove_type')
                .setPlaceholder('Remove ticket type')
                .addOptions(removeOptions)
            )
          );
        }
        return interaction.reply({
          ephemeral: true,
          content: 'Panel settings: choose channel, edit embed, manage ticket types.',
          components: rows,
        });
      }

      if (interaction.customId === 'cfg_permissions') {
        const rows = [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId('set_manage')
              .setPlaceholder('Roles allowed to manage tickets (multi)')
              .setMinValues(0)
          ),
        ];
        return interaction.reply({ ephemeral: true, content: 'Select manager roles.', components: rows });
      }

      if (interaction.customId === 'cfg_logging') {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('toggle_opened')
            .setLabel(`Opened: ${config.logging.opened ? 'On' : 'Off'}`)
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('toggle_closed')
            .setLabel(`Closed: ${config.logging.closed ? 'On' : 'Off'}`)
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('toggle_renamed')
            .setLabel(`Renamed: ${config.logging.renamed ? 'On' : 'Off'}`)
            .setStyle(ButtonStyle.Secondary)
        );
        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('toggle_claimed')
            .setLabel(`Claim: ${config.logging.claimed ? 'On' : 'Off'}`)
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('toggle_members')
            .setLabel(`Members: ${config.logging.members ? 'On' : 'Off'}`)
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('toggle_closeRequest')
            .setLabel(`Close Request: ${config.logging.closeRequest ? 'On' : 'Off'}`)
            .setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({ ephemeral: true, content: 'Toggle logging events.', components: [row, row2] });
      }

      if (interaction.customId === 'close_accept') {
        const data = ticketData.get(interaction.channel.id);
        if (!data || interaction.user.id !== data.openerId)
          return interaction.reply({ content: 'Only the opener can confirm closure.', ephemeral: true });
        await interaction.update({ content: 'Closing ticket...', components: [] });
        return closeTicket(interaction, 'Closed after close request');
      }

      if (interaction.customId === 'close_decline') {
        const data = ticketData.get(interaction.channel.id);
        if (!data || interaction.user.id !== data.openerId)
          return interaction.reply({ content: 'Only the opener can respond.', ephemeral: true });
        await interaction.update({ content: 'Ticket will remain open.', components: [] });
        if (config.logging.closeRequest) {
          logEvent(
            interaction.guild,
            'Close Request Declined',
            [
              { name: 'Channel', value: interaction.channel.toString(), inline: true },
              { name: 'By', value: interaction.user.toString(), inline: true },
            ],
            '#f1c40f'
          );
        }
        return;
      }
    } else if (interaction.isChannelSelectMenu()) {
      if (!enforceAdmin(interaction)) return;
      const selected = interaction.values[0];
      if (interaction.customId === 'set_category') {
        config.categoryId = selected;
        saveConfig();
        return interaction.reply({ content: `Category set to <#${selected}>`, ephemeral: true });
      }
      if (interaction.customId === 'set_log') {
        config.logChannelId = selected;
        saveConfig();
        return interaction.reply({ content: `Log channel set to <#${selected}>`, ephemeral: true });
      }
      if (interaction.customId === 'set_panel_channel') {
        config.panelChannelId = selected;
        saveConfig();
        return interaction.reply({ content: `Panel channel set to <#${selected}>`, ephemeral: true });
      }
    } else if (interaction.isRoleSelectMenu()) {
      if (!enforceAdmin(interaction)) return;
      const selections = interaction.values;
      if (interaction.customId === 'set_staff') {
        config.staffRoles = selections;
        saveConfig();
        return interaction.reply({ content: 'Updated staff roles.', ephemeral: true });
      }
      if (interaction.customId === 'set_admin') {
        config.adminRoles = selections;
        saveConfig();
        return interaction.reply({ content: 'Updated admin roles.', ephemeral: true });
      }
      if (interaction.customId === 'set_manage') {
        config.manageRoles = selections;
        saveConfig();
        return interaction.reply({ content: 'Updated manager roles.', ephemeral: true });
      }
    } else if (interaction.isStringSelectMenu()) {
      if (!enforceAdmin(interaction)) return;
      if (interaction.customId === 'remove_type') {
        const id = interaction.values[0];
        config.ticketTypes = config.ticketTypes.filter((t) => t.id !== id);
        saveConfig();
        return interaction.reply({ content: `Removed ticket type ${id}.`, ephemeral: true });
      }
    } else if (interaction.isModalSubmit()) {
      if (!enforceAdmin(interaction)) return;
      if (interaction.customId === 'modal_naming') {
        const pattern = interaction.fields.getTextInputValue('naming_input');
        config.namingScheme = pattern;
        saveConfig();
        await interaction.reply({ content: `Naming pattern set to \`${pattern}\`.`, ephemeral: true });
        return;
      }
      if (interaction.customId === 'modal_embed') {
        config.embed.title = interaction.fields.getTextInputValue('title_input');
        config.embed.description = interaction.fields.getTextInputValue('desc_input');
        config.embed.color = interaction.fields.getTextInputValue('color_input') || '#2b2d31';
        config.embed.footer = interaction.fields.getTextInputValue('footer_input');
        config.embed.thumbnail = interaction.fields.getTextInputValue('thumb_input');
        config.embed.image = interaction.fields.getTextInputValue('image_input');
        saveConfig();
        await interaction.reply({ content: 'Embed updated.', ephemeral: true });
        return;
      }
      if (interaction.customId === 'modal_type') {
        const id = interaction.fields.getTextInputValue('type_id');
        const label = interaction.fields.getTextInputValue('type_label');
        const emoji = interaction.fields.getTextInputValue('type_emoji');
        const pingRole = interaction.fields.getTextInputValue('type_ping');
        const existing = config.ticketTypes.find((t) => t.id === id);
        if (existing) {
          existing.label = label;
          existing.emoji = emoji || null;
          existing.pingRole = pingRole || null;
        } else {
          config.ticketTypes.push({ id, label, emoji: emoji || null, pingRole: pingRole || null });
        }
        saveConfig();
        await interaction.reply({ content: `Saved ticket type **${label}** (${id}).`, ephemeral: true });
        return;
      }
    }
  } catch (err) {
    console.error('Interaction error', err);
    if (!interaction.replied) interaction.reply({ content: 'Something went wrong.', ephemeral: true });
  }
});

client.on('messageCreate', () => {}); // placeholder to keep message intent used

client.login(process.env.DISCORD_TOKEN);

// -----------------------------
// Modal builders (invoked by buttons)
// -----------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const configButtons = ['set_naming', 'edit_embed', 'add_type', 'toggle_', 'cfg_'];
  if (configButtons.some((prefix) => interaction.customId.startsWith(prefix))) {
    if (!enforceAdmin(interaction)) return;
  }
  if (interaction.customId === 'set_naming') {
    const modal = new ModalBuilder().setCustomId('modal_naming').setTitle('Ticket Naming Pattern');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('naming_input')
          .setLabel('Pattern (<user>, <type>, <number>)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(config.namingScheme)
      )
    );
    return interaction.showModal(modal);
  }
  if (interaction.customId === 'edit_embed') {
    const modal = new ModalBuilder().setCustomId('modal_embed').setTitle('Edit Panel Embed');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('title_input')
          .setLabel('Title')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(config.embed.title)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('desc_input')
          .setLabel('Description')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setValue(config.embed.description)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('color_input')
          .setLabel('Color (hex)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(config.embed.color || '#2b2d31')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('footer_input')
          .setLabel('Footer text')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(config.embed.footer || '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('thumb_input')
          .setLabel('Thumbnail URL')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(config.embed.thumbnail || '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('image_input')
          .setLabel('Image URL')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(config.embed.image || '')
      )
    );
    return interaction.showModal(modal);
  }
  if (interaction.customId === 'add_type') {
    const modal = new ModalBuilder().setCustomId('modal_type').setTitle('Add/Update Ticket Type');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('type_id')
          .setLabel('Type ID (no spaces)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('type_label')
          .setLabel('Button label')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('type_emoji')
          .setLabel('Emoji (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('type_ping')
          .setLabel('Ping role ID (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      )
    );
    return interaction.showModal(modal);
  }
  if (
    [
      'toggle_opened',
      'toggle_closed',
      'toggle_renamed',
      'toggle_claimed',
      'toggle_members',
      'toggle_closeRequest',
    ].includes(interaction.customId)
  ) {
    const key = interaction.customId.replace('toggle_', '');
    config.logging[key] = !config.logging[key];
    saveConfig();
    return interaction.reply({ content: `Logging for ${key} set to ${config.logging[key] ? 'on' : 'off'}.`, ephemeral: true });
  }
});

registerCommands();
