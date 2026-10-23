import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, TextChannel, type ButtonInteraction, type Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(),
		// The compare and swap every Monopoly write goes through. A truthy return means
		// the caller's read was still current; null means somebody else moved first.
		updateSecretIf: vi.fn(),
	},
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
// The dice. Mocked so a test names the exact roll it needs.
vi.mock("@utils/secureRng.js", () => ({ secureRandom: vi.fn() }));
// The board picture. Mocked so every redraw here is the text board unless a case
// hands it a picture, whatever art is on disk where the suite runs.
vi.mock("@features/games/monopolyRenderer.js", () => ({ renderBoard: vi.fn() }));

import { renderBoard } from "@features/games/monopolyRenderer.js";
import { handleMroll, handleMbuy, handleMskip, handleMend, handleMjail, handleMinventory, turnFingerprint } from "./roomMonopolyHandlers.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { awardMultiPlayerResult } from "@features/games/gameXp.js";
import { secureRandom } from "@utils/secureRng.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomMonopolyHandlers ─────────────────────────────────────────────
// Each button: acknowledged first (risk M1), re-read, applied through the pure
// engine, persisted by compare and swap, then the board redrawn and the trail
// posted, in that order. And each refusal: ephemeral, with nothing written.

const storeMock = gameRoomStore as unknown as {
	findByRoomId: ReturnType<typeof vi.fn>;
	updateSecretIf: ReturnType<typeof vi.fn>;
};
const postMoveMock = roomTrail.postMove as unknown as ReturnType<typeof vi.fn>;
const finishMock = roomLifecycle.finish as unknown as ReturnType<typeof vi.fn>;
const awardMock = awardMultiPlayerResult as unknown as ReturnType<typeof vi.fn>;
const diceMock = secureRandom as unknown as ReturnType<typeof vi.fn>;
const renderMock = renderBoard as unknown as ReturnType<typeof vi.fn>;

const A = "player-a";
const B = "player-b";
// rollDie is floor(rng * 6) + 1, so these land a 1 and a 2: three steps, onto
// Cinder Row, an unowned lot, with no doubles.
const ROLL_ONE = 0;
const ROLL_TWO = 0.2;

const freshMatch = (): MonopolyState => ({
	...createInitialState([A, B], { auctionsEnabled: false }, 1_000, 1),
	boardMessageId: "board-1",
});

function makeRoom(state: MonopolyState): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "monopoly",
		status: "playing",
		playerIds: [A, B],
		channelId: "ch-1",
		secret: state,
	} as unknown as IGameRoom;
}

function makeBoardMessage() {
	return { edit: vi.fn().mockResolvedValue(undefined) };
}

function makeClient(boardMessage = makeBoardMessage()) {
	const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
		messages: { fetch: vi.fn().mockResolvedValue(boardMessage) },
	});
	return {
		channels: { fetch: vi.fn().mockResolvedValue(channel) },
		guilds: { fetch: vi.fn().mockResolvedValue(null) },
	} as unknown as Client;
}

function makeInteraction(userId: string, client: Client = makeClient()) {
	return {
		user: { id: userId },
		client,
		reply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction & {
		reply: ReturnType<typeof vi.fn>;
		followUp: ReturnType<typeof vi.fn>;
		deferUpdate: ReturnType<typeof vi.fn>;
	};
}

// The state the handler persisted, off the compare and swap call.
const persisted = (): MonopolyState => storeMock.updateSecretIf.mock.calls[0][3] as MonopolyState;
const trailTexts = (): string[] => postMoveMock.mock.calls.map((call) => (call[2] as { text: string }).text);
const followUpText = (interaction: ReturnType<typeof makeInteraction>): string =>
	(interaction.followUp.mock.calls[0][0] as { embeds: { data: { description?: string } }[] }).embeds[0].data.description ?? "";

function seed(state: MonopolyState): IGameRoom {
	const room = makeRoom(state);
	storeMock.findByRoomId.mockResolvedValue(room);
	return room;
}

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.updateSecretIf.mockResolvedValue({} as never);
	postMoveMock.mockResolvedValue(true);
	finishMock.mockResolvedValue(true);
	diceMock.mockReturnValueOnce(ROLL_ONE).mockReturnValueOnce(ROLL_TWO);
	renderMock.mockResolvedValue(null);
});

describe("handleMroll", () => {
	it("rehydrates, rolls, persists, redraws and posts the trail, in that order", async () => {
		const room = seed(freshMatch());
		const boardMessage = makeBoardMessage();
		const interaction = makeInteraction(A, makeClient(boardMessage));

		await handleMroll(interaction, room);

		const state = persisted();
		expect(state.diceRoll).toEqual([1, 2]);
		expect(state.seats[0].position).toBe(3);
		expect(state.phase).toBe("awaiting-buy-or-skip");
		expect(trailTexts()[0]).toBe(`<@${A}> rolled 1 and 2.`);

		// ⚠️ RISK M1: acknowledged BEFORE either Mongo round trip, then write, then
		// edit, then trail.
		const deferAt = interaction.deferUpdate.mock.invocationCallOrder[0];
		const readAt = storeMock.findByRoomId.mock.invocationCallOrder[0];
		const writeAt = storeMock.updateSecretIf.mock.invocationCallOrder[0];
		const editAt = boardMessage.edit.mock.invocationCallOrder[0];
		const trailAt = postMoveMock.mock.invocationCallOrder[0];
		expect(deferAt).toBeLessThan(readAt);
		expect(readAt).toBeLessThan(writeAt);
		expect(writeAt).toBeLessThan(editAt);
		expect(editAt).toBeLessThan(trailAt);
	});

	it("persists only against the turn it read, so a double click cannot roll twice", async () => {
		const read = freshMatch();
		const room = seed(read);

		await handleMroll(makeInteraction(A), room);

		const [guildId, roomId, expected] = storeMock.updateSecretIf.mock.calls[0];
		expect([guildId, roomId]).toEqual(["guild-1", "room-1"]);
		expect(expected).toEqual(turnFingerprint(read));
	});

	it("redraws the board with the next control for the seat on the clock", async () => {
		const room = seed(freshMatch());
		const boardMessage = makeBoardMessage();

		await handleMroll(makeInteraction(A, makeClient(boardMessage)), room);

		const payload = boardMessage.edit.mock.calls[0][0] as { components: { toJSON(): { components: { custom_id?: string }[] } }[] };
		const ids = payload.components.flatMap((row) => row.toJSON().components.map((button) => button.custom_id));
		expect(ids).toEqual(["gameroom:mbuy:room-1:cinder-row", "gameroom:mskip:room-1", "gameroom:minventory:room-1"]);
	});

	it("swaps the board picture on a redraw rather than stacking one per move", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "monopoly-board-7.png" });
		renderMock.mockResolvedValue({ attachment, ref: "attachment://monopoly-board-7.png" });
		const room = seed(freshMatch());
		const boardMessage = makeBoardMessage();

		await handleMroll(makeInteraction(A, makeClient(boardMessage)), room);

		const payload = boardMessage.edit.mock.calls[0][0] as {
			attachments: unknown[];
			files: AttachmentBuilder[];
			embeds: { data: { image?: { url: string } } }[];
		};
		// The board drawn is the state just persisted, not the one read before the move.
		expect(renderMock).toHaveBeenCalledWith(persisted());
		expect(payload.files).toEqual([attachment]);
		expect(payload.embeds[0].data.image?.url).toBe("attachment://monopoly-board-7.png");
		// `attachments: []` drops the previous move's picture from the message.
		expect(payload.attachments).toEqual([]);
	});

	it("clears the last picture when a redraw falls back to the text board", async () => {
		const room = seed(freshMatch());
		const boardMessage = makeBoardMessage();

		await handleMroll(makeInteraction(A, makeClient(boardMessage)), room);

		const payload = boardMessage.edit.mock.calls[0][0] as { attachments: unknown[]; files: unknown[]; embeds: { data: { image?: unknown } }[] };
		expect(payload.files).toEqual([]);
		expect(payload.attachments).toEqual([]);
		expect(payload.embeds[0].data.image).toBeUndefined();
	});

	it("refuses a seat that is not on the clock, ephemerally, and writes nothing", async () => {
		const room = seed(freshMatch());
		const interaction = makeInteraction(B);

		await handleMroll(interaction, room);

		expect(followUpText(interaction)).toBe(gameRoomsCopy.monopoly.notYourTurn);
		expect((interaction.followUp.mock.calls[0][0] as { flags?: number }).flags).toBe(64);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
		expect(postMoveMock).not.toHaveBeenCalled();
	});

	it("says the board changed and posts nothing when another write landed first", async () => {
		const room = seed(freshMatch());
		storeMock.updateSecretIf.mockResolvedValue(null);
		const interaction = makeInteraction(A);

		await handleMroll(interaction, room);

		expect(followUpText(interaction)).toBe(gameRoomsCopy.monopoly.boardBusy);
		expect(postMoveMock).not.toHaveBeenCalled();
	});

	it("refuses a room whose board was never seeded, and a finished match", async () => {
		const unseeded = { ...makeRoom(freshMatch()), secret: null } as unknown as IGameRoom;
		storeMock.findByRoomId.mockResolvedValue(unseeded);
		const first = makeInteraction(A);
		await handleMroll(first, unseeded);
		expect(followUpText(first)).toBe(gameRoomsCopy.monopoly.noBoard);

		const over = { ...freshMatch(), phase: "finished" as const, winnerId: A };
		const room = seed(over);
		const second = makeInteraction(A);
		await handleMroll(second, room);
		expect(followUpText(second)).toBe(gameRoomsCopy.monopoly.matchOver);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
});

describe("handleMbuy, handleMskip and handleMend", () => {
	const onCinderRow = (): MonopolyState => {
		const state = freshMatch();
		state.phase = "awaiting-buy-or-skip";
		state.rolledThisTurn = true;
		state.seats[0].position = 3;
		return state;
	};

	it("buys the lot on the button", async () => {
		const room = seed(onCinderRow());

		await handleMbuy(makeInteraction(A), room, "cinder-row");

		expect(persisted().properties["cinder-row"].ownerId).toBe(A);
		expect(persisted().seats[0].chips).toBe(1440);
		expect(trailTexts()).toEqual([`<@${A}> bought Cinder Row for $60.`]);
	});

	it("passes the engine's own refusal through for a stale Buy button", async () => {
		const room = seed(onCinderRow());
		const interaction = makeInteraction(A);

		await handleMbuy(interaction, room, "mudlark-lane");

		expect(followUpText(interaction)).toBe("You can only buy the tile you are standing on.");
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("skips the lot, which stays with the bank because auctions are off", async () => {
		const room = seed(onCinderRow());

		await handleMskip(makeInteraction(A), room);

		expect(persisted().phase).toBe("post-roll");
		expect(persisted().properties["cinder-row"].ownerId).toBeNull();
		expect(persisted().pendingAuction).toBeNull();
	});

	it("ends the turn and hands the clock on", async () => {
		const state = onCinderRow();
		state.phase = "post-roll";
		const room = seed(state);

		await handleMend(makeInteraction(A), room);

		expect(persisted().activeSeatIndex).toBe(1);
		expect(trailTexts()).toEqual([`It is now <@${B}>'s turn.`]);
	});

	it("refuses End turn before the roll, with the engine's reason", async () => {
		const room = seed(freshMatch());
		const interaction = makeInteraction(A);

		await handleMend(interaction, room);

		expect(followUpText(interaction)).toBe("Finish your roll before ending the turn.");
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
});

describe("handleMjail", () => {
	const jailed = (): MonopolyState => {
		const state = freshMatch();
		state.seats[0].inJail = true;
		state.seats[0].jailTurnsRemaining = 3;
		state.seats[0].position = 10;
		return state;
	};

	it("pays bail and frees the seat to roll", async () => {
		const room = seed(jailed());

		await handleMjail(makeInteraction(A), room, "bail");

		expect(persisted().seats[0]).toMatchObject({ inJail: false, chips: 1450 });
		expect(persisted().phase).toBe("pre-roll");
	});

	it("refuses an unknown choice before acknowledging, since nothing has been spent", async () => {
		const room = seed(jailed());
		const interaction = makeInteraction(A);

		await handleMjail(interaction, room, "bribe");

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.controlRetired, flags: 64 }));
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("finishes the match and records one result per seat when the last try bankrupts the roller", async () => {
		// The last try misses (1 and 2), bail is forced, and a seat with no chips and
		// no lots cannot raise it, so it is bankrupt to the bank and B is left standing.
		const state = jailed();
		state.seats[0].jailTurnsRemaining = 1;
		state.seats[0].chips = 0;
		const room = seed(state);

		await handleMjail(makeInteraction(A), room, "roll");

		expect(persisted().phase).toBe("finished");
		expect(persisted().winnerId).toBe(B);
		expect(finishMock).toHaveBeenCalledWith(expect.anything(), room, { winnerId: B });
		expect(awardMock).toHaveBeenCalledWith(
			expect.objectContaining({
				game: "monopoly",
				winnerId: B,
				nonWinnerOutcome: "lost",
				// No guild resolved in the test, so no names: undefined, never the snowflake.
				participants: [
					{ userId: A, username: undefined },
					{ userId: B, username: undefined },
				],
			})
		);
	});

	it("pays nothing when another path already finished the room", async () => {
		const state = jailed();
		state.seats[0].jailTurnsRemaining = 1;
		state.seats[0].chips = 0;
		const room = seed(state);
		finishMock.mockResolvedValue(false);

		await handleMjail(makeInteraction(A), room, "roll");

		expect(finishMock).toHaveBeenCalledOnce();
		expect(awardMock).not.toHaveBeenCalled();
	});
});

describe("handleMinventory", () => {
	it("replies ephemerally with the clicker's own holdings and writes nothing", async () => {
		const state = freshMatch();
		state.seats[1].chips = 777;
		const interaction = makeInteraction(B);

		await handleMinventory(interaction, makeRoom(state));

		const payload = interaction.reply.mock.calls[0][0] as { flags?: number; embeds: { data: { description?: string } }[] };
		expect(payload.flags).toBe(64);
		expect(payload.embeds[0].data.description).toContain(gameRoomsCopy.monopoly.inventoryChips(777));
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
});
