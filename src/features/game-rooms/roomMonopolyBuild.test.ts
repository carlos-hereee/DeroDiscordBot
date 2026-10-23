import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client, StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn(), updateSecretIf: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
vi.mock("@features/games/monopolyRenderer.js", () => ({ renderBoard: vi.fn(async () => null) }));

import { handleMbuild, handleBuildSelect } from "./roomMonopolyBuild.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { BANK_HOUSES, COLOR_GROUPS, MAX_HOUSES_PER_LOT } from "@features/games/monopolyBoard.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomMonopolyBuild ────────────────────────────────────────────────
// The Build button answers with a private picker of exactly the legal builds; a
// pick builds through the same compare and swap as every move and refreshes the
// picker with what is left.

const storeMock = gameRoomStore as unknown as { findByRoomId: ReturnType<typeof vi.fn>; updateSecretIf: ReturnType<typeof vi.fn> };
const postMoveMock = roomTrail.postMove as unknown as ReturnType<typeof vi.fn>;

const A = "player-a";
const B = "player-b";
// The board message is not reachable here, so the redraw step is a no-op.
const client = { channels: { fetch: vi.fn(async () => null) }, guilds: { fetch: vi.fn(async () => null) } } as unknown as Client;

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
		deferUpdate: vi.fn().mockResolvedValue(undefined),
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
	it("answers privately with a picker of every legal build, priced", async () => {
		const interaction = makeButton(A);
		await handleMbuild(interaction, seed(brownMatch()));

		const payload = interaction.reply.mock.calls[0][0] as Picker & { flags: number };
		expect(payload.flags).toBe(64);
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
		expect((postMoveMock.mock.calls[0][2] as { text: string }).text).toBe(`<@${A}> built a house on Vermillion Alley for $50.`);
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

	it("refuses a seat that is not on the clock, privately, and writes nothing", async () => {
		seed(brownMatch());
		const interaction = makeSelect(B, "vermillion-alley");

		await handleBuildSelect(interaction);

		const followUp = interaction.followUp.mock.calls[0][0] as { embeds: { data: { description: string } }[]; flags: number };
		expect(followUp.embeds[0].data.description).toBe(gameRoomsCopy.monopoly.notYourTurn);
		expect(followUp.flags).toBe(64);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("passes a lot id the board does not have to the engine, which refuses it by name", async () => {
		seed(brownMatch());
		const interaction = makeSelect(A, "nowhere");
		await handleBuildSelect(interaction);
		const followUp = interaction.followUp.mock.calls[0][0] as { embeds: { data: { description: string } }[] };
		expect(followUp.embeds[0].data.description).toBe("Only color lots take buildings.");
	});

	it("refuses a select from somebody who is not at the table before touching the match", async () => {
		seed(brownMatch());
		const interaction = makeSelect("stranger", "vermillion-alley");
		await handleBuildSelect(interaction);
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.notYours }));
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
	});
});
