import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, ChannelType, TextChannel } from "discord.js";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(),
		update: vi.fn(),
		// Start's player and pool lists, written as given: the filter against the stored pool is the
		// store's own (gameRoomStore.seatDraft), and stores are not unit tested (house rule 6).
		seatDraft: vi.fn(async (_guildId: string, _roomId: string, _hostId: string, playerIds: string[], spectatorIds: string[]) => ({ playerIds, spectatorIds })),
		addPoolMember: vi.fn(),
		markArchived: vi.fn(),
		archiveDraft: vi.fn(async (guildId: string, roomId: string) => ({ guildId, roomId, status: "archived", buyInPaidBy: [] })),
		create: vi.fn(),
		findOpenByHost: vi.fn(),
		setHoldemBuyIn: vi.fn(),
		// The host's own seat goes on the draft ledger at Start (2026-10 item 276, audit P3), held
		// on the row before the wallet is charged (2026-10 item 278, gap G3).
		holdBuyInCharge: vi.fn(async () => ({})),
		recordBuyInCharge: vi.fn(async () => ({})),
		dropBuyInCharge: vi.fn(),
		releaseBuyInCharges: vi.fn(async () => null),
	},
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({ readPrivateQuotaStatus: vi.fn().mockResolvedValue(null), startBlackjackRoomBoard: vi.fn(), describeSoloOpenFailure: () => "nope", freeSeatsOf: vi.fn() }));
// Every member's chip wallet, in memory: a Blackjack card charges its buy in like Hold'em's
// (2026-10 item 267), and a server with no chips switch stored plays for chips.
const wallets = vi.hoisted(() => new Map<string, number>());
const receipts = vi.hoisted(() => new Set<string>());
vi.mock("@features/economy/chipWallet.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/economy/chipWallet.js")>()),
	takeChips: vi.fn(async (key: { userId: string }, amount: number) => {
		const balance = wallets.get(key.userId) ?? 0;
		if (balance < amount) return false;
		wallets.set(key.userId, balance - amount);
		return true;
	}),
	returnChips: vi.fn(async (key: { userId: string }, amount: number) => {
		wallets.set(key.userId, (wallets.get(key.userId) ?? 0) + amount);
	}),
	// A charge onto the draft ledger rides a wallet receipt (2026-10 item 278, gap G3).
	takeChipsWithReceipt: vi.fn(async (key: { userId: string }, amount: number, receiptId: string) => {
		const balance = wallets.get(key.userId) ?? 0;
		if (balance < amount) return false;
		wallets.set(key.userId, balance - amount);
		receipts.add(receiptId);
		return true;
	}),
	refundChipReceipt: vi.fn(async (key: { userId: string }, amount: number, receiptId: string) => {
		if (!receipts.delete(receiptId)) return false;
		wallets.set(key.userId, (wallets.get(key.userId) ?? 0) + amount);
		return true;
	}),
	closeChipReceipt: vi.fn(async (_key: { userId: string }, receiptId: string) => {
		receipts.delete(receiptId);
	}),
}));
// The opener card's picture (2026-10 item 243 Phase 4). The renderer answers null
// unless a case says otherwise, so every case written before the picture still
// sees the text card alone; the view is a fixed fake so no case needs avatars.
const cardMocks = vi.hoisted(() => ({ renderChallengeCard: vi.fn(), challengeCardView: vi.fn() }));
vi.mock("./challengeCardRenderer.js", () => cardMocks);
// The age gate (2026-11 item 302) runs in offerChallengeDraft and joinChallenge; every case
// here is a confirmed member unless a case says otherwise.
vi.mock("@features/age-gate/ageGateRules.js", () => ({ hasConfirmedAge: vi.fn(async () => true), replyWithAgeGate: vi.fn() }));

import {
	openInvitePicker,
	handleInviteSelect,
	joinChallenge,
	startMatch,
	confirmStartMatch,
	chooseDraftSetting,
	handleOpponentSelect,
	offerChallengeDraft,
	confirmChallengeDraft,
	applyDraftWager,
} from "./challengeBoard.js";
import { RoomProvisioner } from "./RoomProvisioner.js";
import { startBlackjackRoomBoard } from "./soloRooms.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { _runStartCountdownsOut } from "./startCountdown.js";
import { startCountdownState } from "./startCountdownState.js";

const storeMock = gameRoomStore as unknown as {
	findByRoomId: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
	addPoolMember: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	findOpenByHost: ReturnType<typeof vi.fn>;
};
const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };

const HOST = "host-1";

// Start counts the match in (2026-10 item 267, decision 13): the room opens when the count ends,
// on the draft the count reads again. A case about what Start opens runs the count out at once.
async function countIn(draft: IGameRoom): Promise<void> {
	storeMock.findByRoomId.mockResolvedValue(draft);
	await _runStartCountdownsOut();
}

function makeRoom(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "rps",
		hostId: HOST,
		playerIds: [HOST],
		spectatorIds: [],
		visibility: "invite",
		status: "draft",
		channelId: null,
		boardMessageId: null,
		...overrides,
	} as unknown as IGameRoom;
}

// A member collection shaped like the parts challengeBoard actually touches.
function makeMembers(entries: Array<{ id: string; bot: boolean; name: string }>) {
	const map = new Map(
		entries.map((entry) => [
			entry.id,
			{ id: entry.id, displayName: entry.name, user: { bot: entry.bot, username: entry.name } },
		])
	);
	return {
		size: map.size,
		get: (id: string) => map.get(id),
		filter(predicate: (member: { id: string; user: { bot: boolean } }) => boolean) {
			return makeMembers(entries.filter((entry) => predicate({ id: entry.id, user: { bot: entry.bot } })));
		},
		map<T>(fn: (member: { id: string; displayName: string; user: { bot: boolean; username: string } }) => T): T[] {
			return [...map.values()].map(fn as never) as T[];
		},
	};
}

function makeButton(userId: string, members: ReturnType<typeof makeMembers>): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild: { id: "guild-1", members: { cache: members, fetch: vi.fn(async (id?: string) => (id ? members.get(id) ?? null : members)) } },
		user: { id: userId },
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

function makeSelect(userId: string, values: string[], members: ReturnType<typeof makeMembers>): StringSelectMenuInteraction {
	return {
		customId: "gameroomSelect:invite:room-1",
		guildId: "guild-1",
		guild: { id: "guild-1", members: { cache: members, fetch: vi.fn(async (id: string) => members.get(id) ?? null) } },
		user: { id: userId },
		values,
		isModalSubmit: () => false,
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue(undefined),
	} as unknown as StringSelectMenuInteraction;
}

beforeEach(() => {
	vi.clearAllMocks();
	startCountdownState._reset();
	storeMock.update.mockResolvedValue(undefined);
	storeMock.addPoolMember.mockResolvedValue(undefined);
	cardMocks.renderChallengeCard.mockResolvedValue(null);
	cardMocks.challengeCardView.mockResolvedValue({ game: "rps", status: "open", host: { name: "Host", avatar: null }, challengers: [], hiddenCount: 0 });
});

// ⚠️ F9's STRUCTURAL HALF. The picker is a StringSelect the BOT populates, which is
// the entire reason a bot can no longer be an opponent. A UserSelect is filled in by
// Discord and would return one; that is why the component type is not a style choice.
describe("the invite picker", () => {
	const members = makeMembers([
		{ id: HOST, bot: false, name: "Host" },
		{ id: "human-2", bot: false, name: "Real Member" },
		{ id: "bot-9", bot: true, name: "Dero" },
	]);

	// The row holds builder instances, so read the values through toJSON() rather
	// than off the builder's internals.
	async function pickerValues(interaction: ButtonInteraction): Promise<string[]> {
		await openInvitePicker(interaction, makeRoom());
		const payload = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			components: { toJSON: () => { components: { options?: { value: string }[] }[] } }[];
		};
		return payload.components[0].toJSON().components[0].options?.map((option) => option.value) ?? [];
	}

	it("never offers a bot as an option", async () => {
		const values = await pickerValues(makeButton(HOST, members));
		expect(values).toContain("human-2");
		expect(values).not.toContain("bot-9");
	});

	it("never offers the host themselves", async () => {
		expect(await pickerValues(makeButton(HOST, members))).not.toContain(HOST);
	});

	// The values come back from the CLIENT. However the menu was built, a customId and
	// its payload are user input, so the guarantee has to hold against a hand-crafted
	// interaction too.
	it("re-filters bots server side even if the client sends one back", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		const interaction = makeSelect(HOST, ["human-2", "bot-9"], members);
		await handleInviteSelect(interaction);

		expect(storeMock.update).toHaveBeenCalledOnce();
		const patch = storeMock.update.mock.calls[0][2] as { spectatorIds: string[] };
		expect(patch.spectatorIds).toEqual(["human-2"]);
		// Who was invited is an answer, so the picker message becomes it and loses its select (R3-11).
		expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.board.pickerSaved(1), components: [] }));
	});

	it("refuses a picker submission from somebody who is not the host", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		await handleInviteSelect(makeSelect("human-2", ["human-2"], members));
		expect(storeMock.update).not.toHaveBeenCalled();
	});
});

describe("the Join button", () => {
	const members = makeMembers([{ id: HOST, bot: false, name: "Host" }]);

	it("adds a member to the pool atomically", async () => {
		// $addToSet rather than a read-modify-write, because an open-to-all card is
		// exactly where several members click in the same tick.
		await joinChallenge(makeButton("joiner-2", members), makeRoom({ visibility: "public" }));
		expect(storeMock.addPoolMember).toHaveBeenCalledWith("guild-1", "room-1", "joiner-2");
	});

	it("refuses the host, who is already in", async () => {
		await joinChallenge(makeButton(HOST, members), makeRoom({ visibility: "public" }));
		expect(storeMock.addPoolMember).not.toHaveBeenCalled();
	});

	it("refuses a second press from someone already in the pool", async () => {
		await joinChallenge(makeButton("joiner-2", members), makeRoom({ visibility: "public", spectatorIds: ["joiner-2"] }));
		expect(storeMock.addPoolMember).not.toHaveBeenCalled();
	});

	it("refuses once the pool is at the cap, rather than letting the write fail", async () => {
		const full = Array.from({ length: BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS }, (_, i) => `m${i}`);
		await joinChallenge(makeButton("late-comer", members), makeRoom({ visibility: "public", spectatorIds: full }));
		expect(storeMock.addPoolMember).not.toHaveBeenCalled();
	});
});

describe("starting the match", () => {
	const members = makeMembers([{ id: HOST, bot: false, name: "Host" }]);

	it("refuses an empty pool instead of opening a room with nobody in it", async () => {
		const interaction = makeButton(HOST, members);
		await startMatch(interaction, makeRoom({ spectatorIds: [] }));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toMatch(/nobody has joined/i);
	});

	// One candidate needs no question. More than one does, and asking is what makes
	// "the host picks who plays, everyone else watches" true rather than arbitrary.
	it("asks who plays when more than one member joined", async () => {
		const interaction = makeButton(HOST, members);
		await startMatch(interaction, makeRoom({ spectatorIds: ["a", "b"] }));

		const payload = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			components?: unknown[];
		};
		expect(payload.components).toHaveLength(1);
	});

	// Monopoly seats the host plus the whole pool, and the board has six seats. The
	// refusal has to come HERE, before a channel exists, because the engine throws on
	// a seventh seat and the provisioner only builds the match once the channel is up.
	it("refuses a Monopoly pool that would seat more than six, before anything is built", async () => {
		const interaction = makeButton(HOST, members);
		await startMatch(interaction, makeRoom({ game: "monopoly", spectatorIds: ["a", "b", "c", "d", "e", "f"] }));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toBe(gameRoomsCopy.monopoly.tooManyPlayers(6, 6));
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	// 2026-10 item 257, owner item 12: the press only asks. The room channel is made on the
	// confirm's Submit (confirmStartMatch), so a host who closes the modal starts nothing.
	it("only asks on the press, building nothing until the confirm's Submit", async () => {
		const interaction = makeButton(HOST, members);
		await startMatch(interaction, makeRoom({ game: "monopoly", spectatorIds: ["a"] }));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { components: Array<{ components: Array<{ data: { custom_id: string } }> }> };
		expect(reply.components[0].components[0].data.custom_id).toBe("gameroom:startok:room-1");
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(storeMock.update).not.toHaveBeenCalled();
		expect(RoomProvisioner.open).not.toHaveBeenCalled();
	});

	it("refuses again on the confirm when the pool outgrew the board while it stood open", async () => {
		const interaction = makeButton(HOST, members);
		await confirmStartMatch(interaction, makeRoom({ game: "monopoly", spectatorIds: ["a", "b", "c", "d", "e", "f"] }));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toBe(gameRoomsCopy.monopoly.tooManyPlayers(6, 6));
		expect(RoomProvisioner.open).not.toHaveBeenCalled();
	});

	it("sends the host back to the button when more joined, since a picker cannot open from Submit", async () => {
		const interaction = makeButton(HOST, members);
		await confirmStartMatch(interaction, makeRoom({ spectatorIds: ["a", "b"] }));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toBe(gameRoomsCopy.confirms.startPickNeeded);
		expect(interaction.deferReply).not.toHaveBeenCalled();
	});

	it("starts a Monopoly pool of five, which seats six with the host, without asking who plays", async () => {
		const interaction = makeButton(HOST, members);
		await confirmStartMatch(interaction, makeRoom({ game: "monopoly", spectatorIds: ["a", "b", "c", "d", "e"] }));

		expect(interaction.reply).not.toHaveBeenCalled();
		expect(interaction.deferReply).toHaveBeenCalledOnce();
	});
});

// ── a Blackjack table plays in a room (2026-10 item 254, Arcade 1) ───────
describe("starting a Blackjack table", () => {
	const members = makeMembers([{ id: HOST, bot: false, name: "Host" }]);
	const openMock = RoomProvisioner.open as unknown as ReturnType<typeof vi.fn>;
	const boardMock = startBlackjackRoomBoard as unknown as ReturnType<typeof vi.fn>;

	function arcadeButton(options: { chipsOff?: boolean } = {}) {
		configMock.findByGuildId.mockResolvedValue({ gamesCategoryId: "arcade-cat", adminRoleId: null, ...(options.chipsOff ? { chipEconomyEnabled: false } : {}) });
		const interaction = makeButton(HOST, members);
		Object.assign(interaction.guild as object, {
			channels: { fetch: vi.fn(async () => ({ id: "arcade-cat", type: ChannelType.GuildCategory })) },
		});
		return interaction;
	}

	it("refuses a pool that would seat more than five, before anything is built", async () => {
		const interaction = makeButton(HOST, members);
		await startMatch(interaction, makeRoom({ game: "blackjack", spectatorIds: ["a", "b", "c", "d", "e"] }));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toBe(gameRoomsCopy.board.blackjackTooManyPlayers(5, 5));
		expect(openMock).not.toHaveBeenCalled();
	});

	// 2026-10 item 276, owner decision D13: a ranked table is shared, never solo, so its Start needs
	// two human seats counted the way the table seats them (on a chip table, the payers).
	it("refuses a ranked chip table's Start when nobody beside the host paid, before anything is built", async () => {
		const interaction = arcadeButton();
		const draft = makeRoom({ game: "blackjack", spectatorIds: ["a"], buyInPaidBy: [] });

		await startMatch(interaction, draft);

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toBe(gameRoomsCopy.board.blackjackRankedTooFew(BOT_CONSTANTS.BLACKJACK_RANKED_MIN_SEATS, 1));
		expect(openMock).not.toHaveBeenCalled();
	});

	it("lets a casual table, and a ranked one with a second payer, ask to start", async () => {
		// The Start confirm, as its fallback reply (this press opens no modal): its Submit is `startok`.
		const askedToStart = (interaction: ButtonInteraction): string => JSON.stringify((interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
		const casual = arcadeButton();
		await startMatch(casual, makeRoom({ game: "blackjack", spectatorIds: ["a"], buyInPaidBy: [], casual: true }));
		expect(askedToStart(casual)).toContain("gameroom:startok:room-1");

		const ranked = arcadeButton();
		await startMatch(ranked, makeRoom({ game: "blackjack", spectatorIds: ["a"], buyInPaidBy: ["a"] }));
		expect(askedToStart(ranked)).toContain("gameroom:startok:room-1");
	});

	it("seats every joiner in a room of its own, then deals the table there", async () => {
		const room = { roomId: "room-1" };
		const channel = { id: "bj-room-1" };
		openMock.mockResolvedValue({ ok: true, room, channel });
		boardMock.mockResolvedValue(true);
		const interaction = arcadeButton({ chipsOff: true });
		const draft = makeRoom({ game: "blackjack", spectatorIds: ["a", "b"] });

		await confirmStartMatch(interaction, draft);
		await countIn(draft);

		// The whole pool plays, nobody is asked who: one table, every seat taken, free on a server
		// with chips off (2026-10 item 267).
		expect(interaction.reply).not.toHaveBeenCalled();
		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ game: "blackjack", playerIds: [HOST, "a", "b"] }));
		expect(boardMock).toHaveBeenCalledWith(interaction.guild, room, channel, { buyIn: 1000, userIds: [HOST, "a", "b"], charged: false });
		// This server stores no 💬dero-commands, so the start answers through answerInChannel's
		// private fallback, the edit of its private defer (2026-10 item 257 Phase 5).
		expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.board.cardStarted("bj-room-1") }));
	});

	it("tells the host the table could not start when its board does not deal", async () => {
		openMock.mockResolvedValue({ ok: true, room: { roomId: "room-1" }, channel: { id: "bj-room-1" } });
		boardMock.mockResolvedValue(false);
		const interaction = arcadeButton({ chipsOff: true });
		const draft = makeRoom({ game: "blackjack", spectatorIds: ["a"] });

		await confirmStartMatch(interaction, draft);
		await countIn(draft);

		expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.anything()] }));
	});

	// 2026-10 item 267, owner decision 1: a chip table seats the host and every joiner who paid on
	// the card, each at the buy in the card set, and charges the host their own seat at Start.
	it("charges the host the card's buy in at Start and seats only the members who paid", async () => {
		wallets.clear();
		wallets.set(HOST, 5000);
		const room = { roomId: "room-1" };
		const channel = { id: "bj-room-1" };
		openMock.mockResolvedValue({ ok: true, room, channel });
		boardMock.mockResolvedValue(true);
		const interaction = arcadeButton();
		const draft = makeRoom({ game: "blackjack", spectatorIds: ["a", "b"], holdemBuyIn: 2500, buyInPaidBy: ["a"] });

		await confirmStartMatch(interaction, draft);
		await countIn(draft);

		expect(wallets.get(HOST)).toBe(2500);
		// The host's charge is on the draft ledger before the room is built, so a crash or Call it
		// off in those seconds still refunds it (2026-10 item 276, audit P3).
		expect(gameRoomStore.recordBuyInCharge).toHaveBeenCalledWith("guild-1", "room-1", { userId: HOST, buyIn: 2500, chargeId: expect.any(String) }, 2500);
		expect(boardMock).toHaveBeenCalledWith(interaction.guild, room, channel, { buyIn: 2500, userIds: [HOST, "a"], charged: true });
	});

	it("gives the host's charge straight back when the draft closed before it reached the ledger", async () => {
		wallets.clear();
		wallets.set(HOST, 5000);
		(gameRoomStore.recordBuyInCharge as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
		const interaction = arcadeButton();
		const draft = makeRoom({ game: "blackjack", spectatorIds: ["a"], holdemBuyIn: 2500, buyInPaidBy: ["a"] });

		await confirmStartMatch(interaction, draft);
		await countIn(draft);

		expect(wallets.get(HOST)).toBe(5000);
		expect(openMock).not.toHaveBeenCalled();
	});

	it("refuses the start when the host cannot cover the buy in, before any channel exists", async () => {
		wallets.clear();
		wallets.set(HOST, 10);
		const interaction = arcadeButton();

		await confirmStartMatch(interaction, makeRoom({ game: "blackjack", spectatorIds: ["a"] }));

		expect(openMock).not.toHaveBeenCalled();
		expect(boardMock).not.toHaveBeenCalled();
		expect(wallets.get(HOST)).toBe(10);
	});
});

// ── who watches once the match opens (2026-10 item 254, Arcade 11) ─────
describe("the spectator setting at start", () => {
	const members = makeMembers([{ id: HOST, bot: false, name: "Host" }, { id: "a", bot: false, name: "Ana" }, { id: "b", bot: false, name: "Ben" }]);
	const openMock = RoomProvisioner.open as unknown as ReturnType<typeof vi.fn>;

	// The host picks Ana; Ben joined too and is left over.
	async function startWithAna(room: IGameRoom) {
		configMock.findByGuildId.mockResolvedValue({ gamesCategoryId: "arcade-cat", adminRoleId: null });
		openMock.mockResolvedValue({ ok: false, reason: "createFailed" });
		storeMock.findByRoomId.mockResolvedValue(room);
		const select = {
			...makeSelect(HOST, ["a"], members),
			customId: "gameroomSelect:opponent:room-1",
			deferReply: vi.fn().mockResolvedValue(undefined),
			editReply: vi.fn().mockResolvedValue(undefined),
		};
		Object.assign(select.guild as object, { channels: { fetch: vi.fn(async () => ({ id: "arcade-cat", type: ChannelType.GuildCategory })) } });
		await handleOpponentSelect(select as unknown as StringSelectMenuInteraction);
		await countIn(room);
	}

	it.each([
		["public", null, []],
		["public", "open", []],
		["public", "invite", ["b"]],
		["public", "none", []],
		["invite", null, ["b"]],
		["invite", "none", []],
	] as const)("a %s room with setting %s keeps %j as spectators, and hands the setting on", async (visibility, spectatorMode, spectators) => {
		await startWithAna(makeRoom({ visibility, spectatorMode, spectatorIds: ["a", "b"] }));

		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ playerIds: [HOST, "a"], spectatorIds: [...spectators], spectatorMode }));
	});

	// 2026-10 item 276, audit P3: a picker outlives its card, so a second picker submitted after the
	// first started the match counted in again and redrew the live match's card as a draft.
	it("refuses a picker submitted after the match already started, and starts nothing", async () => {
		const select = {
			...makeSelect(HOST, ["a"], members),
			customId: "gameroomSelect:opponent:room-1",
		};
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "playing", spectatorIds: ["a", "b"] }));

		await handleOpponentSelect(select as unknown as StringSelectMenuInteraction);
		await _runStartCountdownsOut();

		expect(openMock).not.toHaveBeenCalled();
		expect(JSON.stringify((select.reply as ReturnType<typeof vi.fn>).mock.calls)).toContain(gameRoomsCopy.board.draftGone);
	});
});

// ── Monopoly's auction choice ─────────────────────────────────────────
// The host turns auctions on or off on the draft card; the choice rides the draft
// row, which the provisioner adopts, so it is read once when the match is seeded.
describe("the draft's on or off settings (auctions, and Dero voice on every game)", () => {
	const members = makeMembers([{ id: HOST, bot: false, name: "Host" }]);
	const openMock = RoomProvisioner.open as unknown as ReturnType<typeof vi.fn>;

	it("stores the value the press names on the draft and acknowledges without a new message", async () => {
		const interaction = makeButton(HOST, members);
		await chooseDraftSetting(interaction, makeRoom({ game: "monopoly", visibility: "public" }), "auctions", "on");

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { monopolyAuctions: true });
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		expect(interaction.reply).not.toHaveBeenCalled();
	});

	it("turns them back off", async () => {
		await chooseDraftSetting(makeButton(HOST, members), makeRoom({ game: "monopoly", monopolyAuctions: true }), "auctions", "off");
		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { monopolyAuctions: false });
	});

	it("refuses the toggle on another game's draft, or with a value no card renders, and writes nothing", async () => {
		for (const [game, choice] of [["rps", "on"], ["monopoly", "maybe"]] as const) {
			const interaction = makeButton(HOST, members);
			await chooseDraftSetting(interaction, makeRoom({ game }), "auctions", choice);
			expect(interaction.reply).toHaveBeenCalledOnce();
		}
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	// An older card's referee toggle writes Dero voice (2026-10 item 267, decision 10), on every game.
	it.each(["monopoly", "holdem", "battleship", "rps"] as const)("stores %s's Dero voice through the same handler, in its own field", async (game) => {
		const interaction = makeButton(HOST, members);
		await chooseDraftSetting(interaction, makeRoom({ game, visibility: "public" }), "referee", "on");
		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { deroVoice: true });
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();

		await chooseDraftSetting(makeButton(HOST, members), makeRoom({ game, deroVoice: true }), "referee", "off");
		expect(storeMock.update).toHaveBeenLastCalledWith("guild-1", "room-1", { deroVoice: false });
	});

	it("refuses the auctions on Hold'em, and Dero voice on a slug with no card, writing nothing", async () => {
		for (const [game, action] of [["solo-coinflip", "referee"], ["holdem", "auctions"]] as const) {
			const interaction = makeButton(HOST, members);
			await chooseDraftSetting(interaction, makeRoom({ game }), action, "on");
			expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.controlRetired }));
		}
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("carries the host's choice from the draft into the match it opens", async () => {
		configMock.findByGuildId.mockResolvedValue({ gamesCategoryId: "arcade-cat", adminRoleId: null });
		openMock.mockResolvedValue({ ok: false, reason: "channel-failed" });
		const interaction = makeButton(HOST, members);
		Object.assign(interaction.guild as object, {
			channels: { fetch: vi.fn(async () => ({ id: "arcade-cat", type: ChannelType.GuildCategory })) },
		});

		const draft = makeRoom({ game: "monopoly", spectatorIds: ["a"], monopolyAuctions: true, casual: true });
		await confirmStartMatch(interaction, draft);
		await countIn(draft);

		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ game: "monopoly", monopolyAuctions: true }));
	});
});

// ── the start countdown (2026-10 item 267, owner decision 13) ─────────
// Start counts the match in for START_COUNTDOWN_MS on the card, then opens the room only if the
// draft is still open; Call it off during the count opens nothing, and a second Start is a state.
describe("the start countdown", () => {
	const members = makeMembers([{ id: HOST, bot: false, name: "Host" }]);
	const openMock = RoomProvisioner.open as unknown as ReturnType<typeof vi.fn>;
	const COUNT = BOT_CONSTANTS.START_COUNTDOWN_MS;

	function arcadeHost() {
		configMock.findByGuildId.mockResolvedValue({ gamesCategoryId: "arcade-cat", adminRoleId: null });
		openMock.mockResolvedValue({ ok: false, reason: "channel-failed" });
		const interaction = makeButton(HOST, members);
		Object.assign(interaction.guild as object, { channels: { fetch: vi.fn(async () => ({ id: "arcade-cat", type: ChannelType.GuildCategory })) } });
		return interaction;
	}

	it("opens the room only once the count has run its ten seconds", async () => {
		vi.useFakeTimers();
		try {
			const draft = makeRoom({ game: "monopoly", spectatorIds: ["a"], casual: true });
			storeMock.findByRoomId.mockResolvedValue(draft);

			await confirmStartMatch(arcadeHost(), draft);
			await vi.advanceTimersByTimeAsync(COUNT - 1);
			expect(openMock).not.toHaveBeenCalled();
			expect(startCountdownState.isCountingDown(draft)).toBe(true);

			await vi.advanceTimersByTimeAsync(1);
			await vi.waitFor(() => expect(openMock).toHaveBeenCalledOnce());
			expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ game: "monopoly", playerIds: [HOST, "a"] }));
			expect(startCountdownState.isCountingDown(draft)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("opens nothing when the host called the challenge off during the count", async () => {
		vi.useFakeTimers();
		try {
			const draft = makeRoom({ game: "monopoly", spectatorIds: ["a"], casual: true });
			await confirmStartMatch(arcadeHost(), draft);
			// Call it off archived the draft while the card counted.
			storeMock.findByRoomId.mockResolvedValue({ ...draft, status: "archived" });

			await vi.advanceTimersByTimeAsync(COUNT);
			await _runStartCountdownsOut();
			expect(openMock).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// 2026-10 item 276, owner decision D4: a ranked Monopoly match seats only those who paid its
	// buy in, so a Start with fewer payers than the game's fewest seats opens nothing.
	it("refuses a ranked Monopoly Start with too few paid seats, opening nothing", async () => {
		const draft = makeRoom({ game: "monopoly", spectatorIds: ["a"] });
		const interaction = arcadeHost();
		await confirmStartMatch(interaction, draft);
		expect((interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ content: gameRoomsCopy.monopoly.tooFewPaid(2, 1) });
		expect(startCountdownState.isCountingDown(draft)).toBe(false);
		expect(openMock).not.toHaveBeenCalled();
	});

	it("answers a second Start during the count with a notice, and counts once", async () => {
		const draft = makeRoom({ game: "monopoly", spectatorIds: ["a"], casual: true });
		await confirmStartMatch(arcadeHost(), draft);

		const again = makeButton(HOST, members);
		await startMatch(again, draft);
		const reply = (again.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toBe(gameRoomsCopy.board.countdownRunning);

		const confirmAgain = arcadeHost();
		await confirmStartMatch(confirmAgain, draft);
		expect((confirmAgain.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ content: gameRoomsCopy.board.countdownRunning });

		await countIn(draft);
		expect(openMock).toHaveBeenCalledOnce();
	});

	it("opens nothing when the pool emptied during the count, and says why", async () => {
		const draft = makeRoom({ game: "rps", spectatorIds: ["a"] });
		const interaction = arcadeHost();
		await confirmStartMatch(interaction, draft);

		await countIn({ ...draft, spectatorIds: [] } as unknown as IGameRoom);
		expect(openMock).not.toHaveBeenCalled();
		expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.board.poolEmpty }));
	});
});

describe("the opener card's picture", () => {
	const members = makeMembers([{ id: HOST, bot: false, name: "Host" }]);
	type CardEdit = { embeds: Array<{ data: { image?: { url: string }; thumbnail?: { url: string } } }>; files: Array<{ name?: string }>; attachments: unknown[] };

	// A board the refresh can reach: the stored challenges channel, and the card
	// message inside it whose edits each case reads.
	function rigBoard(userId: string) {
		const edit = vi.fn().mockResolvedValue(undefined);
		const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
			id: "chal-1",
			messages: { fetch: vi.fn().mockResolvedValue({ edit }) },
		});
		configMock.findByGuildId.mockResolvedValue({ arcadeChallengesChannelId: "chal-1" });
		const interaction = makeButton(userId, members);
		Object.assign(interaction.guild as object, { channels: { fetch: vi.fn().mockResolvedValue(channel) } });
		return { interaction, edit };
	}
	const boardRoom = () => makeRoom({ visibility: "public", boardMessageId: "card-1" });

	it("edits the card with the faces as its image when the picture draws", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "challenge-abc.png" });
		cardMocks.renderChallengeCard.mockResolvedValue({ attachment, ref: "attachment://challenge-abc.png" });
		const { interaction, edit } = rigBoard("joiner-2");

		await joinChallenge(interaction, boardRoom());

		const payload = edit.mock.calls[0][0] as CardEdit;
		expect(payload.embeds[0].data.image?.url).toBe("attachment://challenge-abc.png");
		expect(payload.files).toEqual([attachment]);
		expect(payload.attachments).toEqual([]);
	});

	it("edits the text card alone, dropping any earlier picture, when the picture does not draw", async () => {
		cardMocks.renderChallengeCard.mockRejectedValue(new Error("simulated renderer failure"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { interaction, edit } = rigBoard("joiner-2");

		// A game with no logo (rps took one in 2026-10 item 254 Phase 5a), so the text card
		// carries no file at all.
		await joinChallenge(interaction, makeRoom({ game: "coinflip", visibility: "public", boardMessageId: "card-1" }));

		const payload = edit.mock.calls[0][0] as CardEdit;
		expect(payload.embeds[0].data.image).toBeUndefined();
		expect(payload.files).toEqual([]);
		expect(payload.attachments).toEqual([]);
	});

	it("leads the text card with the game's logo when a game with one has no picture", async () => {
		cardMocks.renderChallengeCard.mockResolvedValue(null);
		const { interaction, edit } = rigBoard("joiner-2");

		await joinChallenge(interaction, makeRoom({ game: "battleship", visibility: "public", boardMessageId: "card-1" }));

		const payload = edit.mock.calls[0][0] as CardEdit;
		expect(payload.embeds[0].data.thumbnail?.url).toBe("attachment://opener-logo.png");
		expect(payload.files.map((file) => file.name)).toEqual(["opener-logo.png"]);
		expect(payload.attachments).toEqual([]);
	});

	it("drops a slow render once a newer edit has started, so the newer pool wins", async () => {
		let releaseFirst: (value: null) => void = () => undefined;
		cardMocks.renderChallengeCard
			.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
			.mockResolvedValueOnce(null);
		const first = rigBoard("joiner-2");
		const second = rigBoard("joiner-3");

		const firstJoin = joinChallenge(first.interaction, boardRoom());
		await vi.waitFor(() => expect(cardMocks.renderChallengeCard).toHaveBeenCalledTimes(1));
		await joinChallenge(second.interaction, boardRoom());
		releaseFirst(null);
		await firstJoin;

		expect(second.edit).toHaveBeenCalledTimes(1);
		expect(first.edit).not.toHaveBeenCalled();
	});
});

// ── the per game start opens the creation modal, and a held draft folds into it ──
// 2026-10 item 257, owner items 12 and 15, and 2026-10 item 263 Phase 2a (R3-9, R3-13). The
// press writes nothing; the modal's Submit closes the held draft it named (never a running
// match) and then posts the new card.
describe("starting a challenge from a game button", () => {
	const members = makeMembers([{ id: HOST, bot: false, name: "Host" }]);
	type ShownModal = { toJSON: () => { custom_id: string; components: Array<{ type: number; content?: string }> } };
	const withModal = (interaction: ButtonInteraction): ButtonInteraction & { showModal: ReturnType<typeof vi.fn> } =>
		Object.assign(interaction, { showModal: vi.fn().mockResolvedValue(undefined) }) as ButtonInteraction & { showModal: ReturnType<typeof vi.fn> };
	const modalOf = (interaction: { showModal: ReturnType<typeof vi.fn> }) => (interaction.showModal.mock.calls[0][0] as ShownModal).toJSON();
	const replyOf = (interaction: ButtonInteraction): { content: string } => (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
	const markArchived = () => (gameRoomStore as unknown as { archiveDraft: ReturnType<typeof vi.fn> }).archiveDraft;
	const asSubmit = (interaction: ButtonInteraction) => Object.assign(interaction, { isModalSubmit: () => false });

	it("opens the creation modal and posts nothing on the press", async () => {
		storeMock.findOpenByHost.mockResolvedValue(null);
		const interaction = withModal(makeButton(HOST, members));

		await offerChallengeDraft(interaction, "rps");

		expect(modalOf(interaction).custom_id).toBe("gameroom:newok:rps");
		expect(storeMock.create).not.toHaveBeenCalled();
	});

	it("offers to close an open draft inside the modal, naming that draft, and closes nothing yet", async () => {
		storeMock.findOpenByHost.mockResolvedValue(makeRoom({ roomId: "old-room", status: "draft" }));
		const interaction = withModal(makeButton(HOST, members));

		await offerChallengeDraft(interaction, "rps");

		const modal = modalOf(interaction);
		expect(modal.custom_id).toBe("gameroom:newok:rps:old-room");
		expect(JSON.stringify(modal.components)).toContain("You already have a challenge open");
		expect(markArchived()).not.toHaveBeenCalled();
	});

	it("never offers to close a match in play, and says where it is", async () => {
		storeMock.findOpenByHost.mockResolvedValue(makeRoom({ roomId: "live-room", status: "playing", channelId: "ch-live" }));
		const interaction = withModal(makeButton(HOST, members));

		await offerChallengeDraft(interaction, "rps");

		expect(interaction.showModal).toHaveBeenCalledOnce();
		expect(JSON.stringify(modalOf(interaction))).toContain(gameRoomsCopy.confirms.matchInPlay("ch-live"));
		expect(modalOf(interaction).custom_id.startsWith("notice:")).toBe(true);
	});

	it("closes the named draft on Submit, before it opens the new challenge", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ roomId: "old-room", status: "draft" }));
		storeMock.findOpenByHost.mockResolvedValue(null);
		const interaction = asSubmit(makeButton(HOST, members));
		// No challenges channel, so the new card stops at its own honest refusal; this case
		// is about the order of the close and the open.
		Object.assign(interaction.guild as object, { channels: { cache: { find: () => undefined }, fetch: vi.fn(async () => null) } });

		await confirmChallengeDraft(interaction, "rps", "old-room");

		expect(markArchived()).toHaveBeenCalledWith("guild-1", "old-room");
		expect(markArchived().mock.invocationCallOrder[0]).toBeLessThan(storeMock.findOpenByHost.mock.invocationCallOrder[0]);
	});

	it("refuses to touch the room on Submit once it started, answering with where it plays", async () => {
		const live = makeRoom({ roomId: "old-room", status: "playing", channelId: "ch-live" });
		storeMock.findByRoomId.mockResolvedValue(live);
		storeMock.findOpenByHost.mockResolvedValue(live);
		const interaction = asSubmit(makeButton(HOST, members));

		await confirmChallengeDraft(interaction, "rps", "old-room");

		expect(markArchived()).not.toHaveBeenCalled();
		expect(storeMock.create).not.toHaveBeenCalled();
		const followUp = (interaction as unknown as { followUp?: ReturnType<typeof vi.fn> }).followUp;
		const answer = (followUp?.mock.calls[0]?.[0] ?? replyOf(interaction)) as { content: string };
		expect(answer.content).toBe(gameRoomsCopy.errors.alreadyHosting("ch-live"));
	});
});

// ── Battleship's chip wager (2026-10 item 276, owner decision D10) ─────
// Typed on the creation modal or Edit settings: blank means none, so the match plays free. It is
// refused on a match that plays free, outside its bounds, and once a payment locked the ledger.
describe("the Battleship wager", () => {
	const setMock = (gameRoomStore as unknown as { setHoldemBuyIn: ReturnType<typeof vi.fn> }).setHoldemBuyIn;
	const words = gameRoomsCopy.holdem;
	const { BATTLESHIP_MIN_WAGER, BATTLESHIP_MAX_WAGER } = BOT_CONSTANTS.ECONOMY;
	const ranked = (overrides: Partial<IGameRoom> = {}) => makeRoom({ game: "battleship", holdemBuyIn: null, ...overrides });

	beforeEach(() => {
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: true });
		setMock.mockImplementation(async (_guildId: string, _roomId: string, amount: number | null) => ranked({ holdemBuyIn: amount }));
	});

	it("writes a wager inside its bounds on a ranked card, and clears it on a blank", async () => {
		expect(await applyDraftWager(ranked(), "250")).toEqual({ ok: true, room: ranked({ holdemBuyIn: 250 }) });
		expect(setMock).toHaveBeenCalledWith("guild-1", "room-1", 250);
		expect(await applyDraftWager(ranked({ holdemBuyIn: 250 }), "  ")).toEqual({ ok: true, room: ranked({ holdemBuyIn: null }) });
		expect(setMock).toHaveBeenLastCalledWith("guild-1", "room-1", null);
	});

	it("answers null for the wager already in force, writing nothing", async () => {
		expect(await applyDraftWager(ranked(), "")).toBeNull();
		expect(await applyDraftWager(ranked({ holdemBuyIn: 500 }), "500")).toBeNull();
		expect(setMock).not.toHaveBeenCalled();
	});

	it("refuses an amount that is no number or outside the bounds", async () => {
		const invalid = { ok: false, refusal: words.wagerInvalid(BATTLESHIP_MIN_WAGER, BATTLESHIP_MAX_WAGER) };
		expect(await applyDraftWager(ranked(), "lots")).toEqual(invalid);
		expect(await applyDraftWager(ranked(), String(BATTLESHIP_MIN_WAGER - 1))).toEqual(invalid);
		expect(await applyDraftWager(ranked(), String(BATTLESHIP_MAX_WAGER + 1))).toEqual(invalid);
		expect(setMock).not.toHaveBeenCalled();
	});

	it("refuses a wager on a match that plays free: Casual, or chips off", async () => {
		expect(await applyDraftWager(ranked({ casual: true }), "250")).toEqual({ ok: false, refusal: words.wagerFreeMatch });
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: false });
		expect(await applyDraftWager(ranked(), "250")).toEqual({ ok: false, refusal: words.wagerFreeMatch });
		expect(setMock).not.toHaveBeenCalled();
	});

	it("keeps the wager a captain already paid", async () => {
		setMock.mockResolvedValue(null);
		expect(await applyDraftWager(ranked({ holdemBuyIn: 250 }), "500")).toEqual({ ok: false, refusal: words.wagerLocked });
	});
});
