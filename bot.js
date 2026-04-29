const {
  Client, GatewayIntentBits, Partials,
  PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ChannelType, REST, Routes,
} = require('discord.js');

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
// draftOrder: snake draft for all non-captain picks (teamSize - 1 per side)
const MODES = {
  '8v8': {
    label: '8v8',
    teamSize: 8,
    totalPlayers: 16,
    emoji: '⚔️',
    color: 0x7c3aed,
    // 14 picks: A picks 1st, then snake
    draftOrder: ['A','B','B','A','A','B','B','A','A','B','B','A','A','B'],
    title: '⚔️ 8v8 Tournament Signup',
  },
  '5v5': {
    label: '5v5',
    teamSize: 5,
    totalPlayers: 10,
    emoji: '🛡️',
    color: 0x0ea5e9,
    // 8 picks: A picks 1st, then snake
    draftOrder: ['A','B','B','A','A','B','B','A'],
    title: '🛡️ 5v5 Tournament Signup',
  },
  '3v3': {
    label: '3v3',
    teamSize: 3,
    totalPlayers: 6,
    emoji: '🗡️',
    color: 0x10b981,
    // 4 picks: A picks 1st, then snake
    draftOrder: ['A','B','B','A'],
    title: '🗡️ 3v3 Tournament Signup',
  },
};

// ─── In-memory state ───────────────────────────────────────────────────────────
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
  const cfg = MODES[mode];
  return {
    mode,
    cfg,
    phase: 'signup',
    guildId: null,
    players: [],
    signupMessageId: null,
    signupChannelId: null,
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
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function pickSide(t) {
  return t.cfg.draftOrder[t.draftPickIndex] ?? null;
}

function draftComplete(t) {
  return t.teams.A.length === t.cfg.teamSize && t.teams.B.length === t.cfg.teamSize;
}

function teamOfPlayer(t, userId) {
  if (t.teams.A.some(p => p.id === userId)) return 'A';
  if (t.teams.B.some(p => p.id === userId)) return 'B';
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

// Cross-votes needed to confirm a winner (scales with team size)
// 3v3 -> 1, 5v5 -> 2, 8v8 -> 3
function crossVotesNeeded(t) {
  return Math.ceil(t.cfg.teamSize / 3);
}

// ─── Embed builders ────────────────────────────────────────────────────────────

function buildSignupEmbed(t) {
  const listed = t.players.length
    ? '\n\n' + t.players.map((p, i) => `${i + 1}. ${p.tag}`).join('\n')
    : '';
  return new EmbedBuilder()
    .setColor(t.cfg.color)
    .setTitle(t.cfg.title)
    .setDescription(
      `React with ${t.cfg.emoji} to join!\n\n` +
      `**Players signed up: ${t.players.length} / ${t.cfg.totalPlayers}**` +
      listed +
      `\n\nThe tournament starts automatically when ${t.cfg.totalPlayers} players join.`
    )
    .setFooter({ text: `First ${t.cfg.totalPlayers} reactions count` });
}

function buildCaptainVoteEmbed(t, secondsLeft) {
  const names = t.players.map((p, i) => `${i + 1}. ${p.tag}`).join('\n');
  const footerText = secondsLeft != null
    ? `⏱️ ${secondsLeft}s remaining • ${t.captainVotes.size}/${t.players.length} voted`
    : `${t.captainVotes.size}/${t.players.length} voted`;
  return new EmbedBuilder()
    .setColor(t.cfg.color)
    .setTitle('🗳️ Vote for Captains — 30 seconds!')
    .setDescription(
      `Vote for who should captain each team. Top 2 become captains.\n\n**Players:**\n${names}`
    )
    .setFooter({ text: footerText });
}

function buildCaptainVoteButtons(t) {
  const rows = [];
  for (let i = 0; i < t.players.length; i += 5) {
    const row = new ActionRowBuilder();
    for (let j = i; j < Math.min(i + 5, t.players.length); j++) {
      const p = t.players[j];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`capvote_${p.id}`)
          .setLabel(p.tag.split('#')[0].slice(0, 20))
          .setStyle(ButtonStyle.Secondary)
      );
    }
    rows.push(row);
    if (rows.length === 5) break;
  }
  return rows;
}

function buildDraftEmbed(t) {
  const side = pickSide(t);
  const capId = t.captains[side === 'A' ? 0 : 1];
  const cap = t.players.find(p => p.id === capId);
  const available = availablePlayers(t);
  const total = t.cfg.draftOrder.length;

  return new EmbedBuilder()
    .setColor(t.cfg.color)
    .setTitle(`🏟️ Draft — Pick ${t.draftPickIndex + 1} of ${total}`)
    .setDescription(`**${cap?.tag ?? '?'}** is picking for **Team ${side}**`)
    .addFields(
      { name: `Team A (${t.teams.A.length}/${t.cfg.teamSize})`, value: t.teams.A.map(p => p.tag).join('\n') || '—', inline: true },
      { name: `Team B (${t.teams.B.length}/${t.cfg.teamSize})`, value: t.teams.B.map(p => p.tag).join('\n') || '—', inline: true },
      { name: `Available (${available.length})`, value: available.map(p => p.tag).join(', ') || '—' }
    );
}

function buildDraftButtons(t) {
  const available = availablePlayers(t);
  const rows = [];
  for (let i = 0; i < available.length; i += 5) {
    const row = new ActionRowBuilder();
    for (let j = i; j < Math.min(i + 5, available.length); j++) {
      const p = available[j];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`draft_${p.id}`)
          .setLabel(p.tag.split('#')[0].slice(0, 20))
          .setStyle(ButtonStyle.Primary)
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
      `Vote for the winning team.\n` +
      `**A win requires at least ${needed} vote(s) from the opposing team.**\n\n` +
      `🔵 **${capLabel(t, 'A')}**\n${t.teams.A.map(p => p.tag).join(', ')}\n\n` +
      `🔴 **${capLabel(t, 'B')}**\n${t.teams.B.map(p => p.tag).join(', ')}`
    )
    .setFooter({ text: 'Each player gets 1 vote' });
}

function buildWinnerVoteButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('winner_A').setLabel('Team A wins').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('winner_B').setLabel('Team B wins').setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ─── Slash command definitions ─────────────────────────────────────────────────

const COMMANDS = [
  { name: 'tournament',       description: 'Start an 8v8 PvP tournament signup in this channel' },
  { name: 'tournament5v5',    description: 'Start a 5v5 PvP tournament signup in this channel' },
  { name: 'tournament3v3',    description: 'Start a 3v3 PvP tournament signup in this channel' },
  { name: 'tournament_close', description: 'Cancel the active tournament in this channel (requires Manage Channels)' },
];

// ─── Ready: register commands globally ────────────────────────────────────────

client.on('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📡 Active in ${client.guilds.cache.size} server(s)`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS });
    console.log('✅ Global slash commands registered (may take up to 1hr to propagate to all servers)');
    console.log('   For instant registration during testing, use per-guild registration — see README.');
  } catch (err) {
    console.error('Failed to register commands globally:', err);
  }
});

// Register commands instantly when joining a new guild
client.on('guildCreate', async (guild) => {
  console.log(`➕ Joined new guild: ${guild.name} (${guild.id})`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: COMMANDS });
    console.log(`✅ Commands registered in ${guild.name}`);
  } catch {}
});

// ─── Interaction router ────────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guildId) return;

  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;
    if (commandName === 'tournament')       return handleTournamentStart(interaction, '8v8');
    if (commandName === 'tournament5v5')    return handleTournamentStart(interaction, '5v5');
    if (commandName === 'tournament3v3')    return handleTournamentStart(interaction, '3v3');
    if (commandName === 'tournament_close') return handleTournamentClose(interaction);
    return;
  }

  if (!interaction.isButton()) return;
  const id = interaction.customId;
  if (id.startsWith('capvote_'))                    return handleCaptainVote(interaction);
  if (id.startsWith('draft_'))                      return handleDraftPick(interaction);
  if (id === 'winner_A' || id === 'winner_B')       return handleWinnerVote(interaction);
});

// ─── /tournament, /tournament5v5, /tournament3v3 ──────────────────────────────

async function handleTournamentStart(interaction, mode) {
  await interaction.deferReply();
  const { guildId, channelId } = interaction;
  const ts = getTournaments(guildId);

  // Prevent duplicate signups in the same channel
  const existing = [...ts.values()].find(
    t => t.signupChannelId === channelId && t.phase === 'signup'
  );
  if (existing) {
    return interaction.editReply({
      content: `⚠️ There is already an active ${existing.cfg.label} signup in this channel.`,
    });
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
      content: `⚠️ I could not add the ${t.cfg.emoji} reaction — please give me **Add Reactions** permission in this channel, then react manually to start signups.`,
      ephemeral: true,
    }).catch(() => {});
  }
}

// ─── Reaction add / remove (signup tracking) ──────────────────────────────────

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

// ─── Create private channel and start captain vote ─────────────────────────────

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
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        })),
      ],
    });
  } catch (err) {
    console.error('Failed to create tournament channel:', err);
    return;
  }

  t.channelId = channel.id;
  t.phase = 'vote_captains';

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(t.cfg.color)
        .setTitle(`🏟️ ${t.cfg.label} Tournament ${id} — All ${t.cfg.totalPlayers} players are in!`)
        .setDescription(t.players.map((p, i) => `${i + 1}. ${p.tag}`).join('\n')),
    ],
  });

  await startCaptainVote(guild, channel, t);
}

// ─── Captain vote with 30-second timer ────────────────────────────────────────

async function startCaptainVote(guild, channel, t) {
  const VOTE_SECONDS = 30;

  const voteMsg = await channel.send({
    embeds: [buildCaptainVoteEmbed(t, VOTE_SECONDS)],
    components: buildCaptainVoteButtons(t),
  });
  t.captainVoteMessageId = voteMsg.id;

  // Update countdown every 10 seconds
  let remaining = VOTE_SECONDS;
  const interval = setInterval(async () => {
    remaining -= 10;
    if (remaining <= 0) { clearInterval(interval); return; }
    try {
      await voteMsg.edit({
        embeds: [buildCaptainVoteEmbed(t, remaining)],
        components: buildCaptainVoteButtons(t),
      });
    } catch {}
  }, 10_000);

  // Auto-tally when timer expires
  t.captainVoteTimerId = setTimeout(async () => {
    clearInterval(interval);
    if (t.phase !== 'vote_captains') return; // already resolved by full vote
    await tallyAndStartDraft(guild, t, channel);
  }, VOTE_SECONDS * 1_000);
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

  t.captainVotes.set(voterId, candidateId); // overwrites previous vote

  await interaction.reply({
    content: `✅ Vote recorded! (${t.captainVotes.size}/${t.players.length} voted)`,
    ephemeral: true,
  });

  // Update footer without waiting for interval
  try {
    const voteMsg = await interaction.channel.messages.fetch(t.captainVoteMessageId);
    await voteMsg.edit({ embeds: [buildCaptainVoteEmbed(t, null)] });
  } catch {}

  // Resolve early if everyone has voted
  if (t.captainVotes.size >= t.players.length) {
    if (t.captainVoteTimerId) { clearTimeout(t.captainVoteTimerId); t.captainVoteTimerId = null; }
    await tallyAndStartDraft(interaction.guild, t, interaction.channel);
  }
}

// ─── Tally captain votes → start draft ────────────────────────────────────────

async function tallyAndStartDraft(guild, t, channel) {
  if (t.phase !== 'vote_captains') return; // guard double-fire
  t.phase = 'draft';

  // Tally
  const tally = new Map();
  for (const [, cid] of t.captainVotes) tally.set(cid, (tally.get(cid) ?? 0) + 1);
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);

  t.captains = sorted.slice(0, 2).map(([id]) => id);
  // Fallback: pick from player list if fewer than 2 unique candidates received votes
  for (const p of t.players) {
    if (t.captains.length >= 2) break;
    if (!t.captains.includes(p.id)) t.captains.push(p.id);
  }

  const cap1 = t.players.find(p => p.id === t.captains[0]);
  const cap2 = t.players.find(p => p.id === t.captains[1]);

  t.teams.A.push(cap1);
  t.teams.B.push(cap2);

  // Lock vote message
  try {
    const ch = guild.channels.cache.get(t.channelId);
    const voteMsg = await ch.messages.fetch(t.captainVoteMessageId);
    await voteMsg.edit({
      embeds: [
        new EmbedBuilder()
          .setColor(t.cfg.color)
          .setTitle('🗳️ Captain vote closed')
          .setDescription(
            `**Team A captain:** ${cap1?.tag ?? '?'}\n` +
            `**Team B captain:** ${cap2?.tag ?? '?'}\n\n` +
            `${t.captainVotes.size} vote(s) cast.`
          ),
      ],
      components: [],
    });
  } catch {}

  // Start draft
  const draftMsg = await channel.send({
    content: `<@${t.captains[0]}> — it's your pick!`,
    embeds: [buildDraftEmbed(t)],
    components: buildDraftButtons(t),
  });
  t.draftMessageId = draftMsg.id;
}

// ─── Draft picks ───────────────────────────────────────────────────────────────

async function handleDraftPick(interaction) {
  const pickedId = interaction.customId.replace('draft_', '');
  const pickerId = interaction.user.id;
  const t = findByChannel(interaction.guildId, interaction.channelId);

  if (!t || t.phase !== 'draft')
    return interaction.reply({ content: 'No active draft here.', ephemeral: true });

  const side = pickSide(t);
  const expectedCapId = t.captains[side === 'A' ? 0 : 1];

  if (pickerId !== expectedCapId)
    return interaction.reply({ content: "It's not your turn to pick!", ephemeral: true });

  const picked = availablePlayers(t).find(p => p.id === pickedId);
  if (!picked)
    return interaction.reply({ content: 'That player is no longer available.', ephemeral: true });

  t.teams[side].push(picked);
  t.draftPickIndex++;

  await interaction.deferUpdate();

  if (draftComplete(t)) {
    await finalizeDraft(interaction.guild, t, interaction.channel);
    return;
  }

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

  // Remove draft buttons
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
      name: `🔵 Team A – ${cap1?.tag.split('#')[0] ?? 'A'}`,
      type: ChannelType.GuildVoice,
      permissionOverwrites: [
        ...baseDeny,
        ...t.teams.A.map(p => ({
          id: p.id,
          allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak],
        })),
      ],
    });
    const vcB = await guild.channels.create({
      name: `🔴 Team B – ${cap2?.tag.split('#')[0] ?? 'B'}`,
      type: ChannelType.GuildVoice,
      permissionOverwrites: [
        ...baseDeny,
        ...t.teams.B.map(p => ({
          id: p.id,
          allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak],
        })),
      ],
    });
    t.voiceChannels.A = vcA.id;
    t.voiceChannels.B = vcB.id;
  } catch (err) {
    console.error('Failed to create voice channels:', err);
  }

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x10b981)
        .setTitle(`✅ ${t.cfg.label} Teams are set — Good luck!`)
        .addFields(
          { name: `🔵 Team A — ${cap1?.tag}`, value: t.teams.A.map(p => `• ${p.tag}`).join('\n'), inline: true },
          { name: `🔴 Team B — ${cap2?.tag}`, value: t.teams.B.map(p => `• ${p.tag}`).join('\n'), inline: true }
        )
        .setFooter({ text: 'Private voice channels have been created for each team' }),
    ],
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
  const voterId = interaction.user.id;
  const t = findByChannel(interaction.guildId, interaction.channelId);

  if (!t || t.phase !== 'vote_winner')
    return interaction.reply({ content: 'No active winner vote here.', ephemeral: true });
  if (!teamOfPlayer(t, voterId))
    return interaction.reply({ content: 'You are not in this tournament.', ephemeral: true });

  // Allow vote-changing
  t.winnerVotes.A = t.winnerVotes.A.filter(v => v !== voterId);
  t.winnerVotes.B = t.winnerVotes.B.filter(v => v !== voterId);
  t.winnerVotes[votedSide].push(voterId);

  const total = t.winnerVotes.A.length + t.winnerVotes.B.length;
  await interaction.reply({
    content: `✅ Vote for **Team ${votedSide}** recorded. (${total}/${t.players.length} voted)`,
    ephemeral: true,
  });

  if (total >= t.players.length) {
    await tallyWinner(interaction.guild, t, interaction.channel);
  }
}

async function tallyWinner(guild, t, channel) {
  const { A: votesA, B: votesB } = t.winnerVotes;
  const needed = crossVotesNeeded(t);
  const teamOfVoter = id => t.teams.A.some(p => p.id === id) ? 'A' : 'B';
  const aCross = votesA.filter(id => teamOfVoter(id) === 'B').length;
  const bCross = votesB.filter(id => teamOfVoter(id) === 'A').length;

  const aWins = votesA.length > votesB.length && aCross >= needed;
  const bWins = votesB.length > votesA.length && bCross >= needed;

  let resultEmbed;
  if (aWins) {
    resultEmbed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('🏆 Team A wins!')
      .setDescription(
        `**Votes for A:** ${votesA.length}  •  **Votes for B:** ${votesB.length}\n` +
        `Cross-votes from Team B: ${aCross} ✅\n\n` +
        `${t.teams.A.map(p => p.tag).join(', ')} — congratulations!`
      );
  } else if (bWins) {
    resultEmbed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle('🏆 Team B wins!')
      .setDescription(
        `**Votes for A:** ${votesA.length}  •  **Votes for B:** ${votesB.length}\n` +
        `Cross-votes from Team A: ${bCross} ✅\n\n` +
        `${t.teams.B.map(p => p.tag).join(', ')} — congratulations!`
      );
  } else {
    const leading = votesA.length > votesB.length ? 'Team A' : votesB.length > votesA.length ? 'Team B' : null;
    const gotCross = votesA.length > votesB.length ? aCross : bCross;
    const reason = !leading
      ? 'Votes are tied.'
      : `${leading} had more votes but only received ${gotCross} cross-vote(s) — ${needed} needed.`;
    resultEmbed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle('⚠️ Result disputed')
      .setDescription(
        `**Votes for A:** ${votesA.length}  •  **Votes for B:** ${votesB.length}\n\n` +
        reason + '\n\nA moderator must manually decide the outcome.'
      );
  }

  // Lock vote buttons
  try {
    const winMsg = await channel.messages.fetch(t.winnerVoteMessageId);
    await winMsg.edit({ components: [] });
  } catch {}

  await channel.send({ embeds: [resultEmbed] });

  // Cleanup then auto-repost new signup
  await scheduleCleanupAndRepost(guild, t);
}

// ─── Cleanup and auto-repost ───────────────────────────────────────────────────

async function scheduleCleanupAndRepost(guild, t) {
  const { guildId, mode, signupChannelId, channelId, signupMessageId } = t;

  // Warn in tournament channel
  const ch = guild.channels.cache.get(channelId);
  if (ch) {
    await ch.send('📁 This channel will be deleted in **5 minutes**. GGs everyone!').catch(() => {});
  }

  setTimeout(async () => {
    // Delete voice channels
    for (const side of ['A', 'B']) {
      const vcId = t.voiceChannels[side];
      if (vcId) {
        const vc = guild.channels.cache.get(vcId);
        if (vc) await vc.delete('Tournament finished').catch(() => {});
      }
    }

    // Delete tournament text channel
    const tourneyChannel = guild.channels.cache.get(channelId);
    if (tourneyChannel) await tourneyChannel.delete('Tournament finished').catch(() => {});

    // Remove from state
    getTournaments(guildId).delete(signupMessageId);

    // ── Auto-repost new signup in the original channel ──────────────────────
    const signupChannel = guild.channels.cache.get(signupChannelId);
    if (!signupChannel) {
      console.log(`⚠️  Signup channel ${signupChannelId} not found — cannot repost.`);
      return;
    }

    const fresh = newTournament(mode);
    fresh.guildId = guildId;
    fresh.signupChannelId = signupChannelId;

    try {
      const newMsg = await signupChannel.send({ embeds: [buildSignupEmbed(fresh)] });
      fresh.signupMessageId = newMsg.id;
      getTournaments(guildId).set(newMsg.id, fresh);
      await newMsg.react(fresh.cfg.emoji);
      console.log(`🔄 Auto-reposted ${mode} signup in guild ${guildId}`);
    } catch (err) {
      console.error('Failed to repost signup:', err);
    }
  }, 5 * 60 * 1_000);
}

// ─── /tournament_close (admin) ────────────────────────────────────────────────

async function handleTournamentClose(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.reply({
      content: '❌ You need the **Manage Channels** permission to close tournaments.',
      ephemeral: true,
    });
  }

  const t = findByChannel(interaction.guildId, interaction.channelId);
  if (!t) {
    return interaction.reply({
      content: 'No active tournament found in this channel.',
      ephemeral: true,
    });
  }

  // Cancel any pending timers
  if (t.captainVoteTimerId) clearTimeout(t.captainVoteTimerId);

  // Delete voice channels
  for (const side of ['A', 'B']) {
    const vcId = t.voiceChannels[side];
    if (vcId) {
      const vc = interaction.guild.channels.cache.get(vcId);
      if (vc) await vc.delete().catch(() => {});
    }
  }

  // Delete tournament channel (if different from where command was run)
  if (t.channelId && t.channelId !== interaction.channelId) {
    const ch = interaction.guild.channels.cache.get(t.channelId);
    if (ch) await ch.delete().catch(() => {});
  }

  getTournaments(interaction.guildId).delete(t.signupMessageId);

  await interaction.reply({ content: '🗑️ Tournament cancelled and cleaned up.', ephemeral: true });
}

// ─── Start ─────────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌  Set the DISCORD_TOKEN environment variable before starting.');
  process.exit(1);
}

// ─── Global error guards (prevent crashes from unhandled rejections) ──────────
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message ?? err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.message ?? err);
});

client.on('error', (err) => {
  console.error('Discord client error:', err?.message ?? err);
});

client.login(token);
