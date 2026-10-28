import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbedBuilder, type TextChannel } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { moveBoardMessage: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { recordCarriedMoves: vi.fn() } }));

import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail, type RoomMoveInput } from "./roomTrail.js";
import { postTurnBoard } from "./turnBoard.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── turnBoard ────────────────────────────────────────────────────────
// The one shared turn board (2026-10 item 263 R3-29 and R3-4): a new turn's board is sent and
// claimed, the board before it is KEPT with its controls off (and its block finished when the
// turn ended with lines of its own), and every move reaches the transcript once, after the
// message showing it. Each game's own suite drives it through five turns; these cases pin the
// helper's edges.

const claimMock = gameRoomStore.moveBoardMessage as unknown as ReturnType<typeof vi.fn>;
const recordMock = roomTrail.recordCarriedMoves as unknown as ReturnType<typeof vi.fn>;
const ROOM = { guildId: "guild-1", roomId: "room-1" };
const HEADER = `**${gameRoomsCopy.turnBoard.thisTurnLabel}**`;

const move = (text: string): RoomMoveInput => ({ actorId: "a", kind: "guess", text });

interface FakeMessage {
	id: string;
	embeds: unknown[];
	attachments: Map<string, { name: string }>;
	edit: ReturnType<typeof vi.fn>;
}

function fakeChannel(old: FakeMessage | null) {
	const sent: { content?: string }[] = [];
	const posted: FakeMessage = { id: "new-board", embeds: [], attachments: new Map(), edit: vi.fn(async () => undefined) };
	const send = vi.fn(async (payload: { content?: string }) => {
		sent.push(payload);
		return payload.content ? { id: "lines" } : posted;
	});
	const channel = { send, messages: { fetch: vi.fn(async (id: string) => (old && old.id === id ? old : Promise.reject(new Error("Unknown Message")))) } } as unknown as TextChannel;
	return { channel, send, sent, posted };
}

function oldBoard(description: string, image?: { url: string; name: string }): FakeMessage {
	const embed = new EmbedBuilder().setTitle("Board").setDescription(description);
	if (image) embed.setImage(image.url);
	return { id: "old-board", embeds: [embed.toJSON()], attachments: new Map(image ? [["1", { name: image.name }]] : []), edit: vi.fn(async () => undefined) };
}

const recorded = (): string[] => recordMock.mock.calls.flatMap((call) => (call[1] as RoomMoveInput[]).map((entry) => entry.text));

beforeEach(() => {
	vi.clearAllMocks();
	claimMock.mockResolvedValue({});
});

describe("postTurnBoard", () => {
	it("sends the new board pinging nobody, claims it from the old id, keeps the old board with its controls off, and records what the new one carries", async () => {
		const old = oldBoard("status");
		const { channel, send } = fakeChannel(old);

		expect(await postTurnBoard(channel, ROOM, "old-board", { embeds: [] }, { carried: [move("opens")], alsoSet: { "secret.revealKey": "k" } })).toBe("new-board");

		expect(send.mock.calls[0][0]).toMatchObject({ allowedMentions: { parse: [] } });
		expect(claimMock).toHaveBeenCalledWith("guild-1", "room-1", "old-board", "new-board", { "secret.revealKey": "k" }, "boardMessageId");
		expect(old.edit).toHaveBeenCalledWith({ content: null, components: [] });
		expect(recorded()).toEqual(["opens"]);
	});

	it("finishes the kept board's block with the lines that ended the turn, then records them before the new board's", async () => {
		const old = oldBoard(`status\n\n${HEADER}\nrolled`);
		const { channel } = fakeChannel(old);

		await postTurnBoard(channel, ROOM, "old-board", { embeds: [] }, { carried: [move("opens")], closing: { block: [HEADER, "rolled", "ended"], moves: [move("ended")] } });

		const edit = old.edit.mock.calls[0][0] as { embeds: EmbedBuilder[]; components: unknown[]; content: null };
		expect(edit.components).toEqual([]);
		expect(edit.content).toBeNull();
		expect(edit.embeds[0].data.description).toBe(`status\n\n${HEADER}\nrolled\nended`);
		expect(recorded()).toEqual(["ended", "opens"]);
	});

	it("points a kept board's picture back at its own attachment, so the edit does not unbind it", async () => {
		const old = oldBoard(`${HEADER}\na`, { url: "https://cdn.discordapp.com/attachments/1/2/board-7.png?ex=1", name: "board-7.png" });
		const { channel } = fakeChannel(old);

		await postTurnBoard(channel, ROOM, "old-board", { embeds: [] }, { closing: { block: [HEADER, "a", "b"], moves: [move("b")] } });

		const edit = old.edit.mock.calls[0][0] as { embeds: EmbedBuilder[] };
		expect(edit.embeds[0].data.image?.url).toBe("attachment://board-7.png");
	});

	it("posts a finished turn's last lines on their own when its board is gone, so each still lands once", async () => {
		const { channel, sent } = fakeChannel(null);

		await postTurnBoard(channel, ROOM, "deleted-board", { embeds: [] }, { carried: [move("opens")], closing: { block: [HEADER, "rolled", "ended"], moves: [move("ended")] } });

		expect(sent.at(-1)).toMatchObject({ content: "ended", allowedMentions: { parse: [] } });
		expect(recorded()).toEqual(["ended", "opens"]);
	});

	it("keeps a newcomer whose claim lost, with its controls off, and still records what it shows", async () => {
		claimMock.mockResolvedValue(null);
		const old = oldBoard("status");
		const { channel, posted } = fakeChannel(old);

		expect(await postTurnBoard(channel, ROOM, "old-board", { embeds: [] }, { carried: [move("shown")] })).toBeNull();

		expect(posted.edit).toHaveBeenCalledWith({ content: null, components: [] });
		expect(old.edit).not.toHaveBeenCalled();
		expect(recorded()).toEqual(["shown"]);
	});

	it("claims Hangman's card through its own field, and claims nothing for a table held in this process", async () => {
		const { channel } = fakeChannel(null);
		await postTurnBoard(channel, ROOM, null, { embeds: [] }, { boardField: "gallowsMessageId" });
		expect(claimMock).toHaveBeenCalledWith("guild-1", "room-1", null, "new-board", {}, "gallowsMessageId");

		claimMock.mockClear();
		await postTurnBoard(channel, ROOM, null, { embeds: [] }, { boardField: null });
		expect(claimMock).not.toHaveBeenCalled();
	});
});
