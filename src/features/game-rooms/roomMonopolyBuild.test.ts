import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, TextChannel, type ButtonInteraction, type Client, type StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn(), updateSecretIf: vi.fn(), moveBoardMessage: vi.fn(async () => ({})) } }));
// A Monopoly move's lines ride its turn's board, rather than one postMove each (2026-10 item
// 254, Arcade 8; the finished turn's board keeps them since item 263).
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn(), recordCarriedMoves: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
vi.mock("@features/games/monopolyRenderer.js", () => ({ renderBoard: vi.fn(async () => null) }));
// Where an answer posts has its own suite (utils/answerInChannel.test.ts); here only that the
// picker and a refusal go there, for a member (2026-10 item 257 Phase 5).
vi.mock("@utils/answerInChannel.js", () => ({ answerInChannel: vi.fn() }));

import { handleMbuild, handleBuildSelect } from "./roomMonopolyBuild.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { BANK_HOUSES, COLOR_GROUPS, MAX_HOUSES_PER_LOT } from "@features/games/monopolyBoard.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomMonopolyBuild ────────────────────────────────────────────────
// The Build button answers in 💬dero-commands with a picker of exactly the legal builds; a
// pick builds through the same compare and swap as every move and refreshes the
// picker with what is left.

const storeMock = gameRoomStore as unknown as { findByRoomId: ReturnType<typeof vi.fn>; updateSecretIf: ReturnType<typeof vi.fn> };
const postMoveMock = roomTrail.postMove as unknown as ReturnType<typeof vi.fn>;
const carriedMock = roomTrail.recordCarriedMoves as unknown as ReturnType<typeof vi.fn>;
const answerMock = answerInChannel as unknown as ReturnType<typeof vi.fn>;
// What an interaction answered through answerInChannel, which must be the member's channel.
function answered<T>(interaction: unknown): T {
	const call = answerMock.mock.calls.find((args) => args[0] === interaction);
	if (!call) throw new Error("the interaction was not answered through answerInChannel");
	expect(call[1]).toBe("member");
	return call[2] as T;
}
// Every line a move recorded, in order: the finished turn's board, then the new one's.
type RecordedMove = { actorId: string; kind: string; text: string };
const recorded = (): RecordedMove[] =>
	carriedMock.mock.calls.map((call) => call[1] as RecordedMove[]).flat();

const A = "player-a";
const B = "player-b";
// The board message is not reachable here, so the redraw step is a no-op.
// The room's channel, holding a board to edit or replace.
const roomChannel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
	messages: { fetch: vi.fn(async () => ({ edit: vi.fn(), delete: vi.fn() })) },
	send: vi.fn(async () => ({ id: "board-2", delete: vi.fn() })),
});
const client = { channels: { fetch: vi.fn(async () => roomChannel) }, guilds: { cache: new Map(), fetch: vi.fn(async () => null) } } as unknown as Client;

// A owns the whole brown group, so both brown lots take a house.
function brownMatch(): MonopolyState {
	const state = createInitialState([A, B], { auctionsEnabled: false }, 1_000, 1);
	for (const id of COLOR_GROUPS.brown) state.properties[id].ownerId = A;
	return state;
}

function seed(state: MonopolyState): IGameRoom {
	const room = { roomId: "room-1", guildId: "guild-1", game: "monopoly", status: "playing", playerIds: [A, B], channelId: "ch-1", secret: state } as unknown as IGameRoom;
	storeMock.findByRoomId.mockResolvedValue(room);
	return room;
}

const persisted = (): MonopolyState => storeMock.updateSecretIf.mock.calls[0][3] as MonopolyState;

type Picker = { content: string; components: { toJSON(): { components: { custom_id: string; options: { label: string; value: string }[] }[] } }[] };
const pickerOptions = (payload: Picker) => payload.components[0].toJSON().components[0].options;

function makeButton(userId: string) {
	return { user: { id: userId }, client, reply: vi.fn().mockResolvedValue(undefined) } as unknown as ButtonInteraction & { reply: ReturnType<typeof vi.fn> };
}

function makeSelect(userId: string, value: string) {
	return {
		customId: "gameroomSelect:mbuild:room-1",
		guildId: "guild-1",
		user: { id: userId },
		values: [value],
		client,
		reply: vi.fn().mockResolvedValue(undefined),
		// As discord.js does: a deferUpdate marks the press deferred, so a notice after it is a private followUp.
		deferred: false,
		deferUpdate: vi.fn(async function (this: { deferred: boolean }) {
			this.deferred = true;
		}),
		editReply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
	} as unknown as StringSelectMenuInteraction & Record<"reply" | "deferUpdate" | "editReply" | "followUp", ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.updateSecretIf.mockResolvedValue({} as never);
	postMoveMock.mockResolvedValue(true);
});

describe("handleMbuild", () => {
	it("answers in the commands channel with a picker of every legal build, priced", async () => {
		const interaction = makeButton(A);
		await handleMbuild(interaction, seed(brownMatch()));

		const payload = answered<Picker>(interaction);
		expect(interaction.reply).not.toHaveBeenCalled();
		expect(payload.components[0].toJSON().components[0].custom_id).toBe("gameroomSelect:mbuild:room-1");
		expect(pickerOptions(payload)).toEqual([
			{ label: gameRoomsCopy.monopoly.buildOptionLabel("Vermillion Alley", "house", 50), value: "vermillion-alley" },
			{ label: gameRoomsCopy.monopoly.buildOptionLabel("Burnt Umber Row", "house", 50), value: "burnt-umber-row" },
		]);
	});

	it("says why there is nothing to build, rather than showing an empty picker", async () => {
		const interaction = makeButton(B);
		await handleMbuild(interaction, seed(brownMatch()));
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.monopoly.nothingToBuild }));
	});
});

describe("handleBuildSelect", () => {
	it("builds the picked house, posts the trail, and refreshes the picker with what is left", async () => {
		seed(brownMatch());
		const interaction = makeSelect(A, "vermillion-alley");

		await handleBuildSelect(interaction);

		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		expect(persisted().properties["vermillion-alley"].houses).toBe(1);
		expect(recorded()[0].text).toBe(`<@${A}> built a house on Vermillion Alley for $50.`);
		const refreshed = interaction.editReply.mock.calls[0][0] as Picker;
		expect(refreshed.content).toBe(gameRoomsCopy.monopoly.buildPickerAgain);
		// Even building: Vermillion Alley is a house ahead, so only Burnt Umber Row is left.
		expect(pickerOptions(refreshed).map((option) => option.value)).toEqual(["burnt-umber-row"]);
	});

	it("builds the hotel on a lot with four houses, without the player having to say so", async () => {
		const state = brownMatch();
		for (const id of COLOR_GROUPS.brown) state.properties[id].houses = MAX_HOUSES_PER_LOT;
		state.bank.houses = BANK_HOUSES - MAX_HOUSES_PER_LOT * COLOR_GROUPS.brown.length;
		seed(state);

		await handleBuildSelect(makeSelect(A, "burnt-umber-row"));

		expect(persisted().properties["burnt-umber-row"]).toMatchObject({ hotel: true, houses: 0 });
	});

	it("drops the picker once nothing else can be built", async () => {
		const state = brownMatch();
		state.properties["vermillion-alley"].houses = 1;
		state.bank.houses = BANK_HOUSES - 1;
		state.seats[0].chips = 50;
		seed(state);
		const interaction = makeSelect(A, "burnt-umber-row");

		await handleBuildSelect(interaction);

		expect(interaction.editReply).toHaveBeenCalledWith({ content: gameRoomsCopy.monopoly.buildPickerDone, components: [] });
	});

	// A refusal is a state, so a private notice and never a ping in the commands channel (owner
	// rule 1 of the Round 3 list, 2026-10 item 263).
	it("refuses a seat that is not on the clock, privately, and writes nothing", async () => {
		seed(brownMatch());
		const interaction = makeSelect(B, "vermillion-alley");

		await handleBuildSelect(interaction);

		expect(answerMock.mock.calls.some((args) => args[0] === interaction)).toBe(false);
		expect(interaction.followUp).toHaveBeenCalledWith({ content: gameRoomsCopy.monopoly.notYourTurn, flags: MessageFlags.Ephemeral });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("passes a lot id the board does not have to the engine, which refuses it by name", async () => {
		seed(brownMatch());
		const interaction = makeSelect(A, "nowhere");
		await handleBuildSelect(interaction);
		expect(interaction.followUp).toHaveBeenCalledWith({ content: "Only color lots take buildings.", flags: MessageFlags.Ephemeral });
	});

	it("refuses a select from somebody who is not at the table before touching the match", async () => {
		seed(brownMatch());
		const interaction = makeSelect("stranger", "vermillion-alley");
		await handleBuildSelect(interaction);
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.notYours }));
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
	});
});
