import { TextChannel, type Client, type Guild } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { partyGameStore } from "@db/stores/partyGameStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { startHangmanRound } from "@features/games/hangmanHandler.js";
import { adminLog } from "@features/setup/adminLog.js";
import { openChallengeDraft } from "./challengeBoard.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isPartyOver, rsvpCard } from "./partyGamesSchedule.js";
import type { IPartyGame, PartyOpenFailure } from "@db/models/PartyGame.js";

// ── partyGamesOpen ───────────────────────────────────────────────────
// What:  opens each scheduled party game at its start time, by itself (2026-10 item 254,
//        Arcade 4, the owner's decision 11): a hangman round in 🎉party-games, or a
//        Texas hold em or Monopoly challenge card, hosted by the admin who scheduled it.
//        Then the RSVP card in 🔜upcoming-events says where the game is, or why it could
//        not open, and a game that could not open writes one party.open admin log line.
// Who:   ReminderScheduler's 5 minute game room sweep, as its last step, so a game opens
//        within five minutes of its time (the owner's choice) and costs no cron of its own.
// Does NOT: schedule anything (partyGamesSchedule), retry a game that could not open, or
//        play the game: a table game's room opens when its host presses Start, like
//        every challenge.
//
// ⚠️ AT MOST ONCE, ACROSS RESTARTS. The claim is one conditional write on PartyGame's
// null openedAt (partyGameStore.claimOpen), taken BEFORE anything is posted. A crash
// after the claim leaves a game that never opened rather than one that opened twice,
// and no restart, overlapping tick or second process on a deploy can claim it again.
// The RSVP card then has no line about the open, and the host can still open the game
// by hand from 🎉party-games.
//
// ⚠️ ONE ROOM PER HOST STILL HOLDS. The host may already be in a room when the time
// comes; the opener refuses it the way a press would (findOpenByHost, then the partial
// unique index) and the RSVP card says so. No retry: the owner chose the explanation over
// a loop that opens the game whenever the host happens to be free.

/** What one game's open did, as the row records it. */
export interface PartyOpenOutcome {
	openedLink: string | null;
	openFailure: PartyOpenFailure | null;
}

/**
 * Open every scheduled party game whose start has come. Never throws: the sweep it rides
 * also archives rooms, and a failed party read must not cost it that work. A backlog
 * larger than PARTY_GAME_OPEN_BATCH waits for the next tick.
 */
export async function openDuePartyGames(client: Client, now: Date = new Date()): Promise<void> {
	let due: IPartyGame[];
	try {
		due = await partyGameStore.findDueToOpen(now, BOT_CONSTANTS.PARTY_GAME_OPEN_BATCH);
	} catch (error) {
		console.error("[party-games] reading the party games due to open failed", error);
		return;
	}
	// One at a time: each open posts a card, and a burst after an outage should not race
	// Discord's rate limit across one guild's channels.
	for (const row of due) {
		try {
			await openPartyGame(client, row, now);
		} catch (error) {
			console.error("[party-games] opening a scheduled party game failed", { guildId: row.guildId, partyGameId: row.partyGameId, error });
		}
	}
}

/**
 * Claim one due game and open it. Answers what the open did, or null when it was not this
 * call's to open: another tick claimed it, its whole window passed while Dero was away (a
 * game nobody is waiting for any more is not opened late), or Dero left the server.
 */
export async function openPartyGame(client: Client, row: IPartyGame, now: Date = new Date()): Promise<PartyOpenOutcome | null> {
	const claimed = await partyGameStore.claimOpen(row.guildId, row.partyGameId, now);
	if (!claimed || isPartyOver(claimed, now)) return null;
	const guild = client.guilds.cache.get(claimed.guildId) ?? (await client.guilds.fetch(claimed.guildId).catch(() => null));
	if (!guild) return null;

	const config = (await guildConfigStore.findByGuildId(claimed.guildId)) as unknown as { partyGamesChannelId?: string | null } | null;
	const partyChannelId = config?.partyGamesChannelId ?? null;
	const outcome = await openGame(guild, claimed, partyChannelId);
	const recorded = (await partyGameStore.recordOpen(claimed.guildId, claimed.partyGameId, outcome)) ?? { ...claimed, ...outcome };

	await editRsvpCard(client, recorded, partyChannelId);
	if (outcome.openFailure) logNotOpened(client, recorded, outcome.openFailure);
	return outcome;
}

// The game itself, through the door a member's press takes: hangman's round in the party
// channel, or the table game's challenge card through challengeBoard's one opener.
async function openGame(guild: Guild, row: IPartyGame, partyChannelId: string | null): Promise<PartyOpenOutcome> {
	if (row.game === "hangman") return openHangman(guild, row, partyChannelId);
	const opened = await openChallengeDraft(guild, row.hostId, row.game, { openToAll: true });
	if (!opened.ok) return { openedLink: null, openFailure: opened.reason };
	return { openedLink: opened.card.url, openFailure: null };
}

async function openHangman(guild: Guild, row: IPartyGame, partyChannelId: string | null): Promise<PartyOpenOutcome> {
	const channel = partyChannelId ? await guild.channels.fetch(partyChannelId).catch(() => null) : null;
	if (!(channel instanceof TextChannel)) return { openedLink: null, openFailure: "noChannel" };
	const result = await startHangmanRound(channel, row.hostId);
	if (result === "alreadyRunning") return { openedLink: null, openFailure: "alreadyRunning" };
	if (result === "failed") return { openedLink: null, openFailure: "failed" };
	return { openedLink: channel.url, openFailure: null };
}

// The RSVP card redrawn from the row, now carrying the open's line. Cosmetic and logged on
// failure, like every card edit: the game opened (or not) whatever the card says.
async function editRsvpCard(client: Client, row: IPartyGame, partyChannelId: string | null): Promise<void> {
	if (!row.rsvpChannelId || !row.rsvpMessageId) return;
	try {
		const channel = await client.channels.fetch(row.rsvpChannelId).catch(() => null);
		if (!(channel instanceof TextChannel)) return;
		const message = await channel.messages.fetch(row.rsvpMessageId);
		await message.edit({ ...rsvpCard(row, partyChannelId), allowedMentions: { parse: [] } });
	} catch (error) {
		console.warn("[party-games] the RSVP card could not show the open", { guildId: row.guildId, partyGameId: row.partyGameId, error });
	}
}

// The one admin log line for a game Dero could not open. Dero is the actor: the sweep
// opened it, not the admin who scheduled it, who is named in the payload instead.
function logNotOpened(client: Client, row: IPartyGame, failure: PartyOpenFailure): void {
	const words = gameRoomsCopy.partyGames;
	adminLog.emit({
		guild: { id: row.guildId, client },
		kind: "party.open",
		actor: { source: "dero" },
		payload: {
			subject: words.logSubject(words.gameLabels[row.game]),
			detail: words.openFailures[failure],
			partyGameId: row.partyGameId,
			hostId: row.hostId,
			reason: failure,
		},
	});
}
