import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn(), updateSecretIf: vi.fn(), moveMonopolyBoard: vi.fn(async () => ({})) } }));
// A Monopoly move's lines ride the board, or the finished turn's log message, rather than
// one postMove each (2026-10 item 254, Arcade 8).
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn(), postMoveLog: vi.fn(async () => true), recordCarriedMoves: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
// The cards answer null unless a case hands one back, so every other case reads the
// text offer exactly as it posts when the trade card does not draw.
vi.mock("@features/games/monopolyRenderer.js", () => ({
	renderBoard: vi.fn(async () => null),
	renderTradeCard: vi.fn(async () => null),
	monopolyTradeView: vi.fn(() => ({})),
}));

import { handleMtrade, handleTradePartnerSelect, handleTradeModal, handleMtradeAccept, handleMtradeReject } from "./roomMonopolyTrade.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { createInitialState, type MonopolyState, type TradeProposal } from "@features/games/monopolyState.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { renderTradeCard } from "@features/games/monopolyRenderer.js";
import { AttachmentBuilder, TextChannel } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomMonopolyTrade ────────────────────────────────────────────────
// Partner picker, offer modal, private review and answers. The rule that matters
// most is risk M6: until a trade is accepted its terms reach ONLY the two players
// in it, and never the channel.

const storeMock = gameRoomStore as unknown as { findByRoomId: ReturnType<typeof vi.fn>; updateSecretIf: ReturnType<typeof vi.fn> };
const postMoveMock = roomTrail.postMove as unknown as ReturnType<typeof vi.fn>;
const carriedMock = roomTrail.recordCarriedMoves as unknown as ReturnType<typeof vi.fn>;
const moveLogMock = roomTrail.postMoveLog as unknown as ReturnType<typeof vi.fn>;
// Every line a move recorded, in order: the finished turn's log, then the board's.
type RecordedMove = { actorId: string; kind: string; text: string };
const recorded = (): RecordedMove[] =>
	[...moveLogMock.mock.calls.map((call) => (call[2] as { moves: RecordedMove[] }).moves), ...carriedMock.mock.calls.map((call) => call[1] as RecordedMove[])].flat();

const A = "player-a";
const B = "player-b";
const C = "player-c";
const OPENED_AT = 5_000;
// The board message and the members are not reachable here, so the redraw is a no-op
// and the partner picker falls back to seat numbers.
// The room's channel, holding a board to edit or replace.
const roomChannel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
	messages: { fetch: vi.fn(async () => ({ edit: vi.fn(), delete: vi.fn() })) },
	send: vi.fn(async () => ({ id: "board-2", delete: vi.fn() })),
});
const client = { channels: { fetch: vi.fn(async () => roomChannel) }, guilds: { cache: new Map(), fetch: vi.fn(async () => null) } } as unknown as Client;

// A holds Reader Dock and a jail card; B holds both brown lots.
function tradeMatch(): MonopolyState {
	const state = createInitialState([A, B, C], { auctionsEnabled: false }, 1_000, 1);
	state.properties["reader-dock"].ownerId = A;
	state.properties["vermillion-alley"].ownerId = B;
	state.properties["burnt-umber-row"].ownerId = B;
	state.seats[0].gojfCards = 1;
	return state;
}

// A offers Reader Dock and $100 for B's Vermillion Alley.
const openOffer = (): TradeProposal => ({
	initiatorId: A,
	counterpartyId: B,
	offer: { properties: ["reader-dock"], chips: 100, gojf: 0 },
	request: { properties: ["vermillion-alley"], chips: 0, gojf: 0 },
	openedAt: OPENED_AT,
});

function seed(state: MonopolyState): IGameRoom {
	const room = { roomId: "room-1", guildId: "guild-1", game: "monopoly", status: "playing", playerIds: [A, B, C], channelId: "ch-1", secret: state } as unknown as IGameRoom;
	storeMock.findByRoomId.mockResolvedValue(room);
	return room;
}

const persisted = (): MonopolyState => storeMock.updateSecretIf.mock.calls[0][3] as MonopolyState;
const trailTexts = (): string[] => recorded().map((move) => move.text);

type Spy = ReturnType<typeof vi.fn>;
function makeButton(userId: string) {
	return {
		user: { id: userId },
		client,
		reply: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction & Record<"reply" | "deferReply" | "deferUpdate" | "editReply" | "followUp", Spy>;
}

// A modal submit whose fields answer like discord.js: a field the modal did not
// include is simply absent from `fields.fields`.
function makeModal(userId: string, values: { texts?: Record<string, string>; selects?: Record<string, string[]> }) {
	const texts = values.texts ?? {};
	const selects = values.selects ?? {};
	return {
		customId: `gameroomModal:mtrade:room-1:${B}`,
		guildId: "guild-1",
		user: { id: userId },
		client,
		fields: {
			fields: new Map([...Object.keys(texts), ...Object.keys(selects)].map((id) => [id, {}])),
			getTextInputValue: (id: string) => texts[id] ?? "",
			getStringSelectValues: (id: string) => selects[id] ?? [],
		},
		reply: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModalSubmitInteraction & Record<"reply" | "deferReply" | "editReply", Spy>;
}

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.updateSecretIf.mockResolvedValue({} as never);
	postMoveMock.mockResolvedValue(true);
});

describe("the Trade button with no offer open", () => {
	it("offers a private picker of the other seats still playing", async () => {
		const state = tradeMatch();
		state.seats[2].bankrupt = true;
		const interaction = makeButton(A);

		await handleMtrade(interaction, seed(state));

		expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
		const payload = interaction.editReply.mock.calls[0][0] as { components: { toJSON(): { components: { custom_id: string; options: { label: string; value: string }[] }[] } }[] };
		const picker = payload.components[0].toJSON().components[0];
		expect(picker.custom_id).toBe("gameroomSelect:mtradeWith:room-1");
		// Only B: A is the one asking, and C is out of the match. B's member could not
		// be fetched, so the label falls back to the seat number the board shows.
		expect(picker.options).toEqual([{ label: "Seat 2", value: B }]);
	});

	it("says so when nobody is left to trade with", async () => {
		const state = tradeMatch();
		state.seats[1].bankrupt = true;
		state.seats[2].bankrupt = true;
		const interaction = makeButton(A);
		await handleMtrade(interaction, seed(state));
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.monopoly.noTradePartners }));
	});

	it("turns away a seat that is out of the match", async () => {
		const state = tradeMatch();
		state.seats[0].bankrupt = true;
		const interaction = makeButton(A);
		await handleMtrade(interaction, seed(state));
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.monopoly.inventoryOut }));
	});
});

describe("the offer modal", () => {
	function pickPartner(userId: string, partnerId: string) {
		return {
			customId: "gameroomSelect:mtradeWith:room-1",
			guildId: "guild-1",
			user: { id: userId },
			values: [partnerId],
			client,
			reply: vi.fn().mockResolvedValue(undefined),
			showModal: vi.fn().mockResolvedValue(undefined),
		} as unknown as StringSelectMenuInteraction & Record<"reply" | "showModal", Spy>;
	}
	type ModalJson = { custom_id: string; components: { component: { custom_id: string; options?: { value: string }[] } }[] };
	const shownModal = (interaction: { showModal: Spy }): ModalJson => (interaction.showModal.mock.calls[0][0] as { toJSON(): ModalJson }).toJSON();

	it("lists exactly the lots each side may trade, chips each way, and jail cards because a card exists", async () => {
		seed(tradeMatch());
		const interaction = pickPartner(A, B);

		await handleTradePartnerSelect(interaction);

		const modal = shownModal(interaction);
		expect(modal.custom_id).toBe(`gameroomModal:mtrade:room-1:${B}`);
		// Discord allows five fields in a modal, and this is the fullest one there is.
		expect(modal.components).toHaveLength(5);
		const [give, want, ...counts] = modal.components.map((label) => label.component);
		expect(give.options?.map((option) => option.value)).toEqual(["reader-dock"]);
		expect(want.options?.map((option) => option.value)).toEqual(["vermillion-alley", "burnt-umber-row"]);
		expect(counts.map((field) => field.custom_id)).toEqual(["give_chips", "want_chips", "jail_cards"]);
	});

	it("leaves out a lot field for a side with nothing to trade, and the jail card field when nobody holds one", async () => {
		const state = tradeMatch();
		state.seats[0].gojfCards = 0;
		seed(state);
		const interaction = pickPartner(B, C);

		await handleTradePartnerSelect(interaction);

		expect(shownModal(interaction).components.map((label) => label.component.custom_id)).toEqual(["give_lots", "give_chips", "want_chips"]);
	});

	it("refuses a partner who is not a live seat, without opening the modal", async () => {
		seed(tradeMatch());
		const interaction = pickPartner(A, A);
		await handleTradePartnerSelect(interaction);
		expect(interaction.showModal).not.toHaveBeenCalled();
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.monopoly.noTradePartners }));
	});
});

describe("submitting an offer", () => {
	it("opens the trade with the terms typed, and confirms privately", async () => {
		seed(tradeMatch());
		const interaction = makeModal(A, {
			selects: { give_lots: ["reader-dock"], want_lots: ["vermillion-alley"] },
			texts: { give_chips: "100", want_chips: "", jail_cards: "1, 0" },
		});

		await handleTradeModal(interaction);

		expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
		expect(persisted().pendingTrade).toMatchObject({
			initiatorId: A,
			counterpartyId: B,
			offer: { properties: ["reader-dock"], chips: 100, gojf: 1 },
			request: { properties: ["vermillion-alley"], chips: 0, gojf: 0 },
		});
		expect(interaction.editReply).toHaveBeenCalledWith({ content: gameRoomsCopy.monopoly.tradeSent(B) });
	});

	// ⚠️ RISK M6: a spectator reading the channel learns that a trade was offered,
	// never what is in it.
	it("posts only who offered whom to the channel, with no lot, amount or card in it", async () => {
		seed(tradeMatch());
		await handleTradeModal(
			makeModal(A, { selects: { give_lots: ["reader-dock"], want_lots: ["vermillion-alley"] }, texts: { give_chips: "100", jail_cards: "1, 0" } })
		);

		expect(trailTexts()).toEqual([`<@${A}> offered <@${B}> a trade.`]);
		for (const text of trailTexts()) expect(text).not.toMatch(/Reader Dock|Vermillion Alley|\$|Jail/);
	});

	it("refuses a count that is not a plain whole number, and writes nothing", async () => {
		for (const texts of [{ give_chips: "1e3" }, { want_chips: "-5" }, { jail_cards: "1" }, { jail_cards: "1, 2, 3" }]) {
			vi.clearAllMocks();
			seed(tradeMatch());
			const interaction = makeModal(A, { texts });
			await handleTradeModal(interaction);
			const reply = interaction.editReply.mock.calls[0][0] as { embeds: { data: { description: string } }[] };
			expect(reply.embeds[0].data.description).toBe(gameRoomsCopy.monopoly.tradeNotANumber);
			expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
		}
	});

	it("passes the engine's own refusal back, such as an offer of chips the player does not have", async () => {
		seed(tradeMatch());
		const interaction = makeModal(A, { texts: { give_chips: "99999" } });
		await handleTradeModal(interaction);
		const reply = interaction.editReply.mock.calls[0][0] as { embeds: { data: { description: string } }[] };
		expect(reply.embeds[0].data.description).toBe(`<@${A}> does not have $99999.`);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
});

describe("the Trade button with an offer open", () => {
	type Review = { content?: string; embeds?: { data: { description: string } }[]; components?: { toJSON(): { components: { custom_id: string }[] } }[] };
	const reviewOf = (interaction: { reply: Spy }): Review => interaction.reply.mock.calls[0][0] as Review;
	const answerIds = (review: Review): string[] => (review.components ?? []).flatMap((row) => row.toJSON().components.map((button) => button.custom_id));

	function withOffer(): IGameRoom {
		const state = tradeMatch();
		state.pendingTrade = openOffer();
		return seed(state);
	}

	it("shows the counterparty the terms from their side, privately, with Accept and Decline for this offer", async () => {
		const interaction = makeButton(B);
		await handleMtrade(interaction, withOffer());

		const review = reviewOf(interaction);
		expect(interaction.reply.mock.calls[0][0]).toMatchObject({ flags: 64 });
		expect(review.embeds?.[0].data.description).toContain(gameRoomsCopy.monopoly.tradeYouGet("Reader Dock and $100"));
		expect(review.embeds?.[0].data.description).toContain(gameRoomsCopy.monopoly.tradeYouGive("Vermillion Alley"));
		expect(answerIds(review)).toEqual([`gameroom:mtradeAccept:room-1:${OPENED_AT}`, `gameroom:mtradeReject:room-1:${OPENED_AT}`]);
	});

	it("puts the trade card in the review's image slot when it draws, and keeps the terms as text", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "monopoly-trade-abc.png" });
		vi.mocked(renderTradeCard).mockResolvedValueOnce({ attachment, ref: "attachment://monopoly-trade-abc.png" });
		const interaction = makeButton(B);
		await handleMtrade(interaction, withOffer());

		const review = interaction.reply.mock.calls[0][0] as Review & { files?: unknown[]; embeds: { data: { image?: { url: string } } }[] };
		expect(review.files).toEqual([attachment]);
		expect(review.embeds[0].data.image?.url).toBe("attachment://monopoly-trade-abc.png");
		expect(review.embeds[0].data.description).toContain(gameRoomsCopy.monopoly.tradeYouGet("Reader Dock and $100"));
		expect(interaction.reply.mock.calls[0][0]).toMatchObject({ flags: 64 });
	});

	it("posts the text review with no file when the trade card does not draw", async () => {
		const interaction = makeButton(B);
		await handleMtrade(interaction, withOffer());
		expect((interaction.reply.mock.calls[0][0] as { files?: unknown[] }).files).toBeUndefined();
	});

	it("shows the initiator the terms from their side with Withdraw", async () => {
		const interaction = makeButton(A);
		await handleMtrade(interaction, withOffer());
		const review = reviewOf(interaction);
		expect(review.embeds?.[0].data.description).toContain(gameRoomsCopy.monopoly.tradeYouGive("Reader Dock and $100"));
		expect(answerIds(review)).toEqual([`gameroom:mtradeReject:room-1:${OPENED_AT}`]);
	});

	it("tells a third seat only that an offer is waiting, never its terms", async () => {
		const interaction = makeButton(C);
		await handleMtrade(interaction, withOffer());
		const review = reviewOf(interaction);
		expect(review.content).toBe(gameRoomsCopy.monopoly.tradeBetweenOthers(A, B));
		expect(review.embeds).toBeUndefined();
		expect(review.components).toBeUndefined();
	});
});

describe("answering an offer", () => {
	function withOffer(): IGameRoom {
		const state = tradeMatch();
		state.pendingTrade = openOffer();
		return seed(state);
	}

	it("accepts: every item moves at once, the trail says what moved, and the review turns into the outcome", async () => {
		const room = withOffer();
		const interaction = makeButton(B);

		await handleMtradeAccept(interaction, room, String(OPENED_AT));

		const after = persisted();
		expect(after.pendingTrade).toBeNull();
		expect(after.properties["reader-dock"].ownerId).toBe(B);
		expect(after.properties["vermillion-alley"].ownerId).toBe(A);
		expect(after.seats[0].chips).toBe(1500 - 100);
		expect(trailTexts()[0]).toBe(`<@${B}> accepted the trade from <@${A}>.`);
		expect(interaction.editReply).toHaveBeenCalledWith({ content: gameRoomsCopy.monopoly.tradeAccepted, embeds: [], components: [] });
	});

	it("refuses an answer button from an older offer, so it cannot settle a newer one", async () => {
		const room = withOffer();
		const interaction = makeButton(B);
		await handleMtradeAccept(interaction, room, String(OPENED_AT - 1));
		const followUp = interaction.followUp.mock.calls[0][0] as { embeds: { data: { description: string } }[] };
		expect(followUp.embeds[0].data.description).toBe(gameRoomsCopy.monopoly.tradeGone);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("refuses an accept from the player who made the offer", async () => {
		const room = withOffer();
		const interaction = makeButton(A);
		await handleMtradeAccept(interaction, room, String(OPENED_AT));
		expect(interaction.followUp).toHaveBeenCalledOnce();
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("declines for the counterparty and withdraws for the initiator, each with its own reply", async () => {
		const room = withOffer();
		const declined = makeButton(B);
		await handleMtradeReject(declined, room, String(OPENED_AT));
		expect(declined.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.monopoly.tradeDeclined }));
		expect(persisted().pendingTrade).toBeNull();

		vi.clearAllMocks();
		storeMock.updateSecretIf.mockResolvedValue({} as never);
		const again = withOffer();
		const withdrawn = makeButton(A);
		await handleMtradeReject(withdrawn, again, String(OPENED_AT));
		expect(withdrawn.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.monopoly.tradeWithdrawn }));
	});
});
