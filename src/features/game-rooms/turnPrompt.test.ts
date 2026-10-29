import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client, ModalSubmitInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: vi.fn(), claimTurnPrompt: vi.fn(), setTurnPromptPlayed: vi.fn(), setTurnPromptLayout: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postTurnPrompt: vi.fn() }, resolveRoomChannel: vi.fn() }));

import { handleTurnMovePress, handleTurnPress, handleTurnSubmit, syncTurnPrompt, turnButtonId, type TurnAdapter } from "./turnPrompt.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { resolveRoomChannel, roomTrail } from "./roomTrail.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the shared turn prompt (2026-10 item 257 Phase 4a) ──
// One line per turn that pings the member on the clock, a modal that is their hand, a Submit
// that re-checks the turn, and a spent line edited to say how it ended. Driven with a fake
// game, so what is pinned is the shared piece and not any one game's rules.

const storeMock = gameRoomStore as unknown as Record<"findByRoomId" | "claimTurnPrompt" | "setTurnPromptPlayed" | "setTurnPromptLayout", ReturnType<typeof vi.fn>>;
const trailMock = roomTrail as unknown as { postTurnPrompt: ReturnType<typeof vi.fn> };
const channelMock = resolveRoomChannel as unknown as ReturnType<typeof vi.fn>;

const A = "player-a";
const B = "player-b";
const BOT = "dero-bot-red";
const client = {} as Client;

// The turn the fake game is on: who is on the clock, and the fingerprint of that turn.
const turn = { who: A as string | null, fingerprint: "t1", extra: [] as never[] };
const applied = vi.fn();

const adapter: TurnAdapter = {
	game: "holdem",
	whoseTurn: () => turn.who,
	fingerprintOf: () => turn.fingerprint,
	view: (_room, userId) => (userId === turn.who ? { title: "Your turn", text: ["A♠ K♥"], fields: [{ kind: "select", id: "move", label: "Your move", options: [{ label: "Fold", value: "fold" }] }] } : null),
	apply: async (...args) => applied(...args),
	extraButtons: () => turn.extra,
};
const lookup = () => adapter;

function row(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return { roomId: "room-1", guildId: "guild-1", game: "holdem", status: "playing", channelId: "ch-1", playerIds: [A, B], network: false, satellites: [], turnPrompt: { fingerprint: null, messageId: null, playerId: null, layout: null, played: false }, ...overrides } as unknown as IGameRoom;
}

const sentMessage = (id = "m-new") => ({ id, delete: vi.fn().mockResolvedValue(undefined), edit: vi.fn().mockResolvedValue(undefined) });

beforeEach(() => {
	vi.clearAllMocks();
	turn.who = A;
	turn.fingerprint = "t1";
	turn.extra = [];
	applied.mockResolvedValue({ ok: true });
	storeMock.findByRoomId.mockImplementation(async () => row());
	storeMock.claimTurnPrompt.mockResolvedValue(row());
	storeMock.setTurnPromptPlayed.mockResolvedValue({});
	trailMock.postTurnPrompt.mockResolvedValue(sentMessage());
	channelMock.mockResolvedValue({ messages: { fetch: vi.fn().mockResolvedValue(null) } });
});

describe("posting the prompt", () => {
	it("pings the member on the clock with each move as its own button, and no modal when nothing needs typing", async () => {
		await syncTurnPrompt(client, row(), adapter);

		const [, , prompt] = trailMock.postTurnPrompt.mock.calls[0];
		expect(prompt.playerId).toBe(A);
		expect(prompt.text).toBe(gameRoomsCopy.turnPrompt.line(A));
		const buttons = prompt.components.flatMap((component: { toJSON(): { components: { custom_id: string; label: string }[] } }) => component.toJSON().components);
		expect(buttons).toEqual([expect.objectContaining({ custom_id: "gameroom:tmove:room-1:t1:fold", label: "Fold" })]);
		expect(storeMock.claimTurnPrompt).toHaveBeenCalledWith("guild-1", "room-1", null, expect.objectContaining({ fingerprint: "t1", messageId: "m-new", playerId: A }));
	});

	it("posts nothing again for a turn it already prompted", async () => {
		storeMock.findByRoomId.mockResolvedValue(row({ turnPrompt: { fingerprint: "t1", messageId: "m-old", playerId: A, layout: turnButtonId("room-1", "t1"), played: false } }));

		await syncTurnPrompt(client, row(), adapter);

		expect(trailMock.postTurnPrompt).not.toHaveBeenCalled();
	});

	it("gives a Dero bot seat on the clock no prompt, and takes the last one down", async () => {
		turn.who = BOT;
		storeMock.findByRoomId.mockResolvedValue(row({ turnPrompt: { fingerprint: "t0", messageId: "m-old", playerId: A, layout: "", played: false } }));
		storeMock.claimTurnPrompt.mockResolvedValue(row({ turnPrompt: { fingerprint: "t0", messageId: "m-old", playerId: A, layout: "", played: false } }));

		await syncTurnPrompt(client, row(), adapter);

		expect(trailMock.postTurnPrompt).not.toHaveBeenCalled();
		expect(storeMock.claimTurnPrompt).toHaveBeenCalledWith("guild-1", "room-1", "t0", { fingerprint: null, messageId: null, playerId: null, layout: null });
	});

	it("prompts neither a finished room nor a network table", async () => {
		storeMock.findByRoomId.mockResolvedValue(row({ status: "finished" }));
		await syncTurnPrompt(client, row(), adapter);
		await syncTurnPrompt(client, row({ network: true }), adapter);

		expect(trailMock.postTurnPrompt).not.toHaveBeenCalled();
	});

	it("deletes its own line when another sync claimed the turn first", async () => {
		const posted = sentMessage();
		trailMock.postTurnPrompt.mockResolvedValue(posted);
		storeMock.claimTurnPrompt.mockResolvedValue(null);

		await syncTurnPrompt(client, row(), adapter);

		expect(posted.delete).toHaveBeenCalledOnce();
	});

	it("carries Monopoly style extra buttons on the row below the moves", async () => {
		const { ButtonBuilder, ButtonStyle } = await import("discord.js");
		turn.extra = [new ButtonBuilder().setCustomId("gameroom:mtrade:room-1").setLabel("Trade").setStyle(ButtonStyle.Secondary)] as never[];

		await syncTurnPrompt(client, row(), adapter);

		const [, , prompt] = trailMock.postTurnPrompt.mock.calls[0];
		const ids = prompt.components.map((component: { toJSON(): { components: { custom_id: string }[] } }) => component.toJSON().components.map((button) => button.custom_id));
		expect(ids).toEqual([["gameroom:tmove:room-1:t1:fold"], ["gameroom:mtrade:room-1"]]);
	});

	it("keeps Take your turn beside the moves when a move can take a typed amount", async () => {
		const typed: TurnAdapter = {
			...adapter,
			view: () => ({ title: "Your turn", text: [], fields: [{ kind: "select", id: "move", label: "Your move", options: [{ label: "Call", value: "call" }, { label: "Raise", value: "raise" }] }, { kind: "text", id: "amount", label: "Raise to", placeholder: "", maxLength: 9 }] }),
		};

		await syncTurnPrompt(client, row(), typed);

		const [, , prompt] = trailMock.postTurnPrompt.mock.calls[0];
		const ids = prompt.components.flatMap((component: { toJSON(): { components: { custom_id: string }[] } }) => component.toJSON().components.map((button) => button.custom_id));
		expect(ids).toEqual(["gameroom:tmove:room-1:t1:call", "gameroom:tmove:room-1:t1:raise", turnButtonId("room-1", "t1")]);
	});

	it("keeps only Take your turn for a turn of two picks (a Battleship shot)", async () => {
		const twoPicks: TurnAdapter = {
			...adapter,
			view: () => ({ title: "Fire", text: [], fields: [{ kind: "select", id: "file", label: "Column", options: [{ label: "A", value: "0" }] }, { kind: "select", id: "rank", label: "Row", options: [{ label: "1", value: "0" }] }] }),
		};

		await syncTurnPrompt(client, row(), twoPicks);

		const [, , prompt] = trailMock.postTurnPrompt.mock.calls[0];
		const ids = prompt.components.flatMap((component: { toJSON(): { components: { custom_id: string }[] } }) => component.toJSON().components.map((button) => button.custom_id));
		expect(ids).toEqual([turnButtonId("room-1", "t1")]);
	});
});

describe("retiring the line a turn left behind", () => {
	const previous = { fingerprint: "t0", messageId: "m-old", playerId: B, layout: "x", played: false };

	async function nextTurn(played: boolean) {
		const oldLine = sentMessage("m-old");
		channelMock.mockResolvedValue({ messages: { fetch: vi.fn().mockResolvedValue(oldLine) } });
		storeMock.findByRoomId.mockResolvedValue(row({ turnPrompt: previous }));
		storeMock.claimTurnPrompt.mockResolvedValue(row({ turnPrompt: { ...previous, played } }));
		await syncTurnPrompt(client, row(), adapter);
		return oldLine;
	}

	it("says it was played when the move came through the modal, and drops the button", async () => {
		const oldLine = await nextTurn(true);
		expect(oldLine.edit).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.turnPrompt.playedLine(B), components: [] }));
	});

	it("says the turn passed when it ended any other way (the clock, a board button)", async () => {
		const oldLine = await nextTurn(false);
		expect(oldLine.edit).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.turnPrompt.passedLine(B), components: [] }));
	});

	it("never pings from a spent line", async () => {
		const oldLine = await nextTurn(true);
		expect(oldLine.edit).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
	});
});

function press(userId: string): ButtonInteraction {
	return { id: "i-1", user: { id: userId }, client, showModal: vi.fn().mockResolvedValue(undefined), reply: vi.fn().mockResolvedValue(undefined), deferred: false, replied: false } as unknown as ButtonInteraction;
}
const modalsOf = (interaction: { showModal: unknown }) => (interaction.showModal as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { toJSON(): { custom_id: string; components: unknown[] } }).toJSON());
const noticeOf = (interaction: { showModal: unknown }): string => JSON.stringify(modalsOf(interaction).filter((modal) => modal.custom_id.startsWith("notice:")));

describe("Take your turn", () => {
	it("opens the modal for the member on the clock from the row already in hand, with no read", async () => {
		const interaction = press(A);

		await handleTurnPress(interaction, row(), "t1", lookup);

		const [modal] = modalsOf(interaction);
		expect(modal.custom_id).toBe("gameroomModal:turn:room-1:t1");
		expect(JSON.stringify(modal.components)).toContain("A♠ K♥");
		expect(storeMock.findByRoomId).not.toHaveBeenCalled();
	});

	it("refuses anybody who is not on the clock", async () => {
		const interaction = press(B);
		await handleTurnPress(interaction, row(), "t1", lookup);
		expect(noticeOf(interaction)).toContain(gameRoomsCopy.turnPrompt.notYourTurn);
	});

	it("refuses a button whose turn has passed", async () => {
		turn.fingerprint = "t2";
		const interaction = press(A);
		await handleTurnPress(interaction, row(), "t1", lookup);
		expect(noticeOf(interaction)).toContain(gameRoomsCopy.turnPrompt.turnPassed);
	});
});

function submit(userId: string, fingerprint = "t1"): ModalSubmitInteraction {
	return {
		id: "i-2",
		customId: `gameroomModal:turn:room-1:${fingerprint}`,
		guildId: "guild-1",
		user: { id: userId },
		client,
		fields: { getStringSelectValues: () => ["fold"], getTextInputValue: () => "" },
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		reply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		deferred: false,
		replied: false,
	} as unknown as ModalSubmitInteraction;
}
const repliedWith = (interaction: ModalSubmitInteraction): string => JSON.stringify([(interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls, (interaction.followUp as unknown as ReturnType<typeof vi.fn>).mock.calls]);

describe("the modal's Submit", () => {
	beforeEach(() => storeMock.findByRoomId.mockResolvedValue(row()));

	it("refuses a Submit for a turn that has passed (risk R4), playing nothing", async () => {
		turn.fingerprint = "t2";
		const interaction = submit(A, "t1");

		await handleTurnSubmit(interaction, lookup);

		expect(applied).not.toHaveBeenCalled();
		expect(repliedWith(interaction)).toContain(gameRoomsCopy.turnPrompt.turnPassed);
	});

	it("refuses a Submit from a member who is not on the clock", async () => {
		const interaction = submit(B);
		await handleTurnSubmit(interaction, lookup);
		expect(applied).not.toHaveBeenCalled();
		expect(repliedWith(interaction)).toContain(gameRoomsCopy.turnPrompt.notYourTurn);
	});

	it("plays the move through the adapter, marks the turn played first, and acknowledges once it is claimed", async () => {
		applied.mockImplementation(async (_client, _room, _userId, _answers, acknowledge: () => Promise<unknown>) => {
			await acknowledge();
			return { ok: true };
		});
		const interaction = submit(A);

		await handleTurnSubmit(interaction, lookup);

		expect(storeMock.setTurnPromptPlayed).toHaveBeenNthCalledWith(1, "guild-1", "room-1", "t1", true);
		expect(applied).toHaveBeenCalledWith(client, expect.anything(), A, { move: "fold" }, expect.any(Function));
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
	});

	it("takes the played mark back and answers privately when the game refuses the move", async () => {
		applied.mockResolvedValue({ ok: false, reason: "That is not a legal action right now." });
		const interaction = submit(A);

		await handleTurnSubmit(interaction, lookup);

		expect(storeMock.setTurnPromptPlayed).toHaveBeenLastCalledWith("guild-1", "room-1", "t1", false);
		expect(repliedWith(interaction)).toContain("That is not a legal action right now.");
	});
});

// ── a move played from its own button ──────────────────────────────────
function movePress(userId: string, value: string, fingerprint = "t1"): ButtonInteraction {
	return {
		id: "i-3",
		customId: `gameroom:tmove:room-1:${fingerprint}:${value}`,
		guildId: "guild-1",
		user: { id: userId },
		client,
		showModal: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		reply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		deferred: false,
		replied: false,
	} as unknown as ButtonInteraction;
}

describe("a move button", () => {
	beforeEach(() => storeMock.findByRoomId.mockResolvedValue(row()));

	it("plays its one move through the adapter in a single press, with no modal", async () => {
		const interaction = movePress(A, "fold");

		await handleTurnMovePress(interaction, lookup);

		expect(applied).toHaveBeenCalledWith(client, expect.anything(), A, { move: "fold" }, expect.any(Function));
		expect(storeMock.setTurnPromptPlayed).toHaveBeenNthCalledWith(1, "guild-1", "room-1", "t1", true);
		expect(interaction.showModal).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ custom_id: expect.stringMatching(/^gameroomModal:turn/) }) }));
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
	});

	it("keeps a colon inside the move's value (Monopoly's buy:<lot>)", async () => {
		const buying: TurnAdapter = { ...adapter, view: () => ({ title: "Your turn", text: [], fields: [{ kind: "select", id: "move", label: "Your move", options: [{ label: "Buy", value: "buy:boardwalk" }] }] }) };

		await handleTurnMovePress(movePress(A, "buy:boardwalk"), () => buying);

		expect(applied).toHaveBeenCalledWith(client, expect.anything(), A, { move: "buy:boardwalk" }, expect.any(Function));
	});

	it("refuses a move the turn no longer offers, a passed turn and anybody off the clock, playing nothing", async () => {
		await handleTurnMovePress(movePress(A, "roll"), lookup);
		await handleTurnMovePress(movePress(A, "fold", "t0"), lookup);
		await handleTurnMovePress(movePress(B, "fold"), lookup);

		expect(applied).not.toHaveBeenCalled();
	});
});
