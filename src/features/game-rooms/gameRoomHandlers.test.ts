import { describe, it, expect, vi, beforeEach } from "vitest";
import { InteractionType, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: vi.fn(), markArchived: vi.fn(), findOpenByHost: vi.fn(), update: vi.fn() },
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: { findByGuildId: vi.fn() },
}));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: vi.fn() }));
vi.mock("./roomLifecycle.js", () => ({
	roomLifecycle: { archiveNow: vi.fn(), finish: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));

import { _handleGameRoomButton, _handleGameRoomConfirm } from "./gameRoomHandlers.js";
import { parseGameRoomCustomId } from "./gameRoomActions.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { roomTrail } from "./roomTrail.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

const storeMock = gameRoomStore as unknown as { findByRoomId: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
const gateMock = gateOwnerOrAdmin as unknown as ReturnType<typeof vi.fn>;
const lifecycleMock = roomLifecycle as unknown as {
	archiveNow: ReturnType<typeof vi.fn>;
	finish: ReturnType<typeof vi.fn>;
};
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };

const makeRoom = (overrides: Record<string, unknown> = {}) => ({
	roomId: "room-1",
	guildId: "guild-1",
	hostId: "host-1",
	playerIds: ["host-1", "player-2"],
	channelId: "ch-room",
	...overrides,
});

function makeInteraction(customId: string, userId = "host-1"): ButtonInteraction {
	return {
		customId,
		guildId: "guild-1",
		guild: { id: "guild-1" },
		user: { id: userId },
		client: { user: { id: "bot-1" } },
		reply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

const replyText = (interaction: ButtonInteraction): string =>
	((interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content?: string }).content ?? "";

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.findByRoomId.mockResolvedValue(makeRoom());
	gateMock.mockResolvedValue(false);
	lifecycleMock.archiveNow.mockResolvedValue({ ok: true });
	lifecycleMock.finish.mockResolvedValue(undefined);
	trailMock.postMove.mockResolvedValue(true);
});

describe("parseGameRoomCustomId", () => {
	it("parses a known control", () => {
		expect(parseGameRoomCustomId("gameroom:archive:room-1")).toEqual({
			action: "archive",
			tail: "room-1",
			arg: undefined,
		});
	});

	// `vis` is the one control carrying a fourth segment. Dropping it would silently
	// default every visibility choice to invite, so a public room could never be made
	// and nothing would report an error.
	it("keeps the fourth segment for the visibility chooser", () => {
		expect(parseGameRoomCustomId("gameroom:vis:room-1:public")).toEqual({
			action: "vis",
			tail: "room-1",
			arg: "public",
		});
	});

	// `new` carries a game SLUG rather than a roomId, because it runs before any room
	// exists. The parser must not assume otherwise.
	it("parses the pre-room control, whose tail is a game slug", () => {
		expect(parseGameRoomCustomId("gameroom:new:rps")).toEqual({ action: "new", tail: "rps", arg: undefined });
	});

	// customIds live as long as the messages carrying them, so a control retired two
	// deploys ago is still clickable by anyone scrolling back. That is the ordinary
	// case here, not an attack.
	it.each([
		["a foreign prefix", "powerup:archive:room-1"],
		["an unknown action", "gameroom:selfdestruct:room-1"],
		["a missing tail", "gameroom:archive"],
		["garbage", "nonsense"],
	])("returns null for %s", (_label, customId) => {
		expect(parseGameRoomCustomId(customId)).toBeNull();
	});
});

describe("gameRoomHandlers routing", () => {
	it("answers an unknown control honestly instead of crashing", async () => {
		const interaction = makeInteraction("gameroom:selfdestruct:room-1");
		await _handleGameRoomButton(interaction);
		expect(replyText(interaction)).toContain("no longer available");
	});

	// A cancelled draft's card, and a finished room's, both stay scrollable forever
	// with their buttons attached. Refusing by STATUS is what stops a stale press
	// re-opening something that is over; hiding the buttons would only be a hint.
	it("refuses a board control once the draft is no longer a draft", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "archived" }));
		const interaction = makeInteraction("gameroom:join:room-1", "player-9");

		await _handleGameRoomButton(interaction);

		expect(replyText(interaction)).toContain("no longer open");
	});

	// ⚠️ GUILD SCOPING IS A SECURITY BOUNDARY (invariant 2). The roomId rides a
	// customId anyone can read and replay, so a room in another guild must read as NOT
	// FOUND rather than forbidden; "forbidden" would confirm it exists.
	it("scopes the room lookup to the clicking guild", async () => {
		const interaction = makeInteraction("gameroom:archive:room-1");
		await _handleGameRoomButton(interaction);
		expect(storeMock.findByRoomId).toHaveBeenCalledWith("guild-1", "room-1");
	});

	it("reports a missing room as not found", async () => {
		storeMock.findByRoomId.mockResolvedValue(null);
		const interaction = makeInteraction("gameroom:archive:room-1");

		await _handleGameRoomButton(interaction);

		expect(replyText(interaction)).toContain("no longer exists");
		expect(lifecycleMock.archiveNow).not.toHaveBeenCalled();
	});
});

// ── the confirms (2026-10 item 257, owner item 12) ──
// A press only asks; the action runs in the confirm's Submit (a modal under the button
// prefix) or in the button of the private reply a confirm falls back to. Closing the modal
// sends nothing to the bot, so "the press alone did nothing" is that case.

// A press that can open a modal, as a real button can.
function pressWithModal(customId: string, userId = "host-1"): ButtonInteraction & { showModal: ReturnType<typeof vi.fn> } {
	return { ...makeInteraction(customId, userId), id: "int-1", showModal: vi.fn().mockResolvedValue(undefined) } as unknown as ButtonInteraction & {
		showModal: ReturnType<typeof vi.fn>;
	};
}

// A confirm's Submit, from a modal opened by a message button.
function submit(customId: string, userId = "host-1"): ModalSubmitInteraction & { deferUpdate: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> } {
	return {
		type: InteractionType.ModalSubmit,
		customId,
		guildId: "guild-1",
		guild: { id: "guild-1" },
		channelId: "ch-room",
		user: { id: userId },
		client: { user: { id: "bot-1" } },
		deferred: false,
		replied: false,
		isFromMessage: () => true,
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		reply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModalSubmitInteraction & { deferUpdate: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> };
}

const modalIdOf = (press: { showModal: ReturnType<typeof vi.fn> }): string => (press.showModal.mock.calls[0][0] as { data: { custom_id: string } }).data.custom_id;

describe("archive and forfeit ask first", () => {
	it.each([
		["archive", "host-1", "gameroom:archiveok:room-1"],
		["forfeit", "player-2", "gameroom:forfeitok:room-1"],
	])("the %s press opens a confirm and touches nothing", async (action, userId, confirmId) => {
		const press = pressWithModal(`gameroom:${action}:room-1`, userId);

		await _handleGameRoomButton(press);

		expect(modalIdOf(press)).toBe(confirmId);
		expect(lifecycleMock.archiveNow).not.toHaveBeenCalled();
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});

	// Leave table and End table, Hold'em's two ways out, ask the same way: the press writes
	// nothing and the table's own handlers run only from the confirm.
	it.each([
		["hleave", "player-2", "gameroom:hleaveok:room-1"],
		["hend", "host-1", "gameroom:hendok:room-1"],
	])("the Hold'em %s press opens a confirm and touches nothing", async (action, userId, confirmId) => {
		// A running table with the presser seated: the press reads the table before it asks (2026-10 item 263 R3-6).
		const secret = { status: "playing", seats: [{ userId: "host-1", out: false }, { userId: "player-2", out: false }] };
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ game: "holdem", status: "playing", secret }));
		const press = pressWithModal(`gameroom:${action}:room-1`, userId);

		await _handleGameRoomButton(press);

		expect(modalIdOf(press)).toBe(confirmId);
		expect(storeMock.findByRoomId).toHaveBeenCalledOnce();
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});

	// R3-6: a state the press can read is refused there, in a notice titled for Hold'em, so the
	// confirm's Submit meets it only when the table moved while the confirm stood open.
	it.each([
		["hleave", "player-2", { status: "finished", seats: [{ userId: "player-2", out: false }] }, gameRoomsCopy.holdem.tournamentOver],
		["hleave", "player-2", { status: "playing", seats: [{ userId: "player-2", out: true }] }, gameRoomsCopy.holdem.notSeated],
		["hend", "host-1", { status: "finished", seats: [] }, gameRoomsCopy.holdem.tournamentOver],
	])("the Hold'em %s press refuses before its confirm when it can already tell", async (action, userId, secret, refusal) => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ game: "holdem", status: "playing", secret }));
		const press = pressWithModal(`gameroom:${action}:room-1`, userId);

		await _handleGameRoomButton(press);

		const modal = press.showModal.mock.calls[0][0] as { data: { custom_id: string; title: string } };
		expect(modal.data.custom_id).toMatch(/^notice:/);
		expect(modal.data.title).toBe(gameRoomsCopy.notices.holdem);
		expect(JSON.stringify(modal.toJSON())).toContain(refusal);
	});

	it("the forfeit press refuses a match that is already over", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "finished" }));
		const press = pressWithModal("gameroom:forfeit:room-1", "player-2");

		await _handleGameRoomButton(press);

		const modal = press.showModal.mock.calls[0][0] as { data: { custom_id: string } };
		expect(modal.data.custom_id).toMatch(/^notice:/);
		expect(JSON.stringify(modal)).toContain(gameRoomsCopy.confirms.matchOver);
	});

	it("the board's per game button asks before posting a card", async () => {
		const press = pressWithModal("gameroom:new:rps", "member-5");
		(gameRoomStore as unknown as { findOpenByHost: ReturnType<typeof vi.fn> }).findOpenByHost.mockResolvedValue(null);

		await _handleGameRoomButton(press);

		expect(modalIdOf(press)).toBe("gameroom:newok:rps");
	});

	it("falls back to a private reply with the confirm button, never acting at once", async () => {
		const press = makeInteraction("gameroom:archive:room-1", "host-1");

		await _handleGameRoomButton(press);

		const reply = (press.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { components: Array<{ components: Array<{ data: { custom_id: string } }> }> };
		expect(reply.components[0].components[0].data.custom_id).toBe("gameroom:archiveok:room-1");
		expect(lifecycleMock.archiveNow).not.toHaveBeenCalled();
	});
});

// ── The archive confirm asks nothing more (2026-10 item 263 decision 2) ──
// Every finished match now lists in its players' match history by playerIds, so the confirm's
// Save this match to my profile select went, and the archive writes no savedBy.
describe("the archive confirm", () => {
	type ModalJson = { components: Array<{ type: number }> };
	const modalJson = (press: { showModal: ReturnType<typeof vi.fn> }): ModalJson => (press.showModal.mock.calls[0][0] as { toJSON(): ModalJson }).toJSON();

	it("carries no select, even for a player of a finished match", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "finished" }));
		const press = pressWithModal("gameroom:archive:room-1", "host-1");

		await _handleGameRoomButton(press);

		// 18 is a modal label, the wrapper a select would sit in.
		expect(modalJson(press).components.some((component) => component.type === 18)).toBe(false);
	});

	it("archives on Submit and writes no save", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "finished" }));

		await _handleGameRoomConfirm(submit("gameroom:archiveok:room-1", "host-1"));

		expect(lifecycleMock.archiveNow).toHaveBeenCalledOnce();
		expect(storeMock.update).not.toHaveBeenCalled();
	});
});

describe("gameRoomHandlers gates", () => {
	it("lets the host archive on Submit", async () => {
		await _handleGameRoomConfirm(submit("gameroom:archiveok:room-1", "host-1"));
		expect(lifecycleMock.archiveNow).toHaveBeenCalledOnce();
	});

	it("lets an admin archive somebody else's room", async () => {
		gateMock.mockResolvedValue(true);
		await _handleGameRoomConfirm(submit("gameroom:archiveok:room-1", "moderator-9"));

		// Clearing an abandoned room is moderation, which is why hostOnly is not a bare
		// equality check against hostId.
		expect(lifecycleMock.archiveNow).toHaveBeenCalledOnce();
		expect(lifecycleMock.archiveNow.mock.calls[0][3]).toBe(true);
	});

	it("refuses a player who is neither host nor admin", async () => {
		const interaction = makeInteraction("gameroom:archive:room-1", "player-2");
		await _handleGameRoomButton(interaction);

		expect(lifecycleMock.archiveNow).not.toHaveBeenCalled();
		expect(replyText(interaction)).toContain("host or an admin");
	});

	// A modal Submit is reachable without the press that opened it, so the confirm runs
	// the press's gate again: a forged archive confirm from a player does nothing.
	it("gates the Submit again, refusing a forged archive confirm", async () => {
		const forged = submit("gameroom:archiveok:room-1", "player-2");
		await _handleGameRoomConfirm(forged);
		expect(lifecycleMock.archiveNow).not.toHaveBeenCalled();
		expect((forged.reply.mock.calls[0][0] as { content?: string }).content).toContain("host or an admin");
	});

	it("refuses a modal carrying an action that is not a confirm", async () => {
		const forged = submit("gameroom:archive:room-1", "host-1");
		await _handleGameRoomConfirm(forged);
		expect(lifecycleMock.archiveNow).not.toHaveBeenCalled();
	});

	// Post-launch plan item 18: starting a match is the host's alone. The admin override
	// every other host control keeps is exactly what must not reach Start, so the gate
	// is not even consulted, and the refusal does not promise an admin can do it.
	it.each(["start", "dero"])("refuses an admin pressing %s for the host, without consulting the admin gate", async (action) => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "draft" }));
		gateMock.mockResolvedValue(true);
		const interaction = makeInteraction(`gameroom:${action}:room-1`, "moderator-9");

		await _handleGameRoomButton(interaction);

		expect(gateMock).not.toHaveBeenCalled();
		expect(replyText(interaction)).toBe(gameRoomsCopy.board.onlyHostStarts);
	});

	it("refuses an admin's Start confirm the same way", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "draft" }));
		gateMock.mockResolvedValue(true);
		const forged = submit("gameroom:startok:room-1", "moderator-9");

		await _handleGameRoomConfirm(forged);

		expect(gateMock).not.toHaveBeenCalled();
		expect((forged.reply.mock.calls[0][0] as { content?: string }).content).toBe(gameRoomsCopy.board.onlyHostStarts);
	});

	it("still lets an admin cancel somebody else's draft", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "draft" }));
		gateMock.mockResolvedValue(true);
		const interaction = { ...makeInteraction("gameroom:cancel:room-1", "moderator-9"), deferUpdate: vi.fn().mockResolvedValue(undefined) } as unknown as ButtonInteraction;

		await _handleGameRoomButton(interaction);

		expect(gateMock).toHaveBeenCalledOnce();
		expect((gameRoomStore as unknown as { markArchived: ReturnType<typeof vi.fn> }).markArchived).toHaveBeenCalledWith("guild-1", "room-1");
	});

	// ⚠️ main.ts DOES NOT GATE BUTTONS. Its permission checks live inside
	// `if (interaction.isChatInputCommand())`, so this handler is the only gate a
	// clicker passes. A spectator forfeiting somebody else's match is the obvious
	// griefing shape, and the forfeit confirm carries the same gate.
	it.each([
		["press", (id: string) => makeInteraction(id, "spectator-3"), "gameroom:forfeit:room-1"],
		["confirm", (id: string) => submit(id, "spectator-3"), "gameroom:forfeitok:room-1"],
	])("refuses a forfeit %s from someone who is not a player", async (_label, make, customId) => {
		const interaction = make(customId);
		await (customId.includes("ok") ? _handleGameRoomConfirm(interaction as ModalSubmitInteraction) : _handleGameRoomButton(interaction as ButtonInteraction));

		expect(lifecycleMock.finish).not.toHaveBeenCalled();
		expect(trailMock.postMove).not.toHaveBeenCalled();
		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content?: string };
		expect(reply.content).toContain("host or an admin");
	});
});

describe("gameRoomHandlers forfeit", () => {
	it("records the forfeit as a MOVE before finishing the room", async () => {
		const order: string[] = [];
		trailMock.postMove.mockImplementation(async () => {
			order.push("move");
			return true;
		});
		lifecycleMock.finish.mockImplementation(async () => void order.push("finish"));

		await _handleGameRoomConfirm(submit("gameroom:forfeitok:room-1", "player-2"));

		// The transcript is the product. A forfeit that only appeared on the result
		// card would be missing from the history the dashboard reads back.
		expect(order).toEqual(["move", "finish"]);
	});

	it("hands the win to the one remaining player", async () => {
		await _handleGameRoomConfirm(submit("gameroom:forfeitok:room-1", "player-2"));
		expect(lifecycleMock.finish.mock.calls[0][2]).toEqual({ winnerId: "host-1", outcome: { bucket: "forfeit" } });
	});

	// A three seat room losing one player has no winner yet. Picking an arbitrary
	// survivor would write a false result into a permanent transcript.
	it("declares no winner when more than one player remains", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ playerIds: ["host-1", "player-2", "player-3"] }));
		await _handleGameRoomConfirm(submit("gameroom:forfeitok:room-1", "player-2"));
		expect(lifecycleMock.finish.mock.calls[0][2]).toEqual({ winnerId: null, outcome: { bucket: "forfeit" } });
	});

	it("refuses a forfeit confirm on a match that already ended", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "finished" }));
		const late = submit("gameroom:forfeitok:room-1", "player-2");

		await _handleGameRoomConfirm(late);

		expect(trailMock.postMove).not.toHaveBeenCalled();
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
		expect((late.reply.mock.calls[0][0] as { content?: string }).content).toBe(gameRoomsCopy.confirms.matchOver);
	});

	it("forfeits from the fallback reply's button exactly as from Submit", async () => {
		const button = { ...makeInteraction("gameroom:forfeitok:room-1", "player-2"), deferUpdate: vi.fn().mockResolvedValue(undefined) } as unknown as ButtonInteraction;
		await _handleGameRoomButton(button);
		expect(lifecycleMock.finish).toHaveBeenCalledOnce();
	});

	it("acknowledges the archive confirm before the room is torn down", async () => {
		// The channel the confirm was pressed in is about to stop existing. Answering
		// after the delete would throw against a channel that is no longer there.
		const interaction = submit("gameroom:archiveok:room-1", "host-1");
		const order: string[] = [];
		interaction.deferUpdate.mockImplementation(async () => void order.push("ack"));
		lifecycleMock.archiveNow.mockImplementation(async () => {
			order.push("archive");
			return { ok: true };
		});

		await _handleGameRoomConfirm(interaction);

		expect(order).toEqual(["ack", "archive"]);
	});
});

// ── Edit settings (2026-10 item 263 Phase 2a, owner decision 7) ──
describe("Edit settings on the challenge card", () => {
	it("is the host's alone, with no admin override", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "draft", hostId: "host-1" }));
		gateMock.mockResolvedValue(true);
		const press = pressWithModal("gameroom:edit:room-1", "admin-7");

		await _handleGameRoomButton(press);

		expect(press.showModal).toHaveBeenCalledOnce();
		expect(JSON.stringify((press.showModal.mock.calls[0][0] as { toJSON: () => unknown }).toJSON())).toContain(gameRoomsCopy.board.onlyHostStarts);
		expect(gateMock).not.toHaveBeenCalled();
	});

	it("plays nothing when its Submit finds the draft started or closed: a race", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "playing", hostId: "host-1" }));
		const interaction = submit("gameroom:editok:room-1");

		await _handleGameRoomConfirm(interaction);

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.board.draftGone }));
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
	});
});
