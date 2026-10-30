import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

// ── Join at a dealing ranked Blackjack table (2026-10 item 276, owner decision D14) ──────────
// What is pinned here is the door's order: the table's own refusals and the host's gate before
// any chip moves, then the hold, the charge, one ledger write with the playerIds place, the
// room's overwrites, and the seat marked paid; and every way it can fail gives the chips back
// once. The table's half (the hold, dealing a paid seat in) is pinned in
// blackjackHandler.bankroll.test.ts, so here it is what the door asks for.

const table = vi.hoisted(() => ({
	refusal: null as string | null,
	hold: { ok: true, buyIn: 1000, chips: true } as { ok: true; buyIn: number; chips: boolean } | { ok: false; refusal: string },
	paid: true,
}));
vi.mock("@features/games/blackjackHandler.js", () => ({
	lateSeatRefusalOf: vi.fn(() => table.refusal),
	holdLateSeat: vi.fn(() => table.hold),
	dropLateSeat: vi.fn(),
	payLateSeat: vi.fn(() => table.paid),
	sharedTableSeatsOf: vi.fn(() => ({ userIds: ["host", "carol"], max: 5 })),
}));
const wallet = vi.hoisted(() => ({ covers: true }));
vi.mock("@features/economy/chipWallet.js", () => ({ takeChips: vi.fn(async () => wallet.covers), returnChips: vi.fn(async () => undefined) }));
const store = vi.hoisted(() => ({ seated: true as boolean, fresh: null as Record<string, unknown> | null }));
vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		addLateBlackjackSeat: vi.fn(async (_guildId: string, _roomId: string, userId: string) => (store.seated ? { ...ROOM, playerIds: [...ROOM.playerIds, userId] } : null)),
		findByRoomId: vi.fn(async () => store.fresh),
		addPendingJoin: vi.fn(async () => ({ ...ROOM, pendingJoinIds: ["carol"] })),
	},
}));
const gate = vi.hoisted(() => ({ verdict: { kind: "admit" } as { kind: string; reason?: string } }));
vi.mock("./joinGate.js", () => ({ judgeJoin: vi.fn(async () => gate.verdict) }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { applyRoomPhase: vi.fn(async () => undefined) } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn(async () => undefined) } }));
vi.mock("./blackjackChips.js", () => ({ cashOutBlackjackSeat: vi.fn(async () => true) }));
vi.mock("./challengeCard.js", () => ({ refreshTableCard: vi.fn(async () => undefined) }));
vi.mock("@utils/answerInChannel.js", () => ({ answerInChannel: vi.fn(async () => undefined) }));
vi.mock("@utils/textModal.js", () => ({ showNotice: vi.fn(async () => undefined) }));

import { TextChannel } from "discord.js";
import { joinBlackjackTable, seatAcceptedBlackjackPlayer } from "./blackjackLateSeat.js";
import { dropLateSeat, holdLateSeat, payLateSeat } from "@features/games/blackjackHandler.js";
import { returnChips, takeChips } from "@features/economy/chipWallet.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { judgeJoin } from "./joinGate.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { cashOutBlackjackSeat } from "./blackjackChips.js";
import { refreshTableCard } from "./challengeCard.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const ROOM = {
	guildId: "g1",
	roomId: "room-1",
	game: "blackjack",
	hostId: "host",
	status: "playing",
	visibility: "public",
	channelId: "room-ch",
	casual: false,
	network: false,
	playerIds: ["host"],
	pendingJoinIds: [] as string[],
	kickedIds: [] as string[],
};
const roomOf = (overrides: Partial<typeof ROOM> = {}): IGameRoom => ({ ...ROOM, ...overrides }) as unknown as IGameRoom;

const channel = Object.create(TextChannel.prototype) as TextChannel;
const client = { channels: { fetch: vi.fn(async () => channel) } };

function pressJoin(userId = "carol"): ButtonInteraction {
	return { user: { id: userId, username: userId, globalName: null }, client, guild: { members: { cache: new Map() } } } as unknown as ButtonInteraction;
}
const noticeText = (): string => ((vi.mocked(showNotice).mock.calls[0]?.[1] as { sections: string[] } | undefined)?.sections ?? []).join(" ");

beforeEach(() => {
	vi.clearAllMocks();
	table.refusal = null;
	table.hold = { ok: true, buyIn: 1000, chips: true };
	table.paid = true;
	wallet.covers = true;
	store.seated = true;
	store.fresh = null;
	gate.verdict = { kind: "admit" };
});

describe("Join at a dealing ranked table", () => {
	it("holds the seat, charges the buy in, writes it to the ledger with the player, opens the room to them and marks it paid", async () => {
		const interaction = pressJoin();
		await joinBlackjackTable(interaction, roomOf());

		expect(holdLateSeat).toHaveBeenCalledWith("room-ch", { userId: "carol", username: "carol" });
		expect(takeChips).toHaveBeenCalledOnce();
		expect(takeChips).toHaveBeenCalledWith({ userId: "carol" }, 1000);
		expect(gameRoomStore.addLateBlackjackSeat).toHaveBeenCalledWith("g1", "room-1", "carol", { userId: "carol", buyIn: 1000, stack: 1000 });
		expect(roomLifecycle.applyRoomPhase).toHaveBeenCalledWith(client, channel, expect.objectContaining({ playerIds: ["host", "carol"] }), "playing");
		expect(payLateSeat).toHaveBeenCalledWith("room-ch", "carol", client);
		expect(answerInChannel).toHaveBeenCalledWith(interaction, "here", { content: gameRoomsCopy.board.lateSeat.held(1000, true) });
		expect(returnChips).not.toHaveBeenCalled();
	});

	it("seats a free ranked table's joiner without touching a wallet or the ledger", async () => {
		table.hold = { ok: true, buyIn: 1000, chips: false };
		await joinBlackjackTable(pressJoin(), roomOf());
		expect(takeChips).not.toHaveBeenCalled();
		expect(gameRoomStore.addLateBlackjackSeat).toHaveBeenCalledWith("g1", "room-1", "carol", null);
		expect(payLateSeat).toHaveBeenCalledOnce();
	});

	it("refuses before anything is charged: a casual table, a table not playing, an Invite only table, and the table's own refusals", async () => {
		const cases: Array<[IGameRoom, string]> = [
			[roomOf({ casual: true }), gameRoomsCopy.board.lateSeat.tableClosed],
			[roomOf({ status: "finished" }), gameRoomsCopy.board.lateSeat.tableClosed],
			[roomOf({ visibility: "invite" }), gameRoomsCopy.board.lateSeat.inviteOnly],
		];
		for (const [room, refusal] of cases) {
			vi.mocked(showNotice).mockClear();
			await joinBlackjackTable(pressJoin(), room);
			expect(noticeText()).toBe(refusal);
		}
		for (const [refusal, words] of [
			["full", gameRoomsCopy.board.lateSeat.full],
			["alreadySeated", gameRoomsCopy.board.lateSeat.alreadySeated],
			["alreadyPlayed", gameRoomsCopy.board.lateSeat.alreadyPlayed],
		] as const) {
			vi.mocked(showNotice).mockClear();
			table.refusal = refusal;
			await joinBlackjackTable(pressJoin(), roomOf());
			expect(noticeText()).toBe(words);
		}
		expect(judgeJoin).not.toHaveBeenCalled();
		expect(holdLateSeat).not.toHaveBeenCalled();
		expect(takeChips).not.toHaveBeenCalled();
	});

	it("refuses a removed member at the host's gate, and files a request where the host approves each joiner, charging nothing", async () => {
		gate.verdict = { kind: "refuse", reason: "kicked" };
		await joinBlackjackTable(pressJoin(), roomOf());
		expect(noticeText()).toBe(rokCommanderCopy.arcadeHostControls.kick.refusedRejoin);

		gate.verdict = { kind: "ask" };
		const asking = pressJoin();
		await joinBlackjackTable(asking, roomOf({ requireApproval: true } as never));
		expect(gameRoomStore.addPendingJoin).toHaveBeenCalledWith("g1", "room-1", "carol");
		expect(answerInChannel).toHaveBeenCalledWith(asking, "here", { content: rokCommanderCopy.arcadeHostControls.approval.asked });
		expect(refreshTableCard).toHaveBeenCalledOnce();
		expect(takeChips).not.toHaveBeenCalled();
	});

	it("charges a double press once: the second meets the hold", async () => {
		await joinBlackjackTable(pressJoin(), roomOf());
		table.hold = { ok: false, refusal: "alreadySeated" };
		await joinBlackjackTable(pressJoin(), roomOf());
		expect(takeChips).toHaveBeenCalledOnce();
		expect(noticeText()).toBe(gameRoomsCopy.board.lateSeat.alreadySeated);
	});

	it("lets the hold go on a short wallet, writing nothing", async () => {
		wallet.covers = false;
		await joinBlackjackTable(pressJoin(), roomOf());
		expect(dropLateSeat).toHaveBeenCalledWith("room-ch", "carol");
		expect(gameRoomStore.addLateBlackjackSeat).not.toHaveBeenCalled();
		expect(noticeText()).toBe(gameRoomsCopy.holdem.notEnoughChips(1000));
	});

	it("gives the buy in straight back when the ledger write applies nothing, naming a removal", async () => {
		store.seated = false;
		store.fresh = { ...ROOM, kickedIds: ["carol"] };
		await joinBlackjackTable(pressJoin(), roomOf());
		expect(returnChips).toHaveBeenCalledOnce();
		expect(returnChips).toHaveBeenCalledWith({ userId: "carol" }, 1000);
		expect(dropLateSeat).toHaveBeenCalledWith("room-ch", "carol");
		expect(payLateSeat).not.toHaveBeenCalled();
		expect(noticeText()).toBe(rokCommanderCopy.arcadeHostControls.kick.refusedRejoin);
	});

	it("pays the ledger entry back through its claim when the table ended after the write", async () => {
		table.paid = false;
		await joinBlackjackTable(pressJoin(), roomOf());
		expect(cashOutBlackjackSeat).toHaveBeenCalledOnce();
		expect(cashOutBlackjackSeat).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room-1" }), "carol", 1000);
		expect(returnChips).not.toHaveBeenCalled();
		expect(noticeText()).toBe(gameRoomsCopy.board.lateSeat.tableClosed);
	});
});

describe("an accepted request at a dealing table", () => {
	it("seats the member the way their own Join would, answering null, or the refusal for the host's summary", async () => {
		expect(await seatAcceptedBlackjackPlayer(client as never, roomOf(), "carol", "Carol")).toBeNull();
		expect(gameRoomStore.addLateBlackjackSeat).toHaveBeenCalledOnce();
		table.hold = { ok: false, refusal: "full" };
		expect(await seatAcceptedBlackjackPlayer(client as never, roomOf(), "dave", "Dave")).toBe(gameRoomsCopy.board.lateSeat.full);
	});
});
