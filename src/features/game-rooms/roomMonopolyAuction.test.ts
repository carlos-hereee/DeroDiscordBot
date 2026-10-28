import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ButtonInteraction, Client, ModalSubmitInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: vi.fn(), updateSecretIf: vi.fn(), findPlayingByGame: vi.fn(), moveBoardMessage: vi.fn(async () => ({})) },
}));
// A Monopoly move's lines ride its turn's board, rather than one postMove each (2026-10 item
// 254, Arcade 8; the finished turn's board keeps them since item 263).
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn(), recordCarriedMoves: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
// The auction card answers null unless a case hands one back, so the other cases
// read the confirmation exactly as it posts when the card does not draw.
vi.mock("@features/games/monopolyRenderer.js", () => ({
	renderBoard: vi.fn(async () => null),
	renderAuctionCard: vi.fn(async () => null),
	monopolyAuctionView: vi.fn(() => ({})),
}));

import { handleMauction, handleBidModal, sweepMonopolyAuctions } from "./roomMonopolyAuction.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { renderAuctionCard } from "@features/games/monopolyRenderer.js";
import { AttachmentBuilder, TextChannel } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomMonopolyAuction ──────────────────────────────────────────────
// The bid button opens a sealed bid modal for its own round; a bid's amount
// reaches only the bidder until the close; and the sweep closes a round once its
// 60 seconds are up, never before.

const storeMock = gameRoomStore as unknown as {
	findByRoomId: ReturnType<typeof vi.fn>;
	updateSecretIf: ReturnType<typeof vi.fn>;
	findPlayingByGame: ReturnType<typeof vi.fn>;
};
const postMoveMock = roomTrail.postMove as unknown as ReturnType<typeof vi.fn>;
const carriedMock = roomTrail.recordCarriedMoves as unknown as ReturnType<typeof vi.fn>;
// Every line a move recorded, in order: the finished turn's board, then the new one's.
type RecordedMove = { actorId: string; kind: string; text: string };
const recorded = (): RecordedMove[] =>
	carriedMock.mock.calls.map((call) => call[1] as RecordedMove[]).flat();

const A = "player-a";
const B = "player-b";
const ROUND = 1_000_000;
const CLOSES = ROUND + BOT_CONSTANTS.MONOPOLY_AUCTION_ROUND_MS;
// The board message is not reachable here, so the redraw is a no-op.
// The room's channel, holding a board to edit or replace.
const roomChannel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
	messages: { fetch: vi.fn(async () => ({ edit: vi.fn(), delete: vi.fn() })) },
	send: vi.fn(async () => ({ id: "board-2", delete: vi.fn() })),
});
const client = { channels: { fetch: vi.fn(async () => roomChannel) }, guilds: { cache: new Map(), fetch: vi.fn(async () => null) } } as unknown as Client;

// A passed on Burnt Umber Row with auctions on; the round opened at ROUND.
function auctionMatch(): MonopolyState {
	const state = createInitialState([A, B], { auctionsEnabled: true }, 1_000, 1);
	state.phase = "in-auction";
	state.seats[0].position = 3;
	state.pendingAuction = { tileId: "burnt-umber-row", bids: {}, roundOpenedAt: ROUND, skippedBy: A };
	return state;
}

function makeRoom(state: MonopolyState): IGameRoom {
	return { roomId: "room-1", guildId: "guild-1", game: "monopoly", status: "playing", playerIds: [A, B], channelId: "ch-1", secret: state } as unknown as IGameRoom;
}

function seed(state: MonopolyState): IGameRoom {
	const room = makeRoom(state);
	storeMock.findByRoomId.mockResolvedValue(room);
	return room;
}

const persisted = (): MonopolyState => storeMock.updateSecretIf.mock.calls[0][3] as MonopolyState;
const trailTexts = (): string[] => recorded().map((move) => move.text);

type Spy = ReturnType<typeof vi.fn>;
function makeButton(userId: string) {
	return { user: { id: userId }, client, reply: vi.fn().mockResolvedValue(undefined), showModal: vi.fn().mockResolvedValue(undefined) } as unknown as ButtonInteraction &
		Record<"reply" | "showModal", Spy>;
}

function makeBid(userId: string, amount: string, round: number = ROUND) {
	return {
		customId: `gameroomModal:mbid:room-1:${round}`,
		guildId: "guild-1",
		user: { id: userId },
		client,
		fields: { getTextInputValue: () => amount },
		reply: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModalSubmitInteraction & Record<"reply" | "deferReply" | "editReply", Spy>;
}

const errorText = (interaction: { editReply: Spy }): string =>
	(interaction.editReply.mock.calls[0][0] as { embeds: { data: { description: string } }[] }).embeds[0].data.description;

// The modals a press opened, and the text of its notice: a refusal or a short answer now
// opens a notice modal instead of a private reply (2026-10 item 254 Phase 5b).
const shownModals = (interaction: { showModal: unknown }) =>
	(interaction.showModal as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { toJSON(): { custom_id: string; components: { content?: string }[] } }).toJSON());
const noticeText = (interaction: { showModal: unknown }): string =>
	shownModals(interaction)
		.filter((modal) => modal.custom_id.startsWith("notice:"))
		.flatMap((modal) => modal.components.map((component) => component.content ?? ""))
		.join("\n");
// True when every modal the press opened is a notice, so no form or game modal opened.
const onlyNoticesShown = (interaction: { showModal: unknown }): boolean => shownModals(interaction).every((modal) => modal.custom_id.startsWith("notice:"));

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.updateSecretIf.mockResolvedValue({} as never);
	postMoveMock.mockResolvedValue(true);
	// Ten seconds into the round unless a case moves the clock.
	vi.spyOn(Date, "now").mockReturnValue(ROUND + 10_000);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the bid button", () => {
	it("opens the sealed bid modal for the round on the button, naming the lot", async () => {
		const interaction = makeButton(B);
		await handleMauction(interaction, makeRoom(auctionMatch()), String(ROUND));

		const modal = (interaction.showModal.mock.calls[0][0] as { toJSON(): { custom_id: string; components: { label: string }[] } }).toJSON();
		expect(modal.custom_id).toBe(`gameroomModal:mbid:room-1:${ROUND}`);
		expect(modal.components[0].label).toBe(gameRoomsCopy.monopoly.bidAmountLabel("Burnt Umber Row"));
	});

	it("says there is no auction when none is open", async () => {
		const state = auctionMatch();
		state.phase = "post-roll";
		state.pendingAuction = null;
		const interaction = makeButton(B);
		await handleMauction(interaction, makeRoom(state), String(ROUND));
		expect(noticeText(interaction)).toBe(gameRoomsCopy.monopoly.noAuction);
		expect(onlyNoticesShown(interaction)).toBe(true);
	});

	it("turns away a button from an earlier round, and a press after the close", async () => {
		const stale = makeButton(B);
		await handleMauction(stale, makeRoom(auctionMatch()), String(ROUND - 1));
		expect(noticeText(stale)).toBe(gameRoomsCopy.monopoly.auctionOver);

		vi.spyOn(Date, "now").mockReturnValue(CLOSES);
		const late = makeButton(B);
		await handleMauction(late, makeRoom(auctionMatch()), String(ROUND));
		expect(noticeText(late)).toBe(gameRoomsCopy.monopoly.auctionOver);
	});
});

describe("a sealed bid", () => {
	it("records the bid, tells only the bidder the amount, and tells the channel only that a bid came in", async () => {
		seed(auctionMatch());
		const interaction = makeBid(B, "150");

		await handleBidModal(interaction);

		expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
		expect(persisted().pendingAuction?.bids).toEqual({ [B]: 150 });
		expect(interaction.editReply).toHaveBeenCalledWith({ content: gameRoomsCopy.monopoly.bidPlaced(150, "Burnt Umber Row", CLOSES) });
		expect(trailTexts()).toEqual([`<@${B}> placed a bid on Burnt Umber Row.`]);
		for (const text of trailTexts()) expect(text).not.toContain("150");
	});

	it("attaches the auction card to the private confirmation when it draws", async () => {
		seed(auctionMatch());
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "monopoly-auction-abc.png" });
		vi.mocked(renderAuctionCard).mockResolvedValueOnce({ attachment, ref: "attachment://monopoly-auction-abc.png" });
		const interaction = makeBid(B, "150");

		await handleBidModal(interaction);

		expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
		expect(interaction.editReply).toHaveBeenCalledWith({ content: gameRoomsCopy.monopoly.bidPlaced(150, "Burnt Umber Row", CLOSES), files: [attachment] });
	});

	it("refuses text that is not a whole number before touching the match", async () => {
		seed(auctionMatch());
		const interaction = makeBid(B, "lots");
		await handleBidModal(interaction);
		expect(errorText(interaction)).toBe(gameRoomsCopy.monopoly.bidNotANumber);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("passes the engine's refusal back for a bid the player cannot pay", async () => {
		seed(auctionMatch());
		const interaction = makeBid(B, "5000");
		await handleBidModal(interaction);
		expect(errorText(interaction)).toBe("You only have $1500 to bid with.");
	});

	it("refuses a bid for another round, and a bid that arrives after the close but before the sweep", async () => {
		seed(auctionMatch());
		const stale = makeBid(B, "150", ROUND - 1);
		await handleBidModal(stale);
		expect(errorText(stale)).toBe(gameRoomsCopy.monopoly.auctionOver);

		vi.spyOn(Date, "now").mockReturnValue(CLOSES + 1);
		const late = makeBid(B, "150");
		await handleBidModal(late);
		expect(errorText(late)).toBe(gameRoomsCopy.monopoly.auctionOver);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
});

describe("sweepMonopolyAuctions", () => {
	it("closes a round whose time is up: the highest bid buys the lot and the turn carries on", async () => {
		const state = auctionMatch();
		state.pendingAuction = { tileId: "burnt-umber-row", bids: { [A]: 80, [B]: 120 }, roundOpenedAt: ROUND, skippedBy: A };
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(state)]);

		const summary = await sweepMonopolyAuctions(client, new Date(CLOSES));

		expect(summary).toEqual({ auctionsClosed: 1 });
		expect(persisted()).toMatchObject({ phase: "post-roll", pendingAuction: null });
		expect(persisted().properties["burnt-umber-row"].ownerId).toBe(B);
		expect(trailTexts()).toEqual([`<@${B}> won Burnt Umber Row at auction for $120.`]);
		expect(recorded()[0]).toMatchObject({ actorId: A, kind: "system" });
	});

	it("leaves a round with time left, and a match with no auction, alone", async () => {
		const idle = createInitialState([A, B], { auctionsEnabled: true }, 1_000, 1);
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(auctionMatch()), makeRoom(idle)]);

		expect(await sweepMonopolyAuctions(client, new Date(CLOSES - 1))).toEqual({ auctionsClosed: 0 });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("posts nothing when a bid landed first and the compare and swap refuses the close", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(auctionMatch())]);
		storeMock.updateSecretIf.mockResolvedValue(null);

		expect(await sweepMonopolyAuctions(client, new Date(CLOSES))).toEqual({ auctionsClosed: 0 });
		expect(trailTexts()).toEqual([]);
	});

	it("keeps going past a room that throws", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(auctionMatch()), makeRoom(auctionMatch())]);
		storeMock.updateSecretIf.mockRejectedValueOnce(new Error("Atlas hiccup")).mockResolvedValueOnce({} as never);

		expect(await sweepMonopolyAuctions(client, new Date(CLOSES))).toEqual({ auctionsClosed: 1 });
		expect(error).toHaveBeenCalledOnce();
	});
});
