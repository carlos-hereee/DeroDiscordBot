import type { Client, TextChannel } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { playSoloLuckInChannel, type SoloLuckPlay } from "@features/games/soloLuck.js";
import { RPS_CHOICES, type RpsChoice } from "@features/games/rpsWinner.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { resolveRoomChannel } from "./roomTrail.js";
import { syncTurnPrompt, type TurnAdapter } from "./turnPrompt.js";
import type { SoloHost } from "./soloRooms.js";

// ── soloLuckRoom ─────────────────────────────────────────────────────
// What:  a round against Dero played in its solo room, and the turn adapter that lets the
//        rock paper scissors room ask for the throw IN the room (2026-10 item 257 Phase 4b,
//        owner item 14). A coin flip or a dice roll needs no choice, so it plays the moment
//        its room opens; rock paper scissors opens first, pings its member with Take your
//        turn, and Dero throws on the modal's Submit.
// Who:   soloRooms.openSoloRoom for the coin and the dice; the turn prompt for the throw,
//        whose adapter seedRoom syncs when a solo-rps room (first match or rematch) opens.
// Does NOT: resolve or pay the round, which stays soloLuck's, shared with /mini-game and
//        the 🕹️games row so the odds and the pay cannot drift between the doors.
// How:   every door ends in playSoloLuckRoom, which posts the round and finishes the room
//        on the short solo luck window, so finish stays the one writer of a date into
//        archiveAt and a solo-rps room's Rematch plays the next round in the same channel.

const SOLO_LUCK_ARCHIVE_DELAY_MS = BOT_CONSTANTS.GAME_ROOM_SOLO_LUCK_ARCHIVE_DELAY_MS;

/**
 * Play one round against Dero into its room and finish the room. A round that cannot be
 * posted, or arrives with no play, closes the room as abandoned, which pays nothing, rather
 * than leaving the member's one room slot held. Either way the channel goes on the short solo
 * luck window, since a single round has no match to scroll back.
 */
export async function playSoloLuckRoom(client: Client, room: IGameRoom, channel: TextChannel | null, host: SoloHost, play: SoloLuckPlay | undefined): Promise<void> {
	const user = host.user ?? (await client.users.fetch(host.userId).catch(() => null));
	const result = play && user && channel ? await playSoloLuckInChannel(channel, { user, displayName: host.displayName }, play) : null;
	if (!result) {
		await roomLifecycle.finish(client, room, { abandoned: true, archiveDelayMs: SOLO_LUCK_ARCHIVE_DELAY_MS });
		return;
	}
	await roomLifecycle.finish(client, room, { winnerId: result.outcome === "won" ? host.userId : null, archiveDelayMs: SOLO_LUCK_ARCHIVE_DELAY_MS });
}

// ── the throw, asked in the room ──────────────────────────────────────
// The throw rides the row's secret, written once through claimSecretField: that write is the
// claim, so two Submits racing for the one throw play one round and pay once.
const THROW_FIELD = "throw";
// A solo-rps row has exactly one turn, so one fingerprint serves it; a rematch is a new row
// with a prompt record of its own.
const THROW_FINGERPRINT = "throw";

const isRpsChoice = (value: string | undefined): value is RpsChoice => (RPS_CHOICES as readonly (string | undefined)[]).includes(value);

const thrownAlready = (room: IGameRoom): boolean => {
	const secret = room.secret as unknown as Partial<Record<typeof THROW_FIELD, RpsChoice>> | null;
	return Boolean(secret?.[THROW_FIELD]);
};

async function hostOf(client: Client, room: IGameRoom, userId: string): Promise<SoloHost> {
	const guild = client.guilds.cache.get(room.guildId);
	const member = guild ? (guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null))) : null;
	return { userId, displayName: member?.displayName ?? member?.user.username ?? userId, ...(member ? { user: member.user } : {}) };
}

/** The solo-rps room's turn: its member picks a throw, and Dero answers on Submit. */
export const soloRpsTurnAdapter: TurnAdapter = {
	game: "solo-rps",
	whoseTurn: (room) => (room.status === "playing" && !thrownAlready(room) ? room.hostId : null),
	fingerprintOf: (room) => (thrownAlready(room) ? null : THROW_FINGERPRINT),
	view(room) {
		if (thrownAlready(room)) return null;
		const words = gameRoomsCopy.board;
		return {
			title: words.deroThrowModalTitle,
			text: [words.deroThrowPrompt],
			fields: [
				{
					kind: "select",
					id: THROW_FIELD,
					label: words.deroThrowLabel,
					options: RPS_CHOICES.map((choice) => ({ label: gameRoomsCopy.games.rpsLabel(choice), value: choice })),
				},
			],
		};
	},
	async apply(client, room, userId, answers, acknowledge) {
		// The value is user input whoever built the select, so it is checked against the throws.
		const memberThrow = answers[THROW_FIELD];
		if (!isRpsChoice(memberThrow)) return { ok: false, reason: gameRoomsCopy.errors.controlRetired };
		const claimed = await gameRoomStore.claimSecretField(room.guildId, room.roomId, THROW_FIELD, memberThrow);
		if (!claimed) return { ok: false, reason: gameRoomsCopy.turnPrompt.turnPassed };
		await acknowledge();

		const channel = await resolveRoomChannel(client, room.channelId);
		await playSoloLuckRoom(client, claimed, channel, await hostOf(client, room, userId), { game: "rps", memberThrow });
		// The room is finished now, so this retires the Take your turn line as played.
		await syncTurnPrompt(client, claimed, soloRpsTurnAdapter);
		return { ok: true };
	},
};
