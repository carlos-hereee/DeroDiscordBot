import { describe, it, expect } from "vitest";
import { CHALLENGE_GAMES, openerCardEmbed, openerCardRows, type OpenerCardState } from "./challengeBoardEmbeds.js";

// ── the opener card stays inside Discord's five rows (risk R15, 2026-10 item 257 Phase 4a) ──
// Every game's card, at the visibility step and at the gather step, in the fullest state its
// host controls can reach: approval on with requests waiting, Dero bots offered, the band and
// spectator selects showing, and the Hold'em buy in set. A sixth row would make Discord refuse
// the whole card edit, so this counts rows per game and step rather than trusting a design.

const MAX_ROWS = 5;
const MAX_PER_ROW = 5;

function fullestState(game: OpenerCardState["game"], visibility: OpenerCardState["visibility"]): OpenerCardState {
	return {
		game,
		hostId: "host",
		visibility,
		pool: ["a", "b"],
		allowPublic: true,
		allowNetwork: true,
		hostControls: { ratingBand: "close", requireApproval: true, pendingJoinCount: 2, spectatorMode: "invite" },
		bots: { count: 0 },
		casual: false,
		holdemBuyIn: 5_000,
		monopolyAuctions: true,
		monopolyReferee: true,
	};
}

describe("the challenge card's rows", () => {
	for (const game of CHALLENGE_GAMES) {
		for (const visibility of [null, "invite", "public"] as const) {
			it(`${game} at ${visibility ?? "the visibility step"} holds ${MAX_ROWS} rows or fewer, ${MAX_PER_ROW} components each`, () => {
				const rows = openerCardRows("room-1", fullestState(game, visibility));
				expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);
				for (const row of rows) expect(row.components.length).toBeLessThanOrEqual(MAX_PER_ROW);
			});
		}
	}

	it("offers the Hold'em host a Set the buy in button on the gather row, and shows the amount on the card", () => {
		const state = fullestState("holdem", "public");
		const ids = openerCardRows("room-1", state).flatMap((row) => row.toJSON().components.map((component) => (component as { custom_id?: string }).custom_id));
		expect(ids).toContain("gameroom:hbuyin:room-1");
		expect(JSON.stringify(openerCardEmbed(state).toJSON())).toContain("Buy in");
	});

	it("offers no buy in on another game's card, on a network table, or with a Dero bot seat", () => {
		const idsOf = (state: OpenerCardState) => openerCardRows("room-1", state).flatMap((row) => row.toJSON().components.map((component) => (component as { custom_id?: string }).custom_id));
		expect(idsOf(fullestState("monopoly", "public"))).not.toContain("gameroom:hbuyin:room-1");
		expect(idsOf({ ...fullestState("holdem", "public"), network: true })).not.toContain("gameroom:hbuyin:room-1");
		expect(idsOf({ ...fullestState("holdem", "public"), bots: { count: 2 } })).not.toContain("gameroom:hbuyin:room-1");
	});
});
