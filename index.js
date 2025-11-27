// index.js - Fully customizable Discord ticket system using discord.js v14
// Usage: see instructions in README section below.

// -----------------------------
// Installation & Setup (also echoed in final response):
// 1) npm install discord.js dotenv
// 2) Create .env with DISCORD_TOKEN=...\nCLIENT_ID=...\nGUILD_ID=...
// 3) node index.js
// -----------------------------

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'config.json');

// -----------------------------
// Configuration Handling
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
  ticketTypes: [
    // { id: 'support', label: 'Support', emoji: '🎫', pingRole: null }
  ],
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
    console.error('Failed to read config:', err);
  }
  return { ...defaultConfig };
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

let config = loadConfig();
const tickets = new Map(); // channelId -> ticket data

// -----------------------------
// Discord Client & Command Registration
// -----------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
});

const commands = [
  new SlashCommandBuilder()
    .setName('ticket-config')
    .setDescription('Configure the ticket system (admins only).')
    .addSubcommand((sub) =>
      sub
        .setName('set-general')
        .setDescription('Set general ticket settings (category, log channel, naming, staff/admin roles).')
        .addChannelOption((o) =>
          o
            .setName('category')
            .setDescription('Category where ticket channels will be created')
            .addChannelTypes(ChannelType.GuildCategory)
        )
        .addChannelOption((o) => o.setName('log').setDescription('Channel to send ticket logs to'))
        .addStringOption((o) =>
          o
            .setName('naming')
            .setDescription('Naming scheme: ticket-<user> or <type>-<number>')
            .setMinLength(3)
        )
        .addRoleOption((o) => o.setName('staff_role').setDescription('Add a staff role'))
        .addRoleOption((o) => o.setName('admin_role').setDescription('Add an admin role'))
        .addRoleOption((o) => o.setName('manager_role').setDescription('Role that can manage tickets'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-panel')
        .setDescription('Set ticket panel options and embed appearance.')
        .addChannelOption((o) => o.setName('channel').setDescription('Panel destination channel'))
        .addStringOption((o) => o.setName('title').setDescription('Embed title'))
        .addStringOption((o) => o.setName('description').setDescription('Embed description'))
        .addStringOption((o) => o.setName('color').setDescription('Embed color (hex)'))
        .addStringOption((o) => o.setName('footer').setDescription('Footer text'))
        .addStringOption((o) => o.setName('thumbnail').setDescription('Thumbnail URL'))
        .addStringOption((o) => o.setName('image').setDescription('Image URL'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('add-button')
        .setDescription('Add or update a ticket button type.')
        .addStringOption((o) => o.setName('id').setDescription('Unique ticket type ID').setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Button label').setRequired(true))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji (optional)'))
        .addRoleOption((o) => o.setName('ping_role').setDescription('Role to ping when opened'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove-button')
        .setDescription('Remove a ticket button by ID.')
        .addStringOption((o) => o.setName('id').setDescription('Ticket type ID').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('logging')
        .setDescription('Toggle logging for events.')
        .addStringOption((o) =>
          o
            .setName('event')
            .setDescription('Which event to toggle')
            .setRequired(true)
            .addChoices(
              { name: 'opened', value: 'opened' },
              { name: 'closed', value: 'closed' },
              { name: 'renamed', value: 'renamed' },
              { name: 'claimed', value: 'claimed' },
              { name: 'members', value: 'members' },
              { name: 'closeRequest', value: 'closeRequest' }
            )
        )
        .addBooleanOption((o) => o.setName('enabled').setDescription('Enable or disable this log').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('view').setDescription('View current ticket configuration.')),

  new SlashCommandBuilder()
    .setName('ticket-setup')
    .setDescription('Create or update the ticket panel message.')
    .addChannelOption((o) => o.setName('channel').setDescription('Channel to place the panel')),

  new SlashCommandBuilder()
    .setName('ticket-add')
    .setDescription('Add a member to this ticket channel (staff only).')
    .addUserOption((o) => o.setName('user').setDescription('User to add').setRequired(true)),

  new SlashCommandBuilder()
    .setName('ticket-remove')
    .setDescription('Remove a member from this ticket channel (staff only).')
    .addUserOption((o) => o.setName('user').setDescription('User to remove').setRequired(true)),

  new SlashCommandBuilder()
    .setName('ticket-request')
    .setDescription('Request the opener to close this ticket (staff only).'),

  new SlashCommandBuilder()
    .setName('ticket-rename')
    .setDescription('Rename this ticket channel (staff only).')
    .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true)),

  new SlashCommandBuilder().setName('ticket-claim').setDescription('Claim this ticket (staff only).'),

  new SlashCommandBuilder().setName('ticket-unclaim').setDescription('Unclaim this ticket (staff/claimer).'),

  new SlashCommandBuilder()
    .setName('ticket-close')
    .setDescription('Close and archive this ticket.')
    .addStringOption((o) => o.setName('reason').setDescription('Reason for closing')),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log('Slash commands registered.');
}

// -----------------------------
// Utility Functions
// -----------------------------
function isAdmin(member) {
  return (
    member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    member.roles.cache.some((r) => config.adminRoles.includes(r.id))
  );
}

function isStaff(member) {
  return (
    member.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
    member.roles.cache.some((r) => config.staffRoles.includes(r.id) || config.manageRoles.includes(r.id)) ||
    isAdmin(member)
  );
}

function buildPanelEmbed() {
  const e = new EmbedBuilder()
    .setTitle(config.embed.title || 'Tickets')
    .setDescription(config.embed.description || 'Press a button to open a ticket')
    .setColor(config.embed.color || '#2b2d31')
    .setTimestamp();
  if (config.embed.footer) e.setFooter({ text: config.embed.footer });
  if (config.embed.thumbnail) e.setThumbnail(config.embed.thumbnail);
  if (config.embed.image) e.setImage(config.embed.image);
  return e;
}

function buildPanelButtons() {
  const rows = [];
  config.ticketTypes.forEach((t, idx) => {
    const button = new ButtonBuilder()
      .setCustomId(`ticket_open:${t.id}`)
      .setLabel(t.label)
      .setStyle(ButtonStyle.Primary);
    if (t.emoji) button.setEmoji(t.emoji);
    if (idx % 5 === 0) rows.push(new ActionRowBuilder());
    rows[rows.length - 1].addComponents(button);
  });
  return rows;
}

function baseTicketPermissions(guild, openerId) {
  const allowPerms = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.AttachFiles,
    PermissionsBitField.Flags.EmbedLinks,
  ];
  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: openerId, allow: allowPerms },
    { id: guild.members.me.id, allow: allowPerms },
  ];
  config.staffRoles.concat(config.manageRoles).forEach((roleId) => {
    overwrites.push({ id: roleId, allow: allowPerms });
  });
  return overwrites;
}

function getTicketName(typeId, user) {
  if (config.namingScheme.includes('<type>')) {
    const num = config.counters.tickets++;
    saveConfig();
    return config.namingScheme.replace('<type>', typeId).replace('<number>', num).replace('<user>', user.username);
  }
  return config.namingScheme.replace('<user>', user.username).replace('<type>', typeId);
}

async function logEvent(guild, title, color, fields) {
  if (!config.logChannelId || !config.logging) return;
  const channel = guild.channels.cache.get(config.logChannelId) || (await guild.channels.fetch(config.logChannelId).catch(() => null));
  if (!channel) return;
  const embed = new EmbedBuilder().setTitle(title).setColor(color || '#5865f2').setTimestamp();
  if (fields) embed.addFields(fields.filter(Boolean));
  channel.send({ embeds: [embed] }).catch(() => null);
}

function getTicketData(channelId) {
  return tickets.get(channelId) || null;
}

function setTicketData(channelId, data) {
  tickets.set(channelId, data);
}

function requireTicketChannel(interaction) {
  if (!interaction.channel || !tickets.has(interaction.channel.id)) {
    interaction.reply({ content: 'This command can only be used inside a ticket channel.', ephemeral: true });
    return false;
  }
  return true;
}

async function closeTicket(interaction, reason, requestedBy) {
  const data = getTicketData(interaction.channel.id);
  if (!data) return interaction.reply({ content: 'No ticket data found for this channel.', ephemeral: true });

  const embed = new EmbedBuilder()
    .setTitle('Ticket Closed')
    .setColor('#ed4245')
    .setDescription(`Ticket closed by <@${interaction.user.id}>`)
    .addFields(
      { name: 'Opened by', value: `<@${data.openerId}>`, inline: true },
      { name: 'Type', value: data.typeId, inline: true },
      { name: 'Reason', value: reason || 'No reason provided', inline: false }
    )
    .setTimestamp();

  await interaction.reply({ content: 'Ticket will be closed in 5 seconds.', ephemeral: true }).catch(() => null);
  await interaction.channel.send({ embeds: [embed] }).catch(() => null);

  await logEvent(interaction.guild, 'Ticket Closed', '#ed4245', [
    { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
    { name: 'Closed by', value: `<@${interaction.user.id}>`, inline: true },
    { name: 'Opened by', value: `<@${data.openerId}>`, inline: true },
    { name: 'Type', value: data.typeId, inline: true },
    { name: 'Reason', value: reason || 'No reason provided', inline: false },
    { name: 'Requested by', value: requestedBy ? `<@${requestedBy}>` : 'N/A', inline: true },
  ]);

  setTimeout(() => {
    interaction.channel.delete('Ticket closed').catch(() => null);
    tickets.delete(interaction.channel.id);
  }, 5000);
}

function ticketPreview(interaction, updatedEmbed) {
  const embed = updatedEmbed || buildPanelEmbed();
  interaction.reply({ content: 'Preview of current panel embed:', embeds: [embed], ephemeral: true }).catch(() => null);
}

// -----------------------------
// Interaction Handling
// -----------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      if (commandName === 'ticket-config') return handleConfig(interaction);
      if (commandName === 'ticket-setup') return handleSetup(interaction);
      if (commandName === 'ticket-add') return handleAdd(interaction);
      if (commandName === 'ticket-remove') return handleRemove(interaction);
      if (commandName === 'ticket-request') return handleRequest(interaction);
      if (commandName === 'ticket-rename') return handleRename(interaction);
      if (commandName === 'ticket-claim') return handleClaim(interaction);
      if (commandName === 'ticket-unclaim') return handleUnclaim(interaction);
      if (commandName === 'ticket-close') return handleClose(interaction);
    } else if (interaction.isButton()) {
      return handleButton(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!interaction.replied) interaction.reply({ content: 'An error occurred.', ephemeral: true }).catch(() => null);
  }
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// -----------------------------
// Command Handlers
// -----------------------------
async function handleConfig(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: 'You must have Manage Server or admin role to configure tickets.', ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'set-general': {
      const category = interaction.options.getChannel('category');
      const log = interaction.options.getChannel('log');
      const naming = interaction.options.getString('naming');
      const staffRole = interaction.options.getRole('staff_role');
      const adminRole = interaction.options.getRole('admin_role');
      const managerRole = interaction.options.getRole('manager_role');
      if (category) config.categoryId = category.id;
      if (log) config.logChannelId = log.id;
      if (naming) config.namingScheme = naming;
      if (staffRole && !config.staffRoles.includes(staffRole.id)) config.staffRoles.push(staffRole.id);
      if (adminRole && !config.adminRoles.includes(adminRole.id)) config.adminRoles.push(adminRole.id);
      if (managerRole && !config.manageRoles.includes(managerRole.id)) config.manageRoles.push(managerRole.id);
      saveConfig();
      await interaction.reply({ content: 'General settings updated.', ephemeral: true });
      break;
    }
    case 'set-panel': {
      const updates = ['title', 'description', 'color', 'footer', 'thumbnail', 'image'];
      const panelChannel = interaction.options.getChannel('channel');
      if (panelChannel) config.panelChannelId = panelChannel.id;
      updates.forEach((key) => {
        const value = interaction.options.getString(key);
        if (value !== null) config.embed[key === 'color' ? 'color' : key] = value;
      });
      saveConfig();
      ticketPreview(interaction, buildPanelEmbed());
      break;
    }
    case 'add-button': {
      const id = interaction.options.getString('id', true);
      const label = interaction.options.getString('label', true);
      const emoji = interaction.options.getString('emoji');
      const pingRole = interaction.options.getRole('ping_role');
      const existing = config.ticketTypes.find((t) => t.id === id);
      if (existing) {
        existing.label = label;
        existing.emoji = emoji || null;
        existing.pingRole = pingRole ? pingRole.id : null;
      } else {
        config.ticketTypes.push({ id, label, emoji: emoji || null, pingRole: pingRole ? pingRole.id : null });
      }
      saveConfig();
      await interaction.reply({ content: `Button for type **${id}** saved.`, ephemeral: true });
      break;
    }
    case 'remove-button': {
      const id = interaction.options.getString('id', true);
      const before = config.ticketTypes.length;
      config.ticketTypes = config.ticketTypes.filter((t) => t.id !== id);
      saveConfig();
      await interaction.reply({ content: before === config.ticketTypes.length ? 'No such type found.' : 'Button removed.', ephemeral: true });
      break;
    }
    case 'logging': {
      const event = interaction.options.getString('event', true);
      const enabled = interaction.options.getBoolean('enabled', true);
      config.logging[event] = enabled;
      saveConfig();
      await interaction.reply({ content: `Logging for **${event}** is now ${enabled ? 'enabled' : 'disabled'}.`, ephemeral: true });
      break;
    }
    case 'view': {
      const embed = new EmbedBuilder()
        .setTitle('Ticket Configuration')
        .setColor('#5865f2')
        .setDescription('Current settings overview')
        .addFields(
          { name: 'Category', value: config.categoryId ? `<#${config.categoryId}>` : 'Not set', inline: true },
          { name: 'Log Channel', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Not set', inline: true },
          { name: 'Naming', value: config.namingScheme, inline: true },
          { name: 'Staff Roles', value: config.staffRoles.map((r) => `<@&${r}>`).join(', ') || 'None', inline: true },
          { name: 'Admin Roles', value: config.adminRoles.map((r) => `<@&${r}>`).join(', ') || 'None', inline: true },
          { name: 'Manage Roles', value: config.manageRoles.map((r) => `<@&${r}>`).join(', ') || 'None', inline: true },
          { name: 'Ticket Types', value: config.ticketTypes.map((t) => `${t.label} (${t.id})`).join('\n') || 'None', inline: false }
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    default:
      return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
  }
}

async function handleSetup(interaction) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', ephemeral: true });
  if (!config.ticketTypes.length) return interaction.reply({ content: 'Add at least one ticket type with /ticket-config add-button.', ephemeral: true });
  const channel = interaction.options.getChannel('channel') || (config.panelChannelId ? await interaction.guild.channels.fetch(config.panelChannelId).catch(() => null) : null);
  if (!channel) return interaction.reply({ content: 'No panel channel provided or configured.', ephemeral: true });

  const embed = buildPanelEmbed();
  const components = buildPanelButtons();

  let message;
  if (config.panelMessageId) {
    message = await channel.messages.fetch(config.panelMessageId).catch(() => null);
  }

  if (message) {
    await message.edit({ embeds: [embed], components });
  } else {
    const sent = await channel.send({ embeds: [embed], components });
    config.panelMessageId = sent.id;
    config.panelChannelId = channel.id;
  }
  saveConfig();
  await interaction.reply({ content: 'Ticket panel updated.', ephemeral: true });
}

async function handleAdd(interaction) {
  if (!requireTicketChannel(interaction)) return;
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
  const user = interaction.options.getUser('user', true);
  await interaction.channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
  });
  await interaction.reply({ content: `Added ${user} to the ticket.`, allowedMentions: { users: [] } });
  await logEvent(interaction.guild, 'Member Added to Ticket', '#57f287', [
    { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
    { name: 'Added', value: `<@${user.id}>`, inline: true },
    { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
  ]);
}

async function handleRemove(interaction) {
  if (!requireTicketChannel(interaction)) return;
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
  const user = interaction.options.getUser('user', true);
  await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: false });
  await interaction.reply({ content: `Removed ${user} from the ticket.` });
  await logEvent(interaction.guild, 'Member Removed from Ticket', '#ed4245', [
    { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
    { name: 'Removed', value: `<@${user.id}>`, inline: true },
    { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
  ]);
}

async function handleRequest(interaction) {
  if (!requireTicketChannel(interaction)) return;
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
  const data = getTicketData(interaction.channel.id);
  if (!data) return interaction.reply({ content: 'No ticket data found.', ephemeral: true });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close_accept').setLabel('Close Ticket').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket_close_decline').setLabel('Keep Open').setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    content: `<@${data.openerId}> staff requested to close this ticket.`,
    components: [row],
  });

  await logEvent(interaction.guild, 'Close Requested', '#fee75c', [
    { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
    { name: 'Requested by', value: `<@${interaction.user.id}>`, inline: true },
  ]);
}

async function handleRename(interaction) {
  if (!requireTicketChannel(interaction)) return;
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
  const newName = interaction.options.getString('name', true);
  const oldName = interaction.channel.name;
  await interaction.channel.setName(newName);
  await interaction.reply({ content: `Renamed ticket to **${newName}**.` });
  await logEvent(interaction.guild, 'Ticket Renamed', '#5865f2', [
    { name: 'Old Name', value: oldName, inline: true },
    { name: 'New Name', value: newName, inline: true },
    { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
  ]);
}

async function handleClaim(interaction) {
  if (!requireTicketChannel(interaction)) return;
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
  const data = getTicketData(interaction.channel.id);
  if (!data) return interaction.reply({ content: 'No ticket data found.', ephemeral: true });
  data.claimedBy = interaction.user.id;
  setTicketData(interaction.channel.id, data);
  await interaction.reply({ content: `Ticket claimed by ${interaction.user}.` });
  await logEvent(interaction.guild, 'Ticket Claimed', '#57f287', [
    { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
    { name: 'Claimed by', value: `<@${interaction.user.id}>`, inline: true },
  ]);
}

async function handleUnclaim(interaction) {
  if (!requireTicketChannel(interaction)) return;
  const data = getTicketData(interaction.channel.id);
  if (!data) return interaction.reply({ content: 'No ticket data found.', ephemeral: true });
  if (data.claimedBy && data.claimedBy !== interaction.user.id && !isAdmin(interaction.member)) {
    return interaction.reply({ content: 'Only the claimer or an admin can unclaim this ticket.', ephemeral: true });
  }
  data.claimedBy = null;
  setTicketData(interaction.channel.id, data);
  await interaction.reply({ content: 'Ticket unclaimed.' });
  await logEvent(interaction.guild, 'Ticket Unclaimed', '#fee75c', [
    { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
    { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
  ]);
}

async function handleClose(interaction) {
  if (!requireTicketChannel(interaction)) return;
  const data = getTicketData(interaction.channel.id);
  if (!data) return interaction.reply({ content: 'No ticket data found.', ephemeral: true });
  if (!isStaff(interaction.member) && interaction.user.id !== data.openerId) {
    return interaction.reply({ content: 'Only staff or the ticket opener can close this ticket.', ephemeral: true });
  }
  const reason = interaction.options.getString('reason');
  await closeTicket(interaction, reason, null);
}

async function handleButton(interaction) {
  const [action, typeId] = interaction.customId.split(':');
  if (action === 'ticket_open') {
    const type = config.ticketTypes.find((t) => t.id === typeId);
    if (!type) return interaction.reply({ content: 'This ticket type is no longer available.', ephemeral: true });
    if (!config.categoryId) return interaction.reply({ content: 'Ticket category not configured yet.', ephemeral: true });

    const name = getTicketName(type.id, interaction.user);
    const channel = await interaction.guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: config.categoryId,
      permissionOverwrites: baseTicketPermissions(interaction.guild, interaction.user.id),
      reason: `Ticket opened by ${interaction.user.tag}`,
    });

    const ticketData = {
      openerId: interaction.user.id,
      typeId: type.id,
      openedAt: Date.now(),
      claimedBy: null,
    };
    setTicketData(channel.id, ticketData);

    const intro = new EmbedBuilder()
      .setTitle('Ticket Created')
      .setDescription(`Hello ${interaction.user}, a staff member will be with you shortly.`)
      .addFields({ name: 'Type', value: type.label, inline: true })
      .setColor('#57f287');

    const mention = type.pingRole ? `<@&${type.pingRole}>` : '';
    await channel.send({ content: `${mention} Ticket for ${interaction.user}`, embeds: [intro], allowedMentions: { roles: type.pingRole ? [type.pingRole] : [] } });

    await interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });

    await logEvent(interaction.guild, 'Ticket Opened', '#57f287', [
      { name: 'Ticket', value: `<#${channel.id}>`, inline: true },
      { name: 'Opened by', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Type', value: type.label, inline: true },
    ]);
  } else if (interaction.customId === 'ticket_close_accept') {
    const data = getTicketData(interaction.channel.id);
    if (!data || interaction.user.id !== data.openerId) {
      return interaction.reply({ content: 'Only the ticket opener can confirm closure.', ephemeral: true });
    }
    await interaction.update({ content: 'Closing ticket...', components: [] });
    await closeTicket(interaction, 'Close request accepted', interaction.user.id);
  } else if (interaction.customId === 'ticket_close_decline') {
    await interaction.update({ content: 'Ticket will stay open.', components: [] });
    await logEvent(interaction.guild, 'Close Declined', '#fee75c', [
      { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
      { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
    ]);
  }
}

// -----------------------------
// Startup
// -----------------------------
(async () => {
  await registerCommands().catch((err) => console.error('Command registration failed:', err));
  await client.login(process.env.DISCORD_TOKEN);
})();

