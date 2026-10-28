import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, ChannelType, TextChannel } from "discord.js";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(),
		update: vi.fn(),
		addPoolMember: vi.fn(),
		markArchived: vi.fn(),
		create: vi.fn(),
		findOpenByHost: vi.fn(),
	},
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({ readPrivateQuotaStatus: vi.fn().mockResolvedValue(null), startBlackjackRoomBoard: vi.fn() }));
// The opener card's picture (2026-10 item 243 Phase 4). The renderer answers null
// unless a case says otherwise, so every case written before the picture still
// sees the text card alone; the view is a fixed fake so no case needs avatars.
const cardMocks = vi.hoisted(() => ({ renderChallengeCard: vi.fn(), challengeCardView: vi.fn() }));
vi.mock("./challengeCardRenderer.js", () => cardMocks);

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
} from "./challengeBoard.js";
import { RoomProvisioner } from "./RoomProvisioner.js";
import { startBlackjackRoomBoard } from "./soloRooms.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as {
	findByRoomId: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
	addPoolMember: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	findOpenByHost: ReturnType<typeof vi.fn>;
};
const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };

const HOST = "host-1";

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

	function arcadeButton() {
		configMock.findByGuildId.mockResolvedValue({ gamesCategoryId: "arcade-cat", adminRoleId: null });
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

	it("seats every joiner in a room of its own, then deals the table there", async () => {
		const room = { roomId: "room-1" };
		const channel = { id: "bj-room-1" };
		openMock.mockResolvedValue({ ok: true, room, channel });
		boardMock.mockResolvedValue(true);
		const interaction = arcadeButton();

		await confirmStartMatch(interaction, makeRoom({ game: "blackjack", spectatorIds: ["a", "b"] }));

		// The whole pool plays, nobody is asked who: one table, every seat taken.
		expect(interaction.reply).not.toHaveBeenCalled();
		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ game: "blackjack", playerIds: [HOST, "a", "b"] }));
		expect(boardMock).toHaveBeenCalledWith(interaction.guild, room, channel);
		// This server stores no 💬dero-commands, so the start answers through answerInChannel's
		// private fallback, the edit of its private defer (2026-10 item 257 Phase 5).
		expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.board.cardStarted("bj-room-1") }));
	});

	it("tells the host the table could not start when its board does not deal", async () => {
		openMock.mockResolvedValue({ ok: true, room: { roomId: "room-1" }, channel: { id: "bj-room-1" } });
		boardMock.mockResolvedValue(false);
		const interaction = arcadeButton();

		await confirmStartMatch(interaction, makeRoom({ game: "blackjack", spectatorIds: ["a"] }));

		expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.anything()] }));
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
});

// ── Monopoly's auction choice ─────────────────────────────────────────
// The host turns auctions on or off on the draft card; the choice rides the draft
// row, which the provisioner adopts, so it is read once when the match is seeded.
describe("the draft's on or off settings (auctions, and the referee on Monopoly and Hold'em)", () => {
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

	it.each(["monopoly", "holdem"] as const)("stores %s's voice referee choice through the same handler, in its own field", async (game) => {
		const interaction = makeButton(HOST, members);
		await chooseDraftSetting(interaction, makeRoom({ game, visibility: "public" }), "referee", "on");
		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { referee: true });
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();

		await chooseDraftSetting(makeButton(HOST, members), makeRoom({ game, referee: true }), "referee", "off");
		expect(storeMock.update).toHaveBeenLastCalledWith("guild-1", "room-1", { referee: false });
	});

	it("refuses the referee toggle on a game with no voice lines, and the auctions on Hold'em, writing nothing", async () => {
		for (const [game, action] of [["battleship", "referee"], ["rps", "referee"], ["holdem", "auctions"]] as const) {
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

		await confirmStartMatch(interaction, makeRoom({ game: "monopoly", spectatorIds: ["a"], monopolyAuctions: true }));

		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ game: "monopoly", monopolyAuctions: true }));
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

// ── the per game start asks first, and the one room per host refusal offers its fix ──
// 2026-10 item 257, owner items 12 and 15. The press writes nothing; the confirm's Submit
// closes the open draft it named (never a running match) and then posts the new card.
describe("starting a challenge from a game button", () => {
	const members = makeMembers([{ id: HOST, bot: false, name: "Host" }]);
	type ConfirmReply = { content: string; components?: Array<{ components: Array<{ data: { custom_id: string } }> }> };
	const replyOf = (interaction: ButtonInteraction): ConfirmReply => (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as ConfirmReply;
	const confirmIdOf = (interaction: ButtonInteraction): string | undefined => replyOf(interaction).components?.[0]?.components[0]?.data.custom_id;
	const markArchived = () => (gameRoomStore as unknown as { markArchived: ReturnType<typeof vi.fn> }).markArchived;

	it("asks first and posts nothing on the press", async () => {
		storeMock.findOpenByHost.mockResolvedValue(null);
		const interaction = makeButton(HOST, members);

		await offerChallengeDraft(interaction, "rps");

		expect(confirmIdOf(interaction)).toBe("gameroom:newok:rps");
		expect(storeMock.create).not.toHaveBeenCalled();
	});

	it("offers to close an open draft, naming that draft in the confirm, and closes nothing yet", async () => {
		storeMock.findOpenByHost.mockResolvedValue(makeRoom({ roomId: "old-room", status: "draft" }));
		const interaction = makeButton(HOST, members);

		await offerChallengeDraft(interaction, "rps");

		expect(replyOf(interaction).content).toContain(gameRoomsCopy.confirms.replaceDraft);
		expect(confirmIdOf(interaction)).toBe("gameroom:newok:rps:old-room");
		expect(markArchived()).not.toHaveBeenCalled();
	});

	it("never offers to close a match in play, and says where it is", async () => {
		storeMock.findOpenByHost.mockResolvedValue(makeRoom({ roomId: "live-room", status: "playing", channelId: "ch-live" }));
		const interaction = makeButton(HOST, members);

		await offerChallengeDraft(interaction, "rps");

		expect(replyOf(interaction).content).toBe(gameRoomsCopy.confirms.matchInPlay("ch-live"));
		expect(confirmIdOf(interaction)).toBeUndefined();
	});

	it("closes the named draft on Submit, before it opens the new challenge", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ roomId: "old-room", status: "draft" }));
		storeMock.findOpenByHost.mockResolvedValue(null);
		const interaction = makeButton(HOST, members);
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
		const interaction = makeButton(HOST, members);

		await confirmChallengeDraft(interaction, "rps", "old-room");

		expect(markArchived()).not.toHaveBeenCalled();
		expect(storeMock.create).not.toHaveBeenCalled();
		expect(replyOf(interaction).content).toBe(gameRoomsCopy.confirms.matchInPlay("ch-live"));
	});
});
