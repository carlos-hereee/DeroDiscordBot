import { describe, it, expect } from "vitest";
import { CHALLENGE_GAMES, openerCardEmbed, openerCardRows, type OpenerCardState } from "./challengeBoardEmbeds.js";

// ── the opener card stays inside Discord's five rows (risks R15 of item 257, R16 of item 263) ──
// Since 2026-10 item 263 Phase 2a the card posts already configured by the creation modal and
// keeps only what happens after creation: Join or Invite, Start, Edit settings and Call it off on
// the gather row, and the host's Requests and Remove a player below. Every game's card is counted
// in every state a draft can be in, at its fullest (approval on with requests waiting, bots
// seated, a buy in set, the referee and auctions on), because a sixth row or a sixth button makes
// Discord refuse the whole card edit.

const MAX_ROWS = 5;
const MAX_PER_ROW = 5;

function fullestState(game: OpenerCardState["game"], visibility: OpenerCardState["visibility"], extra: Partial<OpenerCardState> = {}): OpenerCardState {
	return {
		game,
		hostId: "host",
		visibility,
		pool: ["a", "b"],
		hostControls: { ratingBand: "close", requireApproval: true, pendingJoinCount: 2, spectatorMode: "invite" },
		bots: { count: 0 },
		casual: false,
		holdemBuyIn: 5_000,
		monopolyAuctions: true,
		referee: true,
		...extra,
	};
}

// Every game that posts a challenge card: the board's games, and a multi seat blackjack table,
// whose card the 🕹️games host posts (2026-10 item 254, Arcade 1).
const CARD_GAMES: readonly OpenerCardState["game"][] = [...CHALLENGE_GAMES, "blackjack"];

// Every state a gathering card can be drawn in, the old first step of a card posted before the
// creation modal included.
const STATES: ReadonlyArray<{ name: string; state: Partial<OpenerCardState> & Pick<OpenerCardState, "visibility"> }> = [
	{ name: "an old card at its first step", state: { visibility: null } },
	{ name: "Invite only", state: { visibility: "invite" } },
	{ name: "Open to all", state: { visibility: "public" } },
	{ name: "Open to all with Dero bots", state: { visibility: "public", casual: true, bots: { count: 3 } } },
	{ name: "open to the network", state: { visibility: "public", network: true } },
	{ name: "nobody joined yet", state: { visibility: "public", pool: [], hostControls: { ratingBand: "any", requireApproval: false, pendingJoinCount: 0, spectatorMode: "open" } } },
];

const idsOf = (state: OpenerCardState): (string | undefined)[] =>
	openerCardRows("room-1", state).flatMap((row) => row.toJSON().components.map((component) => (component as { custom_id?: string }).custom_id));

// Every control the creation modal took over (R3-13), except Add bots, which stays on the host row. Their routes stay registered, so only the
// card's rows lose them.
const SETTINGS_ACTIONS = ["vis", "dero", "auctions", "referee", "hbuyin", "approval", "casual"];
const SETTINGS_SELECTS = ["gameroomSelect:band:", "gameroomSelect:spectators:"];

describe("the challenge card's rows", () => {
	for (const game of CARD_GAMES) {
		for (const { name, state } of STATES) {
			it(`${game}, ${name}: ${MAX_ROWS} rows or fewer, ${MAX_PER_ROW} components each, and no settings control`, () => {
				const full = fullestState(game, state.visibility, state);
				const rows = openerCardRows("room-1", full);
				expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);
				for (const row of rows) expect(row.components.length).toBeLessThanOrEqual(MAX_PER_ROW);

				const ids = idsOf(full);
				for (const action of SETTINGS_ACTIONS) expect(ids.some((id) => id?.startsWith(`gameroom:${action}:`))).toBe(false);
				for (const prefix of SETTINGS_SELECTS) expect(ids.some((id) => id?.startsWith(prefix))).toBe(false);
				// The host can always change what the creation modal set.
				expect(ids).toContain("gameroom:edit:room-1");
			});
		}
	}

	// The fifth slot is an invited member's Accept and buy in, on an Invite only Hold'em card that
	// may charge one (2026-10 item 263 R3-27); an open card's joiners pay on Join instead.
	it("keeps Join or Invite, Start, Edit settings and Call it off on the gather row, with Accept and buy in fifth on an Invite only Hold'em card", () => {
		const gatherIds = (state: OpenerCardState) =>
			openerCardRows("room-1", state)[0].toJSON().components.map((component) => (component as { custom_id?: string }).custom_id?.split(":")[1]);
		expect(gatherIds(fullestState("holdem", "invite"))).toEqual(["invite", "start", "edit", "cancel", "haccept"]);
		expect(gatherIds(fullestState("holdem", "public"))).toEqual(["join", "start", "edit", "cancel"]);
		// A table that plays free (a Dero bot seat, or the network) charges nobody, so it offers no Accept.
		expect(gatherIds(fullestState("holdem", "invite", { bots: { count: 1 } }))).toEqual(["invite", "start", "edit", "cancel"]);
		expect(gatherIds(fullestState("monopoly", "invite"))).toEqual(["invite", "start", "edit", "cancel"]);
	});

	it("keeps the host's Requests and Remove a player on the row below", () => {
		const ids = idsOf(fullestState("monopoly", "public"));
		expect(ids).toContain("gameroom:requests:room-1");
		expect(ids).toContain("gameroom:kick:room-1");
		expect(ids).toContain("gameroom:bots:room-1");
	});

	it("shows the Hold'em buy in on the card as a line, set in the creation modal", () => {
		expect(JSON.stringify(openerCardEmbed(fullestState("holdem", "public")).toJSON())).toContain("Buy in");
	});

	it("strips every control from a closed card", () => {
		for (const closed of [{ cancelled: true }, { startedChannelId: "ch" }, { resultLine: "over" }]) {
			expect(openerCardRows("room-1", fullestState("monopoly", "public", closed))).toEqual([]);
		}
	});
});
