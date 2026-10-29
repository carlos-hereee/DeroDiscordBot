import { type Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { mapWithConcurrency } from "@utils/mapWithConcurrency.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { disarmStaleBlackjackBoard, hasLiveBlackjackTable } from "@features/games/blackjackHandler.js";
import { finish } from "./roomLifecycle.js";
import { sweepExpiredRooms } from "./roomArchiveSweep.js";
import { roomTrail } from "./roomTrail.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isBlackjackRoomGame, refereeOn } from "./roomTypes.js";
import { registerDealerTable } from "@features/dero-brain/dealerNarration.js";

// ── roomBootRecovery ─────────────────────────────────────────────────
// What:  reconciles what the GameRoom rows CLAIM with what Discord actually has, once
//        per boot, and then catches up on any archiving missed while the bot was down.
// Who:   main.ts, in the ready handler after ensureIntroChannelsWritable.
// When:  once, at startup. Railway restarts the process on every deploy, so this runs
//        several times a week in practice.
// Where: a room row is the only restart-survivable state this feature has, which is the
//        whole reason rooms exist rather than the in-memory Maps the older games use.
//        But surviving a restart is not the same as being TRUE: while the process was
//        down, an admin can delete a room channel and nothing was listening.
// How:   ① every non-terminal room whose channel is gone is finished as abandoned,
//        ①ᵇ a blackjack room whose channel survived but whose in-memory table did
//        not is closed out loud (a system line, the dead board disarmed, then abandoned;
//        finish pays every stack its row stored, 2026-10 item 267),
//        ①ᶜ a playing Hold'em room whose referee is on gets its dealer back,
//        ② then the ordinary expiry sweep runs immediately rather than waiting up to
//        five minutes for its first cron tick.

export interface BootRecoverySummary {
	abandoned: number;
	// Solo blackjack rooms closed because this boot held no table for them. Counted apart
	// from `abandoned` because the channel was fine; it is the hand that did not survive.
	lostTables: number;
	// Hold'em rooms whose dealer narration this boot registered again (2026-10 item 263 R3-28).
	dealersRestored: number;
	archived: number;
}

export async function recoverGameRoomsOnBoot(client: Client): Promise<BootRecoverySummary> {
	let abandoned = 0;
	let lostTables = 0;
	let dealersRestored = 0;

	try {
		const live = await gameRoomStore.findNonTerminal();

		// Bounded for the same reason the archive sweep is: a bot returning after a long
		// outage could be holding a lot of these, and each one is a channel fetch.
		await mapWithConcurrency(live, BOT_CONSTANTS.SCHEDULER_GUILD_CONCURRENCY, async (room) => {
			try {
				// A draft has no channel yet by definition, so "no channel" says nothing
				// about it and it must not be reaped here. Drafts are reaped on their own
				// GAME_ROOM_DRAFT_TIMEOUT_MS clock, which is a separate concern.
				if (!room.channelId) return;

				const channel = await client.channels.fetch(room.channelId).catch(() => null);
				if (channel) {
					// ①ᶜ The dealer registry is memory only (dealerNarration), so a restart silenced every
					// table that narrated. Registered again exactly as roomReferee.startRoomReferee does,
					// voice on, and only while the host's referee is on: a host who turned it off stays
					// unnarrated (risk R15). The voice join itself is not redone: the dealer speaks once
					// Dero is in a call with the table, wherever that call came from.
					if (room.game === "holdem" && room.status === "playing" && refereeOn(room)) {
						registerDealerTable({ roomId: room.roomId, guildId: room.guildId, channelId: room.channelId, voice: true });
						dealersRestored++;
						return;
					}
					// ①ᵇ The channel is here; is the game? A blackjack hand, solo or at a room's
					// multi seat table (2026-10 item 254, Arcade 1), lives only in
					// blackjackHandler's process-scoped Map, and this process started with that
					// Map empty, so a "playing" row this boot holds no table for is a match
					// SIGTERM already ended: no button on its board reaches a handler, and
					// nothing inside the handler will ever finish it. Say so where the host will
					// read it, take the buttons off the dead board, then close as abandoned.
					// Abandoned rather than a loss, because the hand in play was not settled;
					// finish pays every stack the row stored after the last settled hand
					// (blackjackChips, 2026-10 item 267), each claimed once, and abandoned pays
					// no XP or coins, so a redeploy is not farmable.
					// Any other game's room is untouched: their state lives on the row.
					if (!isBlackjackRoomGame(room.game) || hasLiveBlackjackTable(room.channelId)) return;

					await roomTrail.postMove(client, room, {
						actorId: client.user?.id ?? room.hostId,
						kind: "system",
						text: gameRoomsCopy.trail.tableLostToRestart,
					});
					await disarmStaleBlackjackBoard(channel);
					await finish(client, room, { abandoned: true });
					lostTables++;
					return;
				}

				// The channel is gone and the row still says the match is live. Nothing
				// will ever finish it, so it would hold its host's one room slot (the
				// partial unique index counts non-terminal statuses) forever: that host
				// could never start another game, and no error would ever be raised.
				//
				// `abandoned` rather than a loss: nobody chose this ending, and finish's
				// own channel lookup will find nothing and simply stamp the row.
				await finish(client, room, { abandoned: true });
				abandoned++;
			} catch (error) {
				// Per room, so one unreachable guild cannot stop the rest. This runs
				// during boot with nobody watching; a throw here would surface as a
				// startup failure in a feature that is not on the critical path.
				console.error("[game-rooms] boot recovery failed for one room", {
					guildId: room.guildId,
					roomId: room.roomId,
					error,
				});
			}
		});
	} catch (error) {
		// The QUERY failed. Log and continue to the expiry sweep: the two halves are
		// independent, and a Mongo blip on the first must not skip the second.
		console.error("[game-rooms] boot recovery scan failed", error);
	}

	// ② Catch up on expiry immediately. A bot that was down for six hours has rooms that
	// passed their archiveAt while nothing was sweeping; waiting for the first cron tick
	// would leave them visible for five more minutes for no reason.
	const { archived } = await sweepExpiredRooms(client).catch(() => ({ archived: 0, failed: 0 }));

	if (abandoned > 0) console.log(`[game-rooms] boot recovery: ${abandoned} abandoned room(s) closed`);
	if (lostTables > 0) console.log(`[game-rooms] boot recovery: ${lostTables} solo blackjack table(s) lost to the restart, room(s) closed`);
	if (dealersRestored > 0) console.log(`[game-rooms] boot recovery: ${dealersRestored} hold em dealer(s) registered again`);
	return { abandoned, lostTables, dealersRestored, archived };
}
