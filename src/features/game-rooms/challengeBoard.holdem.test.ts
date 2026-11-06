import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(),
		update: vi.fn(),
		holdBuyInCharge: vi.fn(),
		recordBuyInCharge: vi.fn(),
		dropBuyInCharge: vi.fn(),
		releaseBuyInCharges: vi.fn(),
		takeBuyInPaid: vi.fn(),
		markArchived: vi.fn(),
		archiveDraft: vi.fn(),
	},
}));
vi.mock("@features/age-gate/ageGateRules.js", () => ({ hasConfirmedAge: vi.fn(async () => true), replyWithAgeGate: vi.fn() }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { debitWithReceipt: vi.fn(), refundReceipt: vi.fn(), closeReceipt: vi.fn(), credit: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({ readPrivateQuotaStatus: vi.fn().mockResolvedValue(null), describeSoloOpenFailure: () => "nope", startBlackjackRoomBoard: vi.fn() }));
vi.mock("./challengeCardRenderer.js", () => ({ renderChallengeCard: vi.fn().mockResolvedValue(null), challengeCardView: vi.fn() }));

import { acceptBuyIn, cancelDraft, confirmStartMatch, handleInviteSelect, startMatch } from "./challengeBoard.js";
import { RoomProvisioner } from "./RoomProvisioner.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { chipWalletStore } from "@db/stores/chipWalletStore.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── Hold'em on the challenge card (2026-10 item 263 R3-27) ───────────────
// Every buy in happens on the card, so the room deals as it opens: the card's Start refuses a
// table that could not deal a hand, and an Invite only card's invited members pay through
// Accept and buy in, on the same ledger Join uses, charged once and refunded once (risk R7).

import { hasConfirmedAge, replyWithAgeGate } from "@features/age-gate/ageGateRules.js";

const storeMock = gameRoomStore as unknown as Record<"findByRoomId" | "update" | "holdBuyInCharge" | "recordBuyInCharge" | "releaseBuyInCharges" | "takeBuyInPaid" | "archiveDraft", ReturnType<typeof vi.fn>>;
const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const walletMock = chipWalletStore as unknown as Record<"debitWithReceipt" | "credit", ReturnType<typeof vi.fn>>;

const HOST = "host-1";
const INVITED = "invited-1";

function holdemDraft(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "holdem",
		hostId: HOST,
		playerIds: [HOST],
		spectatorIds: [INVITED],
		visibility: "invite",
		status: "draft",
		network: false,
		botSeats: 0,
		holdemBuyIn: 2_500,
		buyInPaidBy: [],
		kickedIds: [],
		channelId: null,
		boardMessageId: null,
		...overrides,
	} as unknown as IGameRoom;
}

function press(userId: string): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild: { id: "guild-1", channels: { fetch: vi.fn().mockResolvedValue(null) }, members: { cache: new Map(), fetch: vi.fn().mockResolvedValue(null) } },
		user: { id: userId },
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

// What a notice said: these fakes cannot show a modal, so the notice falls back to a reply.
const said = (interaction: ButtonInteraction): string => JSON.stringify((interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? null);
const paidBack = (): string[] => walletMock.credit.mock.calls.map((call) => (call[0] as { userId: string }).userId);

beforeEach(() => {
	vi.clearAllMocks();
	configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: true });
	walletMock.debitWithReceipt.mockResolvedValue({ balance: 0 });
	walletMock.credit.mockResolvedValue({ balance: 0 });
	storeMock.holdBuyInCharge.mockResolvedValue({});
	storeMock.recordBuyInCharge.mockResolvedValue({});
	storeMock.releaseBuyInCharges.mockResolvedValue(null);
	storeMock.takeBuyInPaid.mockResolvedValue({});
	storeMock.update.mockResolvedValue(undefined);
	storeMock.findByRoomId.mockResolvedValue(holdemDraft({ buyInPaidBy: [INVITED] }));
});

describe("the card's Start, for a table dealt as it opens", () => {
	it("refuses fewer than two seats, naming the count, before any channel exists", async () => {
		const interaction = press(HOST);
		// The invited member never accepted, so a chip table would seat the host alone.
		await startMatch(interaction, holdemDraft());

		expect(said(interaction)).toContain(gameRoomsCopy.holdem.startTooFewSeats(2, 1));
		expect(RoomProvisioner.open).not.toHaveBeenCalled();
	});

	it("refuses again on the confirm, which re-reads the seats", async () => {
		const interaction = press(HOST);
		await confirmStartMatch(interaction, holdemDraft());

		expect(said(interaction)).toContain(gameRoomsCopy.holdem.startTooFewSeats(2, 1));
		expect(RoomProvisioner.open).not.toHaveBeenCalled();
	});

	it("starts with the host and one payer, or against a Dero bot, which counts as a seat", async () => {
		for (const room of [holdemDraft({ buyInPaidBy: [INVITED] }), holdemDraft({ spectatorIds: [], botSeats: 1 })]) {
			const interaction = press(HOST);
			await startMatch(interaction, room);
			expect(said(interaction)).not.toContain("A hand needs at least");
			expect(said(interaction)).toContain("gameroom:startok:room-1");
		}
	});

	it("refuses a free table that would seat more than six", async () => {
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: false });
		const interaction = press(HOST);
		await startMatch(interaction, holdemDraft({ visibility: "public", spectatorIds: ["a", "b", "c", "d", "e", "f"] }));

		expect(said(interaction)).toContain(gameRoomsCopy.holdem.startTooManySeats(6, 7));
	});

	it("lets a network table open short, since its players come from the network board", async () => {
		const interaction = press(HOST);
		await startMatch(interaction, holdemDraft({ network: true, visibility: "public", spectatorIds: [] }));

		expect(said(interaction)).not.toContain("A hand needs at least");
	});
});

// 2026-10 item 276, audit P1-2: Call it off and the end of the start countdown race for one
// draft. The cancel closes only a row still a draft, so whichever lands first wins and the
// loser moves nothing.
describe("Call it off", () => {
	it("refunds nothing and closes nothing once the countdown's start claimed the draft", async () => {
		storeMock.archiveDraft.mockResolvedValue(null);
		const interaction = press(HOST);

		await cancelDraft(interaction, holdemDraft({ buyInPaidBy: [INVITED] }));

		expect(storeMock.takeBuyInPaid).not.toHaveBeenCalled();
		expect(walletMock.credit).not.toHaveBeenCalled();
		expect(said(interaction)).toContain(gameRoomsCopy.board.draftGone);
	});

	it("refunds every payer the ledger held as the close found it, one claim each", async () => {
		// "late" paid after the press read the card; the close's own row still names them.
		storeMock.archiveDraft.mockResolvedValue(holdemDraft({ status: "archived", buyInPaidBy: [INVITED, "late"] }));

		await cancelDraft(press(HOST), holdemDraft({ buyInPaidBy: [INVITED] }));

		expect(storeMock.archiveDraft).toHaveBeenCalledWith("guild-1", "room-1");
		expect(storeMock.takeBuyInPaid.mock.calls.map((call) => call[2])).toEqual([INVITED, "late"]);
		expect(paidBack()).toEqual([INVITED, "late"]);
	});
});

describe("Accept and buy in", () => {
	it("asks an unconfirmed invited member their age and charges nothing", async () => {
		vi.mocked(hasConfirmedAge).mockResolvedValueOnce(false);
		const interaction = press(INVITED);
		await acceptBuyIn(interaction, holdemDraft());

		expect(replyWithAgeGate).toHaveBeenCalledWith(interaction);
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
	});

	it("charges an invited member the buy in once and records it on the ledger", async () => {
		const interaction = press(INVITED);
		await acceptBuyIn(interaction, holdemDraft());

		expect(walletMock.debitWithReceipt).toHaveBeenCalledOnce();
		expect(walletMock.debitWithReceipt).toHaveBeenCalledWith({ userId: INVITED }, 2_500, expect.any(String));
		expect(storeMock.recordBuyInCharge).toHaveBeenCalledWith("guild-1", "room-1", { userId: INVITED, buyIn: 2_500, chargeId: expect.any(String) }, 2_500);
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		expect(walletMock.credit).not.toHaveBeenCalled();
	});

	it("is pressable only by a member the host invited", async () => {
		for (const [userId, room] of [
			["stranger", holdemDraft()],
			[HOST, holdemDraft()],
			[INVITED, holdemDraft({ kickedIds: [INVITED] })],
			[INVITED, holdemDraft({ visibility: "public" })],
		] as const) {
			const interaction = press(userId);
			await acceptBuyIn(interaction, room);
			expect(said(interaction)).toContain(gameRoomsCopy.holdem.acceptOnlyInvited);
		}
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
	});

	it("charges nothing a second time once the member paid", async () => {
		const interaction = press(INVITED);
		await acceptBuyIn(interaction, holdemDraft({ buyInPaidBy: [INVITED] }));

		expect(said(interaction)).toContain(gameRoomsCopy.holdem.buyInAlreadyPaid);
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
	});

	it("seats the member free on a table that plays free, charging nothing", async () => {
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: false });
		const interaction = press(INVITED);
		await acceptBuyIn(interaction, holdemDraft());

		expect(said(interaction)).toContain(gameRoomsCopy.holdem.acceptFreeTable);
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
	});

	it("refunds once when the host removed the member while the charge ran", async () => {
		storeMock.findByRoomId.mockResolvedValue(holdemDraft({ spectatorIds: [], kickedIds: [INVITED], buyInPaidBy: [INVITED] }));
		const interaction = press(INVITED);
		await acceptBuyIn(interaction, holdemDraft());

		expect(storeMock.takeBuyInPaid).toHaveBeenCalledWith("guild-1", "room-1", INVITED);
		expect(paidBack()).toEqual([INVITED]);
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
	});

	it("refunds a paid member the host leaves out of a new invite pick, once", async () => {
		const room = holdemDraft({ spectatorIds: [INVITED, "other"], buyInPaidBy: [INVITED] });
		storeMock.findByRoomId.mockResolvedValue(room);
		const select = {
			customId: "gameroomSelect:invite:room-1",
			guildId: "guild-1",
			guild: {
				id: "guild-1",
				channels: { fetch: vi.fn().mockResolvedValue(null) },
				members: { cache: new Map([["other", { id: "other", user: { bot: false } }]]), fetch: vi.fn(async (id: string) => (id === "other" ? { id, user: { bot: false } } : null)) },
			},
			user: { id: HOST },
			values: ["other"],
			client: {},
			reply: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
		} as unknown as StringSelectMenuInteraction;

		await handleInviteSelect(select);

		expect(paidBack()).toEqual([INVITED]);
	});
});
