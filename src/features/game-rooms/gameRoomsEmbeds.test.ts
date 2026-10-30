import { describe, expect, it } from "vitest";
import type { APIEmbed } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { rematchedResultEmbed, roomHostRow, roomResultEmbed } from "./gameRoomsEmbeds.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── the result card (2026-10 item 276 Phase 7, audit P3) ──────────────
// A solo round against Dero has two endings the card must tell apart: Dero won, or nobody did.
// And a solo round's card names its own shorter archive window, which a rematch must drop too.

const descriptionOf = (embed: { toJSON(): APIEmbed }): string => embed.toJSON().description ?? "";
const SOLO_WINDOW = BOT_CONSTANTS.GAME_ROOM_SOLO_LUCK_ARCHIVE_DELAY_MS;

describe("roomResultEmbed", () => {
	it("names Dero when Dero won a solo round", () => {
		const text = descriptionOf(roomResultEmbed(null, false, undefined, SOLO_WINDOW, null, true));

		expect(text).toContain(gameRoomsCopy.result.houseWinnerLine);
		expect(text).not.toContain(gameRoomsCopy.result.noWinnerLine);
	});

	it("still says nobody takes it when nobody won", () => {
		expect(descriptionOf(roomResultEmbed(null, false, undefined, SOLO_WINDOW))).toContain(gameRoomsCopy.result.noWinnerLine);
	});

	it("names the member who won over everything but an abandonment", () => {
		expect(descriptionOf(roomResultEmbed("111", false, undefined, undefined, null, true))).toContain(gameRoomsCopy.result.winnerLine("111"));
		expect(descriptionOf(roomResultEmbed(null, true, undefined, undefined, null, true))).toContain(gameRoomsCopy.result.abandonedLine);
	});
});

describe("rematchedResultEmbed", () => {
	it.each([
		["an ordinary room's", BOT_CONSTANTS.GAME_ROOM_ARCHIVE_DELAY_MS],
		["a solo luck round's", SOLO_WINDOW],
	])("drops %s archive notice once a rematch takes the channel", (_label, windowMs) => {
		const posted = roomResultEmbed("111", false, undefined, windowMs).toJSON();

		const text = descriptionOf(rematchedResultEmbed(posted, "222"));

		expect(text).not.toContain(gameRoomsCopy.result.archiveNotice(windowMs));
		expect(text).toContain(gameRoomsCopy.result.rematchStarted("222"));
	});
});

// ── the opener's host row (2026-10 item 276, owner decision D17) ─────
describe("roomHostRow", () => {
	const idsOf = (row: ReturnType<typeof roomHostRow>): string[] => (row?.toJSON().components ?? []).map((button) => (button as { custom_id: string }).custom_id);

	it("gives a casual match Remove and Pass host, and a ranked match Pass host alone", () => {
		expect(idsOf(roomHostRow("holdem", "room-1", { ranked: false }))).toEqual(["gameroom:kick:room-1", "gameroom:passhost:room-1"]);
		expect(idsOf(roomHostRow("holdem", "room-1", { ranked: true }))).toEqual(["gameroom:passhost:room-1"]);
	});

	it("gives Blackjack Pass host, with no removal in play, and a solo game no row", () => {
		expect(idsOf(roomHostRow("blackjack", "room-1", { ranked: true }))).toEqual(["gameroom:passhost:room-1"]);
		expect(roomHostRow("solo-coinflip", "room-1", { ranked: false })).toBeNull();
	});
});
