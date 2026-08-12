# 🔱 Dero Discord Bot

A Discord bot built to help Rise of Kingdoms alliances manage KvK season events,
track player participation, and rank members for MGE priority access, all through
an automated reminder system and activity tracker.

> _"I do not serve out of kindness. I exist because my Creator has willed it so."_

---

## Overview

Dero Discord Bot automates the repetitive but critical work of managing a KvK
alliance in Rise of Kingdoms:

- **Event reminders**: automatically posts reminders 15 and 30 minutes before
  Ancient Ruins, Altar of Darkness, and Trial of Kau Karuak
- **Activity tracking**: tracks who acknowledges reminders, who joins voice
  during events, and who is online at event start
- **Participation scoring**: scores every player per event occurrence so leaders
  can make data-driven MGE priority decisions
- **Self-setup**: constructs its own home base (🪧 NOTICE BOARD) with
  channels and permissions the moment it joins a server

---

## Tech Stack

| Technology                                          | Purpose                     |
| --------------------------------------------------- | --------------------------- |
| [Discord.js v14](https://discord.js.org)            | Discord API client          |
| [TypeScript](https://www.typescriptlang.org)        | Type-safe development       |
| [Node.js](https://nodejs.org)                       | Runtime                     |
| [MongoDB + Mongoose](https://mongoosejs.com)        | Database and ODM            |
| [node-cron](https://github.com/node-cron/node-cron) | Reminder scheduler          |
| [Express](https://expressjs.com)                    | Admin dashboard API         |
| [ESLint + Prettier](https://eslint.org)             | Code quality and formatting |

---

## Project Structure

```
src/
├── main.ts                       ← bot entry point, registers all listeners
├── deploy-commands.ts            ← run once to register slash commands with Discord
│
├── types/
│   └── global.d.ts               ← extends discord.js Client with client.commands
│
├── api/                          ← thin Express API for admin dashboard
│   ├── server.ts
│   ├── middleware/
│   │   └── auth.ts               ← API key authentication
│   └── routes/
│       ├── events.routes.ts
│       ├── reminders.routes.ts
│       ├── players.routes.ts
│       └── leaderboard.routes.ts
│
├── base/
│   ├── classes/
│   │   └── CustomClient.ts       ← extended discord.js Client class
│   ├── interfaces/
│   │   ├── ICommand.ts           ← shape every command file must follow
│   │   └── IClientEvent.ts       ← shape for discord event listeners
│   └── constants/
│       ├── BOT_CONSTANTS.ts      ← score weights, reminder offsets, cron config
│       ├── embed-content.ts      ← all embed text, titles, and descriptions
│       └── rok-events.json       ← fixed KvK event intervals and prep steps
│
├── commands/
│   ├── utility/
│   │   └── ping.ts               ← /ping
│   ├── events/
│   │   ├── configure-rok-reminders.ts  ← /configure-kvk-season (admin)
│   │   ├── list-events.ts              ← /list-events (admin)
│   │   └── delete-event.ts             ← /delete-event (admin)
│   └── admin/
│       ├── setup.ts              ← /setup (owner only)
│       └── leaderboard.ts        ← /leaderboard (admin)
│
├── features/
│   ├── setup/
│   │   ├── GuildSetupManager.ts  ← creates category, channels, and permissions
│   │   ├── ChannelContent.ts     ← intro embeds posted in each channel on setup
│   │   └── setup.types.ts
│   ├── events/
│   │   ├── GuildEventManager.ts  ← configures KvK season events in DB
│   │   ├── occurrenceCalculator.ts ← computes next event times from interval
│   │   └── event.types.ts
│   ├── reminders/
│   │   ├── ReminderScheduler.ts  ← cron loop, checks upcoming events every minute
│   │   ├── ReminderJob.ts        ← builds embed and posts reminder to Discord
│   │   └── reminder.types.ts
│   └── activity-tracking/
│       ├── ActivityTracker.ts    ← listeners for reactions, voice, and presence
│       ├── ParticipationStore.ts ← computes participation scores
│       └── activity.types.ts
│
├── db/
│   ├── models/
│   │   ├── Event.ts
│   │   ├── ReminderLog.ts
│   │   ├── PlayerActivity.ts
│   │   └── GuildConfig.ts
│   ├── stores/
│   │   ├── eventStore.ts
│   │   ├── reminderStore.ts
│   │   ├── activityStore.ts
│   │   └── guildConfigStore.ts
│   └── db.ts                     ← MongoDB connection
│
└── utils/
    ├── dateUtils.ts              ← date parsing and interval math
    └── embedBuilder.ts           ← reusable Discord embed factory functions
```

---

## Naming Conventions

| What                  | Convention                | Example                      |
| --------------------- | ------------------------- | ---------------------------- |
| Slash command files   | `kebab-case.ts`           | `configure-kvk-season.ts`    |
| Classes               | `PascalCase.ts`           | `GuildSetupManager.ts`       |
| Helpers / utils       | `camelCase.ts`            | `occurrenceCalculator.ts`    |
| Type files            | `name.types.ts`           | `reminder.types.ts`          |
| Stores                | `nameStore.ts`            | `eventStore.ts`              |
| TS constants          | `SCREAMING_SNAKE_CASE.ts` | `BOT_CONSTANTS.ts`           |
| TS content/data files | `kebab-case.ts`           | `embed-content.ts`           |
| JSON data files       | `kebab-case.json`         | `rok-events.json`            |
| DB models             | `PascalCase.ts`           | `Event.ts`                   |

---

## Commands

### Owner Only

| Command        | Description                                                  |
| -------------- | ------------------------------------------------------------ |
| `/setup @role` | Constructs 🪧 NOTICE BOARD and designates the admin role |

### Admin Only

| Command                    | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `/configure-kvk-season`    | Configure reminders for all KvK events for the season |
| `/list-events`             | View all configured events for the current season     |
| `/delete-event`            | Remove a configured event                             |
| `/leaderboard`             | View participation rankings, public or ephemeral     |

### Utility

| Command | Description                |
| ------- | -------------------------- |
| `/ping` | Check if the bot is online |

---

## System Flow

### ① Bot joins server

```
Bot added to server
      │
      ▼
GuildCreate fires automatically
      │
      ▼
Bot DMs server owner
"I have arrived. Run /setup to establish my throne."
      │
      ▼
Owner runs /setup @AdminRole
      │
      ▼
TWO categories constructed
      │
🪧 NOTICE BOARD
  ├── #📜introductions   → bot introduces itself (the one member-writable channel)
  ├── #📖command-center  → command guide
  ├── #🏆leaderboard     → public rankings
  ├── #📅event-schedule  → upcoming events
  ├── #📢announcements   → reminders post here
  ├── #🔜upcoming-events → a post per event inside the 24h horizon
  ├── #🔒inner-sanctum   → admin only, completely hidden
  └── #🎛️admin-controls  → admin command guide and control panel
      │
🎮 ARCADE GAMES
  ├── #📋arcade-rules    → what you can play, with who, and what a room is
  └── #⚔️challenges      → where a match starts; rooms are created under here
```

Ten channels across two categories. A **game room** is a per-match channel created
under 🎮 ARCADE GAMES and deleted four hours after the match ends; its transcript is
kept in Mongo and outlives the channel.

### ② Admin configures the season

```
Admin runs /configure-kvk-season
      │
      ▼
Inputs: days remaining, ruins date, altar date, kau karuak easy date
      │
      ▼
Bot calculates:
  ├── season end date
  ├── all ruins occurrences (every 36h)
  ├── all altar occurrences (every 84h)
  └── kau karuak: easy → normal (+14d) → hard (+17d) → nightmare (+6d)
      │
      ▼
Confirmation embed posted, admin clicks ✅ Confirm or ✏️ Edit
      │
      ▼
Events saved to DB
```

### ③ Scheduler fires reminders

```
main.ts starts → startScheduler() runs
      │
      ▼  every 60 seconds
cron ticks
      │
      ▼
eventStore.findAll()              ← what events are active?
      │
      ▼
occurrenceCalculator              ← when is the next occurrence?
      │
      ▼
within reminder window?
  ├── NO  → wait for next tick
  └── YES ▼

reminderStore.exists()            ← already fired? (duplicate protection)
  ├── YES → skip
  └── NO  ▼

ReminderJob.fireReminder()
  ├── posts @here embed to #📢announcements
  ├── adds ✅ reaction for acknowledgement tracking
  └── reminderStore.create()      ← logged AFTER post (failures stay retryable)
```

### ④ Activity tracking

```
Player reacts ✅ to reminder
      │
      ▼
reminderStore.findByMessageId()   ← which event does this belong to?
      │
      ▼
activityStore.upsert()            ← acknowledgedReminder: true
      │
      ▼
computeScore() → activityStore.upsert()


Player joins voice during event window
      │
      ▼
VoiceStateUpdate fires
      │
      ├── join → cache session in memory Map
      └── leave → compute voiceMinutes → activityStore.upsert()


Player comes online within 10min of event start
      │
      ▼
PresenceUpdate fires
      │
      ▼
activityStore.upsert()            ← wasOnlineAtStart: true
```

### ⑤ Leaderboard

```
Admin runs /leaderboard
      │
      ▼
activityStore.findByEvent()       ← fetch all activity records
      │
      ▼
group + sort by participationScore
      │
      ▼
leaderboardEmbed()                ← top 10 with medals
      │
      ▼
posted public or ephemeral based on admin choice
```

---

## Participation Scoring

Players are scored per event occurrence. Scores are used to determine MGE
priority access.

| Activity                            | Points   |
| ----------------------------------- | -------- |
| Acknowledged reminder (✅ reaction) | 10       |
| Was online at event start           | 20       |
| Joined voice during event           | 30       |
| Voice minutes (per minute, max 60)  | up to 60 |
| **Maximum score per event**         | **120**  |

Score weights are configurable in `base/constants/BOT_CONSTANTS.ts`.

---

## Environment Variables

Create a `.env` file in the project root:

```env
DISCORD_TOKEN=your_discord_bot_token
MONGODB_URI=your_mongodb_connection_string
DASHBOARD_API_KEY=a_long_random_string_for_api_auth
DASHBOARD_ORIGIN=http://localhost:5173
API_PORT=3000
```

---

## Setup and Installation

```bash
# install dependencies
npm install

# compile TypeScript
npm run build

# register slash commands with Discord (run once)
npm run deploy

# start the bot
npm start
```

### Scripts

| Script             | Description                                   |
| ------------------ | --------------------------------------------- |
| `npm run build`    | Compiles TypeScript and rewrites path aliases |
| `npm run deploy`   | Registers slash commands with Discord API     |
| `npm start`        | Starts the bot                                |
| `npm run lint`     | Runs ESLint                                   |
| `npm run lint:fix` | Runs ESLint with auto-fix                     |

---

## KvK Event Reference

| Event                         | Type      | Interval         |
| ----------------------------- | --------- | ---------------- |
| Ancient Ruins                 | Recurring | Every 36 hours   |
| Altar of Darkness             | Recurring | Every 84 hours   |
| Trial of Kau Karuak Easy      | One-time  | Admin input      |
| Trial of Kau Karuak Normal    | One-time  | Easy + 14 days   |
| Trial of Kau Karuak Hard      | One-time  | Normal + 17 days |
| Trial of Kau Karuak Nightmare | One-time  | Hard + 6 days    |

---

## Contributing

This is a passion project for a private alliance. Contributions are welcome but
please follow the established conventions before opening a PR:

1. **Follow the naming conventions**: see the table above
2. **No logic in command files**: commands validate input and delegate to
   `features/`. Business logic lives in features, never in commands
3. **No raw DB calls outside stores**: all reads and writes go through
   `db/stores/`. Nothing else should know MongoDB exists
4. **All embed text in `embed-content.ts`**: no hardcoded strings in
   `embedBuilder.ts` or anywhere else
5. **Catch and log all errors**: every catch block should
   `console.error("descriptive message:", error)` before replying to the user

---

## Roadmap

- [ ] Alliance Battle Days feature
- [ ] Auto-translation for multilingual alliances
- [ ] Admin dashboard frontend (portfolio site integration)
- [ ] `/help` command
- [ ] `list-events` and `delete-event` commands

---

_Built with 🔱 by the Creator. The noobs need not know how it works._
