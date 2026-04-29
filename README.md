# ⚔️ PvP Tournament Bot

A Discord bot for running 3v3, 5v5, and 8v8 PvP tournaments with automated drafts, voice channels, verified winner voting, and automatic re-queuing.

---

## Features

| Feature | Detail |
|---|---|
| **3 tournament modes** | `/tournament3v3`, `/tournament5v5`, `/tournament` (8v8) |
| **Multi-server** | Fully isolated state per guild — runs on any number of servers simultaneously |
| **React-to-join signup** | Players react with a mode-specific emoji to join |
| **Auto-requeue** | When a match ends, a fresh signup is automatically reposted in the same channel |
| **30-second captain vote** | Countdown shown live; resolves early if everyone votes |
| **Snake draft** | Captains alternate picks in A→B→B→A order |
| **Private voice channels** | Auto-created per team after the draft, deleted after match |
| **Verified winner vote** | Winner needs cross-votes from the opposing team (scales with mode) |
| **Auto-cleanup** | Tournament channel + VCs deleted 5 min after match ends |

---

## Mode Summary

| Mode | Players | Emoji | Cross-votes needed to win |
|---|---|---|---|
| 3v3 | 6 | 🗡️ | 1 |
| 5v5 | 10 | 🛡️ | 2 |
| 8v8 | 16 | ⚔️ | 3 |

---

## Setup

### 1. Create a Discord Application & Bot

1. Go to https://discord.com/developers/applications
2. Click **New Application** → give it a name
3. Go to **Bot** tab → click **Add Bot**
4. Enable these **Privileged Gateway Intents**:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
5. Copy your bot **Token**

### 2. Invite the Bot

In the **OAuth2 → URL Generator** tab, select:
- Scopes: `bot`, `applications.commands`
- Bot Permissions:
  - ✅ Manage Channels
  - ✅ View Channels
  - ✅ Send Messages
  - ✅ Read Message History
  - ✅ Add Reactions
  - ✅ Connect (voice)
  - ✅ Speak (voice)

Open the generated URL to invite the bot.

### 3. Install & Run

```bash
npm install

# macOS/Linux
export DISCORD_TOKEN="your-token-here"
npm start

# Windows (PowerShell)
$env:DISCORD_TOKEN="your-token-here"
node bot.js
```

> **Note on slash commands:** On first start, commands are registered globally (may take up to 1 hour to appear on all servers). Commands register instantly on new servers the bot joins. For immediate testing, see the dev tip below.

#### Dev tip — instant registration for one test server

Add this block right after `client.on('ready', ...)` replaces the global registration:

```js
// Register commands instantly to one guild for testing
await rest.put(
  Routes.applicationGuildCommands(client.user.id, 'YOUR_GUILD_ID'),
  { body: COMMANDS }
);
```

---

## Commands

| Command | Description | Permission |
|---|---|---|
| `/tournament` | Start an 8v8 signup in this channel | Anyone |
| `/tournament5v5` | Start a 5v5 signup in this channel | Anyone |
| `/tournament3v3` | Start a 3v3 signup in this channel | Anyone |
| `/tournament_close` | Cancel and clean up an active tournament | Manage Channels |

---

## Tournament Flow

```
/tournament (or 5v5 / 3v3)
  └─ Signup embed posted (react to join)
     └─ Player count reached
        └─ Private #mode-tournament-XXXX channel created
           └─ 30-second captain vote (buttons, live countdown)
              └─ Top 2 players by votes = captains
                 └─ Snake draft (captains pick in turn)
                    └─ Teams finalised
                       └─ Private voice channels created (Team A / Team B)
                          └─ Winner vote posted
                             └─ All players vote
                                └─ Winner confirmed or disputed
                                   └─ 5-minute countdown
                                      └─ VCs + tournament channel deleted
                                         └─ New signup auto-posted in original channel ♻️
```

### Draft order (snake)

| Mode | Order |
|---|---|
| 3v3 | A B B A |
| 5v5 | A B B A A B B A |
| 8v8 | A B B A A B B A A B B A A B |

### Winner validation

- Each player votes for Team A or Team B
- The majority winner must receive enough **cross-votes** from the opposing team (see Mode Summary)
- If the threshold isn't met, the result is marked **disputed** for a moderator to resolve

---

## Notes

- State is in memory — restarting the bot loses active tournaments. For persistence, replace the `guildTournaments` Map with a database (SQLite via `better-sqlite3`, or PostgreSQL via `pg`).
- One active signup per channel per mode at a time. Multiple different channels in the same server can each host independent tournaments simultaneously.
