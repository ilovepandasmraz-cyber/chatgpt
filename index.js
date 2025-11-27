require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

// --------------------------------------------------
// Constants & configuration
// --------------------------------------------------
const MAIN_GUILD_ID = '1419672871118311456';
const DEPARTMENT_BAN_ROLE_ID = '1443421035994288180';
const DEPARTMENT_STAFF_ROLE_ID = '1419830480806613082';
const FEEDBACK_CHANNEL_ID = '1443424569560924281';

const DEPARTMENTS = {
  tcs: { label: 'Travis County Sheriff', color: '#d7b963' },
  dps: { label: 'Texas DPS', color: '#333232' },
  dhs: { label: 'Homeland Security', color: '#FFFFFF' },
  ntecc: { label: 'NTECC', color: '#CC0000' },
  txdot: { label: 'TxDOT', color: '#4fd138' },
  apd: { label: 'Austin PD', color: '#110cab' },
};

const { DISCORD_TOKEN, CLIENT_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment.');
  process.exit(1);
}

// --------------------------------------------------
// Client setup
// --------------------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// --------------------------------------------------
// Slash command registration
// --------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('department-ban')
    .setDescription('Blacklist a user from all department servers and ban them cross-guild.')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('User to blacklist and ban across department servers')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the department blacklist')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('department-feedback')
    .setDescription('Submit department feedback that is posted to the feedback channel.'),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    // Registering globally; switch to Routes.applicationGuildCommands for per-guild.
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// --------------------------------------------------
// Helper utilities
// --------------------------------------------------
function hasStaffRole(member) {
  return member.roles.cache.has(DEPARTMENT_STAFF_ROLE_ID);
}

function buildDepartmentSelectRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('department-select')
    .setPlaceholder('Choose a department')
    .addOptions(
      Object.entries(DEPARTMENTS).map(([key, value]) => ({
        label: value.label,
        value: key,
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

function buildFeedbackModal(departmentKey) {
  const dept = DEPARTMENTS[departmentKey];
  return new ModalBuilder()
    .setCustomId(`feedback-modal:${departmentKey}`)
    .setTitle(`${dept.label} Feedback`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('member')
          .setLabel('Member (tag, callsign, or mention)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('rating')
          .setLabel('Rating (1-5)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('feedback')
          .setLabel('Feedback details')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
      )
    );
}

function buildFeedbackEmbed(departmentKey, memberText, ratingText, feedbackText, authorTag) {
  const dept = DEPARTMENTS[departmentKey];
  const description =
    `**Member** \u2003\u2003\u2003\u2003 **Rating**\n${memberText} \u2003\u2003 ${ratingText}` +
    `\n\n**Feedback**\n${feedbackText}\n\nFeedback by: ${authorTag}`;

  return new EmbedBuilder()
    .setTitle(`${dept.label} Feedback`)
    .setColor(dept.color)
    .setDescription(description)
    .setTimestamp();
}

async function ensureMainGuild(interaction) {
  if (interaction.guildId !== MAIN_GUILD_ID) {
    await interaction.reply({
      content: 'This command can only be used in the main department server.',
      ephemeral: true,
    });
    return false;
  }
  return true;
}

// --------------------------------------------------
// Interaction handling
// --------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'department-ban') {
        await handleDepartmentBan(interaction);
      } else if (interaction.commandName === 'department-feedback') {
        await handleDepartmentFeedback(interaction);
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'department-select') {
      const departmentKey = interaction.values[0];
      if (!DEPARTMENTS[departmentKey]) {
        await interaction.reply({ content: 'Unknown department selected.', ephemeral: true });
        return;
      }
      const modal = buildFeedbackModal(departmentKey);
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('feedback-modal:')) {
      const departmentKey = interaction.customId.split(':')[1];
      await handleFeedbackModal(interaction, departmentKey);
    }
  } catch (err) {
    console.error('Error handling interaction:', err);
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction.reply({
        content: 'An unexpected error occurred while handling that interaction.',
        ephemeral: true,
      });
    }
  }
});

// --------------------------------------------------
// Command handlers
// --------------------------------------------------
async function handleDepartmentBan(interaction) {
  if (!(await ensureMainGuild(interaction))) return;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member)) {
    await interaction.reply({
      content: 'You do not have permission to use this command.',
      ephemeral: true,
    });
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || 'No reason provided';
  const moderatorTag = interaction.user.tag;

  await interaction.deferReply({ ephemeral: true });

  const mainGuild = client.guilds.cache.get(MAIN_GUILD_ID);
  let roleResult = 'User not found in main guild, role not applied.';

  if (mainGuild) {
    try {
      const targetMember = await mainGuild.members.fetch(targetUser.id);
      await targetMember.roles.add(DEPARTMENT_BAN_ROLE_ID, `Department blacklist by ${moderatorTag}`);
      roleResult = 'Department ban role applied in the main server.';
    } catch (err) {
      roleResult = 'Could not apply department ban role (user missing or insufficient permissions).';
      console.error('Failed to add department ban role:', err);
    }
  }

  const bannedGuilds = [];
  const failedGuilds = [];

  for (const guild of client.guilds.cache.values()) {
    if (guild.id === MAIN_GUILD_ID) continue;
    try {
      await guild.members.fetch(targetUser.id);
      await guild.bans.create(targetUser.id, {
        reason: `Department blacklist issued by ${moderatorTag} | ${reason}`,
      });
      bannedGuilds.push(guild.name);
    } catch (err) {
      if (err.code === 10007 /* Unknown Member */) {
        continue; // User not in this guild, ignore silently.
      }
      failedGuilds.push(guild.name);
      console.error(`Failed to ban in guild ${guild.name}:`, err);
    }
  }

  const responseLines = [
    `Department blacklist issued for **${targetUser.tag}**.`,
    roleResult,
    bannedGuilds.length
      ? `Banned in: ${bannedGuilds.join(', ')}`
      : 'No additional guild bans were applied (user not present or missing permissions).',
  ];

  if (failedGuilds.length) {
    responseLines.push(`Bans failed in: ${failedGuilds.join(', ')}`);
  }

  await interaction.editReply({ content: responseLines.join('\n') });
}

async function handleDepartmentFeedback(interaction) {
  if (!(await ensureMainGuild(interaction))) return;

  await interaction.reply({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setTitle('Department Feedback')
        .setDescription('Select the department you want to leave feedback for.')
        .setColor('#2b2d31'),
    ],
    components: [buildDepartmentSelectRow()],
  });
}

async function handleFeedbackModal(interaction, departmentKey) {
  if (interaction.guildId !== MAIN_GUILD_ID) {
    await interaction.reply({
      content: 'Feedback can only be submitted from the main department server.',
      ephemeral: true,
    });
    return;
  }

  const memberText = interaction.fields.getTextInputValue('member');
  const ratingText = interaction.fields.getTextInputValue('rating');
  const feedbackText = interaction.fields.getTextInputValue('feedback');

  const feedbackEmbed = buildFeedbackEmbed(
    departmentKey,
    memberText,
    ratingText,
    feedbackText,
    interaction.user.tag
  );

  try {
    const mainGuild = await client.guilds.fetch(MAIN_GUILD_ID);
    const feedbackChannel = await mainGuild.channels.fetch(FEEDBACK_CHANNEL_ID);
    if (!feedbackChannel || !feedbackChannel.isTextBased()) {
      throw new Error('Feedback channel not found or not text-based.');
    }

    await feedbackChannel.send({ embeds: [feedbackEmbed] });
    await interaction.reply({ content: 'Feedback submitted successfully.', ephemeral: true });
  } catch (err) {
    console.error('Failed to send feedback:', err);
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'Could not send feedback. Please contact an administrator.',
        ephemeral: true,
      });
    }
  }
}

// --------------------------------------------------
// Startup
// --------------------------------------------------
registerCommands().then(() => client.login(DISCORD_TOKEN));

