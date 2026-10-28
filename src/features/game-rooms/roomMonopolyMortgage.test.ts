import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, TextChannel, type Client, type StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn(), updateSecretIf: vi.fn(), moveBoardMessage: vi.fn(async () => ({})) } }));
// A Monopoly move's lines ride its turn's board, rather than one postMove each (2026-10 item
// 254, Arcade 8; the finished turn's board keeps them since item 263).
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn(), recordCarriedMoves: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
vi.mock("@features/games/monopolyRenderer.js", () => ({ renderBoard: vi.fn(async () => null) }));
// Where an answer posts has its own suite (utils/answerInChannel.test.ts); here only that a
// refusal goes there, for a member (2026-10 item 257 Phase 5).
vi.mock("@utils/answerInChannel.js", () => ({ answerInChannel: vi.fn() }));

import { handleMortgageSelect, handleSellSelect, handleUnmortgageSelect } from "./roomMonopolyMortgage.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomMonopolyMortgage ─────────────────────────────────────────────
// The Inventory peek's two selects: any seat still playing may mortgage or lift a
// mortgage at any time, the move commits like any other, and the peek redraws in
// place with the new balance and options.

const storeMock = gameRoomStore as unknown as { findByRoomId: ReturnType<typeof vi.fn>; updateSecretIf: ReturnType<typeof vi.fn> };
const postMoveMock = roomTrail.postMove as unknown as ReturnType<typeof vi.fn>;
const carriedMock = roomTrail.recordCarriedMoves as unknown as ReturnType<typeof vi.fn>;
// Every line a move recorded, in order: the finished turn's board, then the new one's.
type RecordedMove = { actorId: string; kind: string; text: string };
const recorded = (): RecordedMove[] =>
	carriedMock.mock.calls.map((call) => call[1] as RecordedMove[]).flat();

const A = "player-a";
const B = "player-b";
// The board message is not reachable here, so the redraw is a no-op.
// The room's channel, holding a board to edit or replace.
const roomChannel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
	messages: { fetch: vi.fn(async () => ({ edit: vi.fn(), delete: vi.fn() })) },
	send: vi.fn(async () => ({ id: "board-2", delete: vi.fn() })),
});
const client = { channels: { fetch: vi.fn(async () => roomChannel) }, guilds: { cache: new Map(), fetch: vi.fn(async () => null) } } as unknown as Client;

// B, who is NOT on the clock, owns Vermillion Alley and a mortgaged Reader Dock.
function holdings(): MonopolyState {
	const state = createInitialState([A, B], { auctionsEnabled: false }, 1_000, 1);
	state.properties["vermillion-alley"].ownerId = B;
	state.properties["reader-dock"].ownerId = B;
	state.properties["reader-dock"].mortgaged = true;
	return state;
}

function seed(state: MonopolyState): void {
	storeMock.findByRoomId.mockResolvedValue({
		roomId: "room-1",
		guildId: "guild-1",
		game: "monopoly",
		status: "playing",
		playerIds: [A, B],
		channelId: "ch-1",
		secret: state,
	} as unknown as IGameRoom);
}

const persisted = (): MonopolyState => storeMock.updateSecretIf.mock.calls[0][3] as MonopolyState;

function makeSelect(action: "mmortgage" | "munmortgage" | "msell", userId: string, value: string) {
	return {
		customId: `gameroomSelect:${action}:room-1`,
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

type PeekPayload = { embeds: { data: { description: string } }[]; components: { toJSON(): { components: { custom_id: string; options: { value: string }[] }[] } }[] };
const selectOptions = (payload: PeekPayload, action: string): string[] =>
	payload.components
		.map((row) => row.toJSON().components[0])
		.find((select) => select.custom_id === `gameroomSelect:${action}:room-1`)
		?.options.map((option) => option.value) ?? [];

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.updateSecretIf.mockResolvedValue({} as never);
	postMoveMock.mockResolvedValue(true);
});

describe("mortgaging from the Inventory peek", () => {
	it("mortgages a lot off turn, credits the chips, posts the trail and redraws the peek", async () => {
		seed(holdings());
		const interaction = makeSelect("mmortgage", B, "vermillion-alley");

		await handleMortgageSelect(interaction);

		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		expect(persisted().properties["vermillion-alley"].mortgaged).toBe(true);
		expect(persisted().seats[1].chips).toBe(1530);
		expect(recorded()[0].text).toBe(`<@${B}> mortgaged Vermillion Alley for $30.`);
		const peek = interaction.editReply.mock.calls[0][0] as PeekPayload;
		expect(peek.embeds[0].data.description).toContain(gameRoomsCopy.monopoly.inventoryChips(1530));
		expect(peek.embeds[0].data.description).toContain("• Vermillion Alley (mortgaged, $33 to lift)");
		// Nothing is left to mortgage; both mortgages can be lifted with $1530.
		expect(selectOptions(peek, "mmortgage")).toEqual([]);
		expect(selectOptions(peek, "munmortgage")).toEqual(["vermillion-alley", "reader-dock"]);
	});

	it("lifts a mortgage and charges its cost", async () => {
		seed(holdings());
		await handleUnmortgageSelect(makeSelect("munmortgage", B, "reader-dock"));
		expect(persisted().properties["reader-dock"].mortgaged).toBe(false);
		expect(persisted().seats[1].chips).toBe(1500 - 55);
	});

	// A refusal is a state, so a private notice and never a ping in the commands channel (owner
	// rule 1 of the Round 3 list, 2026-10 item 263).
	it("passes the engine's refusal back privately, for a lot the seat does not own, and writes nothing", async () => {
		seed(holdings());
		const interaction = makeSelect("mmortgage", A, "vermillion-alley");

		await handleMortgageSelect(interaction);

		expect((answerInChannel as unknown as ReturnType<typeof vi.fn>).mock.calls.some((args) => args[0] === interaction)).toBe(false);
		expect(interaction.followUp).toHaveBeenCalledWith({ content: "You do not own Vermillion Alley.", flags: MessageFlags.Ephemeral });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("refuses a select from somebody not at the table before touching the match", async () => {
		seed(holdings());
		const interaction = makeSelect("mmortgage", "stranger", "vermillion-alley");
		await handleMortgageSelect(interaction);
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.notYours }));
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
	});
	it("sells a house back to the bank and redraws the peek with the new options", async () => {
		const state = holdings();
		state.properties["burnt-umber-row"].ownerId = B;
		state.properties["vermillion-alley"].houses = 1;
		state.bank.houses -= 1;
		seed(state);
		const interaction = makeSelect("msell", B, "vermillion-alley");

		await handleSellSelect(interaction);

		expect(persisted().properties["vermillion-alley"].houses).toBe(0);
		expect(persisted().seats[1].chips).toBe(1525);
		const peek = interaction.editReply.mock.calls[0][0] as PeekPayload;
		expect(selectOptions(peek, "msell")).toEqual([]);
		expect(selectOptions(peek, "mmortgage")).toEqual(["vermillion-alley", "burnt-umber-row"]);
	});
});
