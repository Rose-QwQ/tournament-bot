const mongoose = require('mongoose');
const {
  Client, GatewayIntentBits, Partials,
  PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ChannelType, REST, Routes,
} = require('discord.js');

// ─── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

// ─── Tournament mode configs ───────────────────────────────────────────────────
const MODES = {
  '8v8': {
    label: '8v8', teamSize: 8, totalPlayers: 16, emoji: '⚔️', color: 0x7c3aed,
    draftOrder: ['A','B','B','A','A','B','B','A','A','B','B','A','A','B'],
    title: '⚔️ 8v8 Tournament Signup',
  },
  '5v5': {
    label: '5v5', teamSize: 5, totalPlayers: 10, emoji: '🛡️', color: 0x0ea5e9,
    draftOrder: ['A','B','B','A','A','B','B','A'],
    title: '🛡️ 5v5 Tournament Signup',
  },
  '3v3': {
    label: '3v3', teamSize: 3, totalPlayers: 6, emoji: '🗡️', color: 0x10b981,
    draftOrder: ['A','B','B','A'],
    title: '🗡️ 3v3 Tournament Signup',
  },
};

// ─── Scrim rules (shown when tournament channel opens) ────────────────────────
const SCRIM_RULES = `**📋 Scrim Rules**
> 1. No cheating, hacking, or exploiting bugs
> 2. Respect all players — no trash talk or harassment
> 3. Captains make final decisions on picks
> 4. Both teams must agree on the result before voting
> 5. Screenshots of disputed rounds should be posted here
> 6. Have fun and good luck! ⚔️`;

// ─── ELO & Rank system ────────────────────────────────────────────────────────
const TIERS = [
  { name: 'Iron',     min: 0,    emoji: '🪨', color: 0x6b7280 },
  { name: 'Bronze',   min: 100,  emoji: '🥉', color: 0x92400e },
  { name: 'Silver',   min: 200,  emoji: '🥈', color: 0x9ca3af },
  { name: 'Gold',     min: 350,  emoji: '🥇', color: 0xfbbf24 },
  { name: 'Platinum', min: 500,  emoji: '💠', color: 0x06b6d4 },
  { name: 'Diamond',  min: 700,  emoji: '💎', color: 0x818cf8 },
  { name: 'Master',   min: 1000, emoji: '👑', color: 0xf59e0b },
];
const STARTING_ELO = 200;
const ELO_WIN      = 25;
const ELO_LOSS     = 20;
const ELO_FLOOR    = 0;

function getTier(elo) {
  let tier = TIERS[0];
  for (const t of TIERS) { if (elo >= t.min) tier = t; }
  return tier;
}

// ─── MongoDB schema ───────────────────────────────────────────────────────────
const playerSchema = new mongoose.Schema({
  userId:  { type: String, required: true },
  guildId: { type: String, required: true },
  tag:     { type: String, default: 'Unknown' },
  elo:     { type: Number, default: STARTING_ELO },
  wins:    { type: Number, default: 0 },
  losses:  { type: Number, default: 0 },
}, { timestamps: true });
playerSchema.index({ userId: 1, guildId: 1 }, { unique: true });
const Player = mongoose.model('Player', playerSchema);

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.warn('⚠️  MONGODB_URI not set — ELO features will be disabled.');
} else {
  mongoose.connect(mongoUri)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err.message));
}

// ─── ELO helpers ──────────────────────────────────────────────────────────────
async function getOrCreatePlayer(userId, guildId, tag) {
  try {
    let p = await Player.findOne({ userId, guildId });
    if (!p) p = await Player.create({ userId, guildId, tag, elo: STARTING_ELO });
    else if (tag && p.tag !== tag) { p.tag = tag; await p.save(); }
    return p;
  } catch { return null; }
}

async function applyEloResult(guild, winners, losers) {
  if (!mongoUri) return [];
  const results = [];
  for (const p of winners) {
    const doc = await getOrCreatePlayer(p.id, guild.id, p.tag);
    if (!doc) continue;
    const oldElo = doc.elo; const oldTier = getTier(oldElo);
    doc.elo = Math.max(ELO_FLOOR, doc.elo + ELO_WIN); doc.wins += 1;
    await doc.save();
    results.push({ player: p, oldElo, newElo: doc.elo, change: +ELO_WIN, oldTier, newTier: getTier(doc.elo) });
  }
  for (const p of losers) {
    const doc = await getOrCreatePlayer(p.id, guild.id, p.tag);
    if (!doc) continue;
    const oldElo = doc.elo; const oldTier = getTier(oldElo);
    doc.elo = Math.max(ELO_FLOOR, doc.elo - ELO_LOSS); doc.losses += 1;
    await doc.save();
    results.push({ player: p, oldElo, newElo: doc.elo, change: -ELO_LOSS, oldTier, newTier: getTier(doc.elo) });
  }
  return results;
}

async function syncRoles(guild, results) {
  for (const r of results) {
    try {
      const member = await guild.members.fetch(r.player.id).catch(() => null);
      if (!member) continue;
      for (const tier of TIERS) {
        const existing = guild.roles.cache.find(role => role.name === `${tier.emoji} ${tier.name}`);
        if (existing && member.roles.cache.has(existing.id))
          await member.roles.remove(existing).catch(() => {});
      }
      const roleName = `${r.newTier.emoji} ${r.newTier.name}`;
      let role = guild.roles.cache.find(ro => ro.name === roleName);
      if (!role) role = await guild.roles.create({ name: roleName, color: r.newTier.color, reason: 'ELO rank role' }).catch(() => null);
      if (role) await member.roles.add(role).catch(() => {});
    } catch (err) { console.error('Role sync error:', err.message); }
  }
}

function buildEloResultEmbed(winSide, results, cfg) {
  const winners = results.filter(r => r.change > 0);
  const losers  = results.filter(r => r.change < 0);
  const fmtW = r => {
    const up = r.newTier.name !== r.oldTier.name ? ` ⬆️ **${r.newTier.emoji} ${r.newTier.name}!**` : '';
    return `${r.player.tag}: ${r.oldElo} → **${r.newElo}** (+${ELO_WIN})${up}`;
  };
  const fmtL = r => {
    const down = r.newTier.name !== r.oldTier.name ? ` ⬇️ *${r.newTier.emoji} ${r.newTier.name}*` : '';
    return `${r.player.tag}: ${r.oldElo} → **${r.newElo}** (-${ELO_LOSS})${down}`;
  };
  return new EmbedBuilder()
    .setColor(winSide === 'A' ? 0x3b82f6 : 0xef4444)
    .setTitle(`📊 ELO Updated — ${cfg.label} Match`)
    .addFields(
      { name: `🏆 Winners (+${ELO_WIN} ELO)`, value: winners.map(fmtW).join('\n') || '—' },
      { name: `💀 Losers (-${ELO_LOSS} ELO)`,  value: losers.map(fmtL).join('\n') || '—' },
    )
    .setFooter({ text: 'Use /elo to check your rank' });
}

// ─── In-memory tournament state ────────────────────────────────────────────────
// Map<guildId, Map<signupMessageId, Tournament>>
const guildTournaments = new Map();

function getTournaments(guildId) {
  if (!guildTournaments.has(guildId)) guildTournaments.set(guildId, new Map());
  return guildTournaments.get(guildId);
}

function findByChannel(guildId, channelId) {
  return [...getTournaments(guildId).values()].find(
    t => t.channelId === channelId || t.signupChannelId === channelId
  ) ?? null;
}

function newTournament(mode) {
  return {
    mode, cfg: MODES[mode],
    phase: 'signup',
    guildId: null,
    players: [],
    signupMessageId: null,
    signupChannelId: null,
    // IDs of messages in the signup channel to clean up after match ends
    signupChannelMessageIds: [],
    channelId: null,
    captainVoteMessageId: null,
    captainVoteTimerId: null,
    captainVotes: new Map(),
    captains: [],
    teams: { A: [], B: [] },
    draftPickIndex: 0,
    draftMessageId: null,
    winnerVoteMessageId: null,
    winnerVotes: { A: [], B: [] },
    voiceChannels: { A: null, B: null },
    activityCheckInterval: null,
    activityCheckTimers: new Map(),
  };
}

// ─── General helpers ───────────────────────────────────────────────────────────
function pickSide(t)       { return t.cfg.draftOrder[t.draftPickIndex] ?? null; }
function draftComplete(t)  { return t.teams.A.length === t.cfg.teamSize && t.teams.B.length === t.cfg.teamSize; }
function teamOfPlayer(t, id) {
  if (t.teams.A.some(p => p.id === id)) return 'A';
  if (t.teams.B.some(p => p.id === id)) return 'B';
  return null;
}
function capLabel(t, side) {
  const cap = t.players.find(p => p.id === t.captains[side === 'A' ? 0 : 1]);
  return `Team ${side} (cap: ${cap?.tag ?? '?'})`;
}
function availablePlayers(t) {
  const taken = new Set([...t.teams.A, ...t.teams.B].map(p => p.id));
  return t.players.filter(p => !taken.has(p.id) && !t.captains.includes(p.id));
}
function crossVotesNeeded(t) { return Math.ceil(t.cfg.teamSize / 3); }

// ─── Embed builders ────────────────────────────────────────────────────────────
function buildSignupEmbed(t) {
  const listed = t.players.length
    ? '\n\n' + t.players.map((p, i) => `${i + 1}. ${p.tag}`).join('\n') : '';
  return new EmbedBuilder()
    .setColor(t.cfg.color)
    .setTitle(t.cfg.title)
    .setDescription(
      `React with ${t.cfg.emoji} to join!\n\n` +
      `**Players signed up: ${t.players.length} / ${t.cfg.totalPlayers}**` + listed +
      `\n\nThe tournament starts automatically when ${t.cfg.totalPlayers} players join.`
    )
    .setFooter({ text: `First ${t.cfg.totalPlayers} reactions count` });
}

function buildCaptainVoteEmbed(t, secondsLeft) {
  const names = t.players.map((p, i) => `${i + 1}. ${p.tag}`).join('\n');
  const footer = secondsLeft != null
    ? `⏱️ ${secondsLeft}s remaining • ${t.captainVotes.size}/${t.players.length} voted`
    : `${t.captainVotes.size}/${t.players.length} voted`;
  return new EmbedBuilder()
    .setColor(t.cfg.color)
    .setTitle('🗳️ Vote for Captains — 30 seconds!')
    .setDescription(`Vote for who should captain each team. Top 2 become captains.\n\n**Players:**\n${names}`)
    .setFooter({ text: footer });
}

function buildCaptainVoteButtons(t) {
  const rows = [];
  for (let i = 0; i < t.players.length; i += 5) {
    const row = new ActionRowBuilder();
    for (let j = i; j < Math.min(i + 5, t.players.length); j++) {
      const p = t.players[j];
      row.addComponents(
        new ButtonBuilder().setCustomId(`capvote_${p.id}`).setLabel(p.tag.split('#')[0].slice(0, 20)).setStyle(ButtonStyle.Secondary)
      );
    }
    rows.push(row);
    if (rows.length === 5) break;
  }
  return rows;
}

function buildDraftEmbed(t) {
  const side = pickSide(t);
  const cap  = t.players.find(p => p.id === t.captains[side === 'A' ? 0 : 1]);
  const avail = availablePlayers(t);
  return new EmbedBuilder()
    .setColor(t.cfg.color)
    .setTitle(`🏟️ Draft — Pick ${t.draftPickIndex + 1} of ${t.cfg.draftOrder.length}`)
    .setDescription(`**${cap?.tag ?? '?'}** is picking for **Team ${side}**`)
    .addFields(
      { name: `Team A (${t.teams.A.length}/${t.cfg.teamSize})`, value: t.teams.A.map(p => p.tag).join('\n') || '—', inline: true },
      { name: `Team B (${t.teams.B.length}/${t.cfg.teamSize})`, value: t.teams.B.map(p => p.tag).join('\n') || '—', inline: true },
      { name: `Available (${avail.length})`, value: avail.map(p => p.tag).join(', ') || '—' }
    );
}

function buildDraftButtons(t) {
  const avail = availablePlayers(t);
  const rows = [];
  for (let i = 0; i < avail.length; i += 5) {
    const row = new ActionRowBuilder();
    for (let j = i; j < Math.min(i + 5, avail.length); j++) {
      const p = avail[j];
      row.addComponents(
        new ButtonBuilder().setCustomId(`draft_${p.id}`).setLabel(p.tag.split('#')[0].slice(0, 20)).setStyle(ButtonStyle.Primary)
      );
    }
    rows.push(row);
    if (rows.length === 5) break;
  }
  return rows;
}

function buildWinnerVoteEmbed(t) {
  const needed = crossVotesNeeded(t);
  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('🏆 Who won?')
    .setDescription(
      `Vote for the winning team.\n**A win requires at least ${needed} vote(s) from the opposing team.**\n\n` +
      `🔵 **${capLabel(t, 'A')}**\n${t.teams.A.map(p => p.tag).join(', ')}\n\n` +
      `🔴 **${capLabel(t, 'B')}**\n${t.teams.B.map(p => p.tag).join(', ')}`
    )
    .setFooter({ text: 'Each player gets 1 vote' });
}

function buildWinnerVoteButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('winner_A').setLabel('Team A wins').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('winner_B').setLabel('Team B wins').setStyle(ButtonStyle.Danger),
  )];
}

// ─── Activity check helpers ────────────────────────────────────────────────────
const ACTIVITY_CHECK_INTERVAL = 15 * 60 * 1000;
const ACTIVITY_RESPONSE_WINDOW = 2 * 60 * 1000;

function buildActivityCheckButtons(tid) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`still_here_${tid}`).setLabel('✅ Still here!').setStyle(ButtonStyle.Success)
  )];
}

async function startActivityChecks(guild, t) {
  const tid = t.signupMessageId;
  t.activityCheckInterval = setInterval(async () => {
    if (t.phase !== 'signup') { stopActivityChecks(t); return; }
    if (t.players.length === 0) return;
    const ch = guild.channels.cache.get(t.signupChannelId);
    if (!ch) return;
    // Send individual DMs to each player for activity check (ghost ping — only they see it)
    for (const player of [...t.players]) {
      try {
        const member = await guild.members.fetch(player.id).catch(() => null);
        if (!member) continue;
        await member.send({
          content: `🔔 **Activity check for the ${t.cfg.label} queue!**
You have **2 minutes** to click below or you'll be removed from the queue.`,
          components: buildActivityCheckButtons(tid),
        }).catch(async () => {
          // If DMs are closed, fall back to a ghost ping (mention then immediately delete)
          try {
            const ghostMsg = await ch.send({ content: `<@${player.id}>`, components: buildActivityCheckButtons(tid) });
            t.signupChannelMessageIds.push(ghostMsg.id);
            setTimeout(() => ghostMsg.delete().catch(() => {}), 100);
            // Send a visible but quiet fallback
            const fallback = await ch.send({
              content: `🔔 <@${player.id}> — activity check! Click below within 2 minutes or you'll be removed.`,
              components: buildActivityCheckButtons(tid),
            });
            t.signupChannelMessageIds.push(fallback.id);
            setTimeout(() => fallback.delete().catch(() => {}), ACTIVITY_RESPONSE_WINDOW + 5000);
          } catch {}
        });
      } catch {}

      const removalTimer = setTimeout(async () => {
        if (!t.players.some(p => p.id === player.id) || t.phase !== 'signup') return;
        t.players = t.players.filter(p => p.id !== player.id);
        try {
          const signupCh = guild.channels.cache.get(t.signupChannelId);
          // Ghost ping: send then immediately delete so only they get a notification
          if (signupCh) {
            const ghostMsg = await signupCh.send({ content: `<@${player.id}>` });
            setTimeout(() => ghostMsg.delete().catch(() => {}), 100);
          }
          // Also DM them
          const member = await guild.members.fetch(player.id).catch(() => null);
          if (member) await member.send({ content: `⚠️ You were removed from the **${t.cfg.label} queue** for inactivity.` }).catch(() => {});
          const signupMsg = await signupCh?.messages.fetch(t.signupMessageId).catch(() => null);
          if (signupMsg) await signupMsg.edit({ embeds: [buildSignupEmbed(t)] }).catch(() => {});
        } catch {}
      }, ACTIVITY_RESPONSE_WINDOW);
      t.activityCheckTimers.set(player.id, removalTimer);
    }
  }, ACTIVITY_CHECK_INTERVAL);
}

function stopActivityChecks(t) {
  if (t.activityCheckInterval) { clearInterval(t.activityCheckInterval); t.activityCheckInterval = null; }
  for (const timer of t.activityCheckTimers.values()) clearTimeout(timer);
  t.activityCheckTimers.clear();
}

// ─── Slash command definitions ─────────────────────────────────────────────────
const COMMANDS = [
  { name: 'tournament',       description: 'Start an 8v8 PvP tournament signup in this channel' },
  { name: 'tournament5v5',    description: 'Start a 5v5 PvP tournament signup in this channel' },
  { name: 'tournament3v3',    description: 'Start a 3v3 PvP tournament signup in this channel' },
  { name: 'tournament_close', description: 'Cancel the active tournament in this channel (requires Manage Channels)' },
  {
    name: 'elo', description: 'Check your ELO rank (or another player)',
    options: [{ type: 6, name: 'player', description: 'Player to look up (leave blank for yourself)', required: false }],
  },
  { name: 'leaderboard', description: 'Show the top 10 players by ELO in this server' },
  {
    name: 'elo_set', description: 'Manually set a player\'s ELO (admin only)',
    options: [
      { type: 6, name: 'player', description: 'Player to adjust', required: true },
      { type: 4, name: 'elo',    description: 'New ELO value',    required: true },
    ],
  },
];

// ─── Ready: register global commands ──────────────────────────────────────────
client.on('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📡 Active in ${client.guilds.cache.size} server(s)`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS });
    console.log('✅ Global slash commands registered');
  } catch (err) { console.error('Failed to register commands:', err); }
});

client.on('guildCreate', async (guild) => {
  console.log(`➕ Joined new guild: ${guild.name}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: COMMANDS });
  } catch {}
});

// ─── Interaction router ────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.guildId) return;
  if (interaction.isChatInputCommand()) {
    const n = interaction.commandName;
    if (n === 'tournament')       return handleTournamentStart(interaction, '8v8');
    if (n === 'tournament5v5')    return handleTournamentStart(interaction, '5v5');
    if (n === 'tournament3v3')    return handleTournamentStart(interaction, '3v3');
    if (n === 'tournament_close') return handleTournamentClose(interaction);
    if (n === 'elo')              return handleEloCommand(interaction);
    if (n === 'leaderboard')      return handleLeaderboard(interaction);
    if (n === 'elo_set')          return handleEloSet(interaction);
    return;
  }
  if (!interaction.isButton()) return;
  const id = interaction.customId;
  if (id.startsWith('capvote_'))              return handleCaptainVote(interaction);
  if (id.startsWith('draft_'))               return handleDraftPick(interaction);
  if (id === 'winner_A' || id === 'winner_B') return handleWinnerVote(interaction);
  if (id.startsWith('still_here_'))          return handleActivityResponse(interaction);
});

// ─── /tournament, /tournament5v5, /tournament3v3 ──────────────────────────────
async function handleTournamentStart(interaction, mode) {
  await interaction.deferReply();
  const { guildId, channelId } = interaction;
  const ts = getTournaments(guildId);

  const existing = [...ts.values()].find(t => t.signupChannelId === channelId && t.phase === 'signup');
  if (existing) {
    return interaction.editReply({ content: `⚠️ There is already an active ${existing.cfg.label} signup in this channel.` });
  }

  const t = newTournament(mode);
  t.guildId = guildId;
  t.signupChannelId = channelId;

  const msg = await interaction.editReply({ embeds: [buildSignupEmbed(t)] });
  t.signupMessageId = msg.id;
  ts.set(msg.id, t);

  try {
    const fetched = await interaction.channel.messages.fetch(msg.id);
    await fetched.react(t.cfg.emoji);
  } catch (err) {
    console.error('Could not add signup reaction:', err.message);
    await interaction.followUp({
      content: `⚠️ I could not add the ${t.cfg.emoji} reaction — please give me **Add Reactions** permission in this channel, then react manually.`,
      ephemeral: true,
    }).catch(() => {});
  }

  startActivityChecks(interaction.guild, t);
}

// ─── Reaction tracking ─────────────────────────────────────────────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  const guildId = reaction.message.guildId;
  if (!guildId) return;
  const t = getTournaments(guildId).get(reaction.message.id);
  if (!t || t.phase !== 'signup') return;
  if (reaction.emoji.name !== t.cfg.emoji) return;
  if (t.players.some(p => p.id === user.id)) return;

  t.players.push({ id: user.id, tag: user.tag });
  try { await reaction.message.edit({ embeds: [buildSignupEmbed(t)] }); } catch {}

  if (t.players.length >= t.cfg.totalPlayers) {
    t.phase = 'creating_channel';
    await startTournament(reaction.message.guild, t);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  const guildId = reaction.message.guildId;
  if (!guildId) return;
  const t = getTournaments(guildId).get(reaction.message.id);
  if (!t || t.phase !== 'signup') return;
  if (reaction.emoji.name !== t.cfg.emoji) return;
  t.players = t.players.filter(p => p.id !== user.id);
  try { await reaction.message.edit({ embeds: [buildSignupEmbed(t)] }); } catch {}
});

// ─── Create private channel & start captain vote ───────────────────────────────
async function startTournament(guild, t) {
  const id = Math.random().toString(36).slice(2, 6).toUpperCase();
  let channel;
  try {
    channel = await guild.channels.create({
      name: `${t.cfg.label}-tournament-${id}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...t.players.map(p => ({
          id: p.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        })),
      ],
    });
  } catch (err) { console.error('Failed to create tournament channel:', err); return; }

  t.channelId = channel.id;
  t.phase = 'vote_captains';
  stopActivityChecks(t);

  // Ping all players in signup channel, track message for later cleanup
  const signupCh = guild.channels.cache.get(t.signupChannelId);
  if (signupCh) {
    const mentions = t.players.map(p => `<@${p.id}>`).join(' ');
    try {
      const pingMsg = await signupCh.send({
        content: `🚨 **The ${t.cfg.label} scrim is starting!** Head to <#${channel.id}>\n${mentions}`,
      });
      t.signupChannelMessageIds.push(pingMsg.id);
    } catch {}
  }

  // Post intro + rules in tournament channel
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(t.cfg.color)
        .setTitle(`🏟️ ${t.cfg.label} Tournament ${id} — All ${t.cfg.totalPlayers} players are in!`)
        .setDescription(t.players.map((p, i) => `${i + 1}. ${p.tag}`).join('\n')),
    ],
  });
  await channel.send({ content: SCRIM_RULES });
  await startCaptainVote(guild, channel, t);
}

// ─── Captain vote with 30s timer ──────────────────────────────────────────────
async function startCaptainVote(guild, channel, t) {
  const VOTE_SECONDS = 30;
  const voteMsg = await channel.send({
    embeds: [buildCaptainVoteEmbed(t, VOTE_SECONDS)],
    components: buildCaptainVoteButtons(t),
  });
  t.captainVoteMessageId = voteMsg.id;

  let remaining = VOTE_SECONDS;
  const interval = setInterval(async () => {
    remaining -= 10;
    if (remaining <= 0) { clearInterval(interval); return; }
    try { await voteMsg.edit({ embeds: [buildCaptainVoteEmbed(t, remaining)], components: buildCaptainVoteButtons(t) }); } catch {}
  }, 10000);

  t.captainVoteTimerId = setTimeout(async () => {
    clearInterval(interval);
    if (t.phase !== 'vote_captains') return;
    await tallyAndStartDraft(guild, t, channel);
  }, VOTE_SECONDS * 1000);
}

async function handleCaptainVote(interaction) {
  const candidateId = interaction.customId.replace('capvote_', '');
  const voterId = interaction.user.id;
  const t = findByChannel(interaction.guildId, interaction.channelId);
  if (!t || t.phase !== 'vote_captains')
    return interaction.reply({ content: 'No active captain vote here.', ephemeral: true });
  if (!t.players.some(p => p.id === voterId))
    return interaction.reply({ content: 'You are not in this tournament.', ephemeral: true });
  if (candidateId === voterId)
    return interaction.reply({ content: "You can't vote for yourself.", ephemeral: true });

  t.captainVotes.set(voterId, candidateId);
  await interaction.reply({ content: `✅ Vote recorded! (${t.captainVotes.size}/${t.players.length} voted)`, ephemeral: true });

  try {
    const voteMsg = await interaction.channel.messages.fetch(t.captainVoteMessageId);
    await voteMsg.edit({ embeds: [buildCaptainVoteEmbed(t, null)] });
  } catch {}

  if (t.captainVotes.size >= t.players.length) {
    if (t.captainVoteTimerId) { clearTimeout(t.captainVoteTimerId); t.captainVoteTimerId = null; }
    await tallyAndStartDraft(interaction.guild, t, interaction.channel);
  }
}

async function tallyAndStartDraft(guild, t, channel) {
  if (t.phase !== 'vote_captains') return;
  t.phase = 'draft';

  const tally = new Map();
  for (const [, cid] of t.captainVotes) tally.set(cid, (tally.get(cid) ?? 0) + 1);
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  t.captains = sorted.slice(0, 2).map(([id]) => id);
  for (const p of t.players) {
    if (t.captains.length >= 2) break;
    if (!t.captains.includes(p.id)) t.captains.push(p.id);
  }

  const cap1 = t.players.find(p => p.id === t.captains[0]);
  const cap2 = t.players.find(p => p.id === t.captains[1]);
  t.teams.A.push(cap1);
  t.teams.B.push(cap2);

  try {
    const ch = guild.channels.cache.get(t.channelId);
    const voteMsg = await ch.messages.fetch(t.captainVoteMessageId);
    await voteMsg.edit({
      embeds: [new EmbedBuilder().setColor(t.cfg.color).setTitle('🗳️ Captain vote closed')
        .setDescription(`**Team A captain:** ${cap1?.tag ?? '?'}\n**Team B captain:** ${cap2?.tag ?? '?'}\n\n${t.captainVotes.size} vote(s) cast.`)],
      components: [],
    });
  } catch {}

  const draftMsg = await channel.send({
    content: `<@${t.captains[0]}> — it's your pick!`,
    embeds: [buildDraftEmbed(t)],
    components: buildDraftButtons(t),
  });
  t.draftMessageId = draftMsg.id;
}

// ─── Draft ─────────────────────────────────────────────────────────────────────
async function handleDraftPick(interaction) {
  const pickedId = interaction.customId.replace('draft_', '');
  const t = findByChannel(interaction.guildId, interaction.channelId);
  if (!t || t.phase !== 'draft')
    return interaction.reply({ content: 'No active draft here.', ephemeral: true });

  const side = pickSide(t);
  if (interaction.user.id !== t.captains[side === 'A' ? 0 : 1])
    return interaction.reply({ content: "It's not your turn to pick!", ephemeral: true });

  const picked = availablePlayers(t).find(p => p.id === pickedId);
  if (!picked)
    return interaction.reply({ content: 'That player is no longer available.', ephemeral: true });

  t.teams[side].push(picked);
  t.draftPickIndex++;
  await interaction.deferUpdate();

  if (draftComplete(t)) { await finalizeDraft(interaction.guild, t, interaction.channel); return; }

  const nextSide = pickSide(t);
  const nextCapId = t.captains[nextSide === 'A' ? 0 : 1];
  await interaction.editReply({
    content: `<@${nextCapId}> — it's your pick!`,
    embeds: [buildDraftEmbed(t)],
    components: buildDraftButtons(t),
  });
}

// ─── Finalize draft → voice channels ──────────────────────────────────────────
async function finalizeDraft(guild, t, channel) {
  t.phase = 'playing';
  try {
    const ch = guild.channels.cache.get(t.channelId);
    const draftMsg = await ch.messages.fetch(t.draftMessageId);
    await draftMsg.edit({ content: '✅ Draft complete!', embeds: [buildDraftEmbed(t)], components: [] });
  } catch {}

  const cap1 = t.players.find(p => p.id === t.captains[0]);
  const cap2 = t.players.find(p => p.id === t.captains[1]);
  const baseDeny = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel] }];

  try {
    const vcA = await guild.channels.create({
      name: `🔵 Team A – ${cap1?.tag.split('#')[0] ?? 'A'}`, type: ChannelType.GuildVoice,
      permissionOverwrites: [...baseDeny, ...t.teams.A.map(p => ({ id: p.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak] }))],
    });
    const vcB = await guild.channels.create({
      name: `🔴 Team B – ${cap2?.tag.split('#')[0] ?? 'B'}`, type: ChannelType.GuildVoice,
      permissionOverwrites: [...baseDeny, ...t.teams.B.map(p => ({ id: p.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak] }))],
    });
    t.voiceChannels.A = vcA.id;
    t.voiceChannels.B = vcB.id;
  } catch (err) { console.error('Failed to create VCs:', err); }

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x10b981).setTitle(`✅ ${t.cfg.label} Teams are set — Good luck!`)
      .addFields(
        { name: `🔵 Team A — ${cap1?.tag}`, value: t.teams.A.map(p => `• ${p.tag}`).join('\n'), inline: true },
        { name: `🔴 Team B — ${cap2?.tag}`, value: t.teams.B.map(p => `• ${p.tag}`).join('\n'), inline: true },
      )
      .setFooter({ text: 'Private voice channels have been created for each team' })],
  });

  await startWinnerVote(channel, t);
}

// ─── Winner vote ───────────────────────────────────────────────────────────────
async function startWinnerVote(channel, t) {
  t.phase = 'vote_winner';
  const needed = crossVotesNeeded(t);
  const msg = await channel.send({
    content: `🏆 Match over? Vote below. **A win requires ≥${needed} vote(s) from the opposing team.**`,
    embeds: [buildWinnerVoteEmbed(t)],
    components: buildWinnerVoteButtons(),
  });
  t.winnerVoteMessageId = msg.id;
}

async function handleWinnerVote(interaction) {
  const votedSide = interaction.customId === 'winner_A' ? 'A' : 'B';
  const t = findByChannel(interaction.guildId, interaction.channelId);
  if (!t || t.phase !== 'vote_winner')
    return interaction.reply({ content: 'No active winner vote here.', ephemeral: true });
  if (!teamOfPlayer(t, interaction.user.id))
    return interaction.reply({ content: 'You are not in this tournament.', ephemeral: true });

  t.winnerVotes.A = t.winnerVotes.A.filter(v => v !== interaction.user.id);
  t.winnerVotes.B = t.winnerVotes.B.filter(v => v !== interaction.user.id);
  t.winnerVotes[votedSide].push(interaction.user.id);

  const total = t.winnerVotes.A.length + t.winnerVotes.B.length;
  await interaction.reply({ content: `✅ Vote for **Team ${votedSide}** recorded. (${total}/${t.players.length} voted)`, ephemeral: true });
  if (total >= t.players.length) await tallyWinner(interaction.guild, t, interaction.channel);
}

async function tallyWinner(guild, t, channel) {
  const { A: votesA, B: votesB } = t.winnerVotes;
  const needed = crossVotesNeeded(t);
  const teamOfVoter = id => t.teams.A.some(p => p.id === id) ? 'A' : 'B';
  const aCross = votesA.filter(id => teamOfVoter(id) === 'B').length;
  const bCross = votesB.filter(id => teamOfVoter(id) === 'A').length;
  const aWins = votesA.length > votesB.length && aCross >= needed;
  const bWins = votesB.length > votesA.length && bCross >= needed;

  let resultEmbed, winningSide = null;
  if (aWins) {
    winningSide = 'A';
    resultEmbed = new EmbedBuilder().setColor(0x3b82f6).setTitle('🏆 Team A wins!')
      .setDescription(`**Votes for A:** ${votesA.length}  •  **Votes for B:** ${votesB.length}\nCross-votes from Team B: ${aCross} ✅\n\n${t.teams.A.map(p => p.tag).join(', ')} — congratulations!`);
  } else if (bWins) {
    winningSide = 'B';
    resultEmbed = new EmbedBuilder().setColor(0xef4444).setTitle('🏆 Team B wins!')
      .setDescription(`**Votes for A:** ${votesA.length}  •  **Votes for B:** ${votesB.length}\nCross-votes from Team A: ${bCross} ✅\n\n${t.teams.B.map(p => p.tag).join(', ')} — congratulations!`);
  } else {
    const leading = votesA.length > votesB.length ? 'Team A' : votesB.length > votesA.length ? 'Team B' : null;
    const gotCross = votesA.length > votesB.length ? aCross : bCross;
    const reason = !leading ? 'Votes are tied.' : `${leading} had more votes but only got ${gotCross} cross-vote(s) — ${needed} needed.`;
    resultEmbed = new EmbedBuilder().setColor(0xf59e0b).setTitle('⚠️ Result disputed')
      .setDescription(`**Votes for A:** ${votesA.length}  •  **Votes for B:** ${votesB.length}\n\n${reason}\n\nA moderator must manually decide.`);
  }

  try { const winMsg = await channel.messages.fetch(t.winnerVoteMessageId); await winMsg.edit({ components: [] }); } catch {}
  await channel.send({ embeds: [resultEmbed] });

  // Apply ELO if winner confirmed
  if (winningSide) {
    const losingSide = winningSide === 'A' ? 'B' : 'A';
    try {
      const eloResults = await applyEloResult(guild, t.teams[winningSide], t.teams[losingSide]);
      if (eloResults.length > 0) {
        await syncRoles(guild, eloResults);
        await channel.send({ embeds: [buildEloResultEmbed(winningSide, eloResults, t.cfg)] });
      }
    } catch (err) { console.error('ELO update error:', err.message); }
  }

  await scheduleCleanupAndRepost(guild, t);
}

// ─── Cleanup (1 min) and auto-repost ──────────────────────────────────────────
async function scheduleCleanupAndRepost(guild, t) {
  const { guildId, mode, signupChannelId, channelId, signupMessageId } = t;

  const ch = guild.channels.cache.get(channelId);
  if (ch) await ch.send('📁 This channel will be deleted in **1 minute**. GGs everyone!').catch(() => {});

  setTimeout(async () => {
    // Delete voice channels
    for (const side of ['A', 'B']) {
      const vc = guild.channels.cache.get(t.voiceChannels[side]);
      if (vc) await vc.delete('Tournament finished').catch(() => {});
    }
    // Delete tournament text channel
    const tourneyChannel = guild.channels.cache.get(channelId);
    if (tourneyChannel) await tourneyChannel.delete('Tournament finished').catch(() => {});

    // Delete the signup message and all bot messages in the signup channel
    const signupChannel = guild.channels.cache.get(signupChannelId);
    if (signupChannel) {
      // Delete old signup message
      try {
        const oldSignup = await signupChannel.messages.fetch(signupMessageId).catch(() => null);
        if (oldSignup) await oldSignup.delete().catch(() => {});
      } catch {}
      // Delete tracked bot messages (pings, activity checks, removal notices)
      for (const msgId of t.signupChannelMessageIds) {
        try {
          const msg = await signupChannel.messages.fetch(msgId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        } catch {}
      }
    }

    getTournaments(guildId).delete(signupMessageId);

    // Auto-repost fresh signup
    if (!signupChannel) { console.log(`⚠️ Signup channel ${signupChannelId} not found`); return; }
    const fresh = newTournament(mode);
    fresh.guildId = guildId;
    fresh.signupChannelId = signupChannelId;
    try {
      const newMsg = await signupChannel.send({ embeds: [buildSignupEmbed(fresh)] });
      fresh.signupMessageId = newMsg.id;
      getTournaments(guildId).set(newMsg.id, fresh);
      await newMsg.react(fresh.cfg.emoji);
      startActivityChecks(guild, fresh);
      console.log(`🔄 Auto-reposted ${mode} signup in guild ${guildId}`);
    } catch (err) { console.error('Failed to repost signup:', err); }
  }, 60 * 1000); // 1 minute
}

// ─── Activity check response ───────────────────────────────────────────────────
async function handleActivityResponse(interaction) {
  const tid = interaction.customId.replace('still_here_', '');
  const t = getTournaments(interaction.guildId).get(tid);
  if (!t || t.phase !== 'signup')
    return interaction.reply({ content: 'No active queue to check in for.', ephemeral: true });
  if (!t.players.some(p => p.id === interaction.user.id))
    return interaction.reply({ content: "You're not currently in the queue.", ephemeral: true });
  const timer = t.activityCheckTimers.get(interaction.user.id);
  if (timer) { clearTimeout(timer); t.activityCheckTimers.delete(interaction.user.id); }
  await interaction.reply({ content: "✅ You're confirmed as still in the queue!", ephemeral: true });
}

// ─── /tournament_close ────────────────────────────────────────────────────────
async function handleTournamentClose(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels))
    return interaction.reply({ content: '❌ You need the **Manage Channels** permission.', ephemeral: true });

  const t = findByChannel(interaction.guildId, interaction.channelId);
  if (!t) return interaction.reply({ content: 'No active tournament found in this channel.', ephemeral: true });

  if (t.captainVoteTimerId) clearTimeout(t.captainVoteTimerId);
  stopActivityChecks(t);

  for (const side of ['A', 'B']) {
    const vc = interaction.guild.channels.cache.get(t.voiceChannels[side]);
    if (vc) await vc.delete().catch(() => {});
  }
  if (t.channelId && t.channelId !== interaction.channelId) {
    const ch = interaction.guild.channels.cache.get(t.channelId);
    if (ch) await ch.delete().catch(() => {});
  }
  getTournaments(interaction.guildId).delete(t.signupMessageId);
  await interaction.reply({ content: '🗑️ Tournament cancelled and cleaned up.', ephemeral: true });
}

// ─── /elo ─────────────────────────────────────────────────────────────────────
async function handleEloCommand(interaction) {
  await interaction.deferReply();
  if (!mongoUri) return interaction.editReply({ content: '❌ ELO system is not configured (no database connected).' });
  const target = interaction.options.getUser('player') ?? interaction.user;
  const doc = await getOrCreatePlayer(target.id, interaction.guildId, target.tag);
  if (!doc) return interaction.editReply({ content: '❌ Could not fetch ELO data.' });
  const tier = getTier(doc.elo);
  const nextTier = TIERS[TIERS.indexOf(tier) + 1];
  const embed = new EmbedBuilder()
    .setColor(tier.color)
    .setTitle(`${tier.emoji} ${target.tag}'s Rank`)
    .addFields(
      { name: 'ELO',    value: `**${doc.elo}**`,               inline: true },
      { name: 'Rank',   value: `**${tier.name}**`,             inline: true },
      { name: 'Record', value: `${doc.wins}W / ${doc.losses}L`, inline: true },
    )
    .setFooter({ text: nextTier ? `${nextTier.min - doc.elo} ELO needed to reach ${nextTier.emoji} ${nextTier.name}` : 'Maximum rank achieved! 👑' });
  await interaction.editReply({ embeds: [embed] });
}

// ─── /leaderboard ─────────────────────────────────────────────────────────────
async function handleLeaderboard(interaction) {
  await interaction.deferReply();
  if (!mongoUri) return interaction.editReply({ content: '❌ ELO system is not configured (no database connected).' });
  const top = await Player.find({ guildId: interaction.guildId }).sort({ elo: -1 }).limit(10);
  if (!top.length) return interaction.editReply({ content: 'No ELO data yet — play some matches first!' });
  const rows = top.map((p, i) => {
    const tier = getTier(p.elo);
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} **${p.tag}** — ${tier.emoji} ${p.elo} ELO (${p.wins}W/${p.losses}L)`;
  });
  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0xfbbf24).setTitle('🏆 ELO Leaderboard')
      .setDescription(rows.join('\n')).setFooter({ text: `Top ${top.length} players in this server` })],
  });
}

// ─── /elo_set (admin) ─────────────────────────────────────────────────────────
async function handleEloSet(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
    return interaction.reply({ content: '❌ You need **Manage Server** permission.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  if (!mongoUri) return interaction.editReply({ content: '❌ ELO system is not configured.' });

  const target = interaction.options.getUser('player');
  const newElo  = interaction.options.getInteger('elo');
  if (newElo < 0) return interaction.editReply({ content: '❌ ELO cannot be negative.' });

  const doc = await getOrCreatePlayer(target.id, interaction.guildId, target.tag);
  if (!doc) return interaction.editReply({ content: '❌ Could not fetch player data.' });
  const oldElo = doc.elo;
  doc.elo = newElo;
  await doc.save();

  await syncRoles(interaction.guild, [{
    player: { id: target.id, tag: target.tag },
    oldElo, newElo, change: newElo - oldElo,
    oldTier: getTier(oldElo), newTier: getTier(newElo),
  }]);

  const tier = getTier(newElo);
  await interaction.editReply({ content: `✅ Set **${target.tag}**'s ELO to **${newElo}** (${tier.emoji} ${tier.name})` });
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
const token = process.env.DISCORD_TOKEN;
if (!token) { console.error('❌  Set the DISCORD_TOKEN environment variable before starting.'); process.exit(1); }

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err?.message ?? err));
process.on('uncaughtException',  err => console.error('Uncaught exception:',  err?.message ?? err));
client.on('error',               err => console.error('Discord client error:', err?.message ?? err));

client.login(token);
