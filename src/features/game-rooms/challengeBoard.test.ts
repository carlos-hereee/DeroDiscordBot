import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType, TextChannel } from "discord.js";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(),
		update: vi.fn(),
		addPoolMember: vi.fn(),
		markArchived: vi.fn(),
		create: vi.fn(),
		findOpenByHost: vi.fn(),
		findByRematchedFrom: vi.fn(),
	},
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({ openSoloRoom: vi.fn(), describeSoloOpenFailure: () => "solo nope" }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));

import { openInvitePicker, handleInviteSelect, joinChallenge, startMatch, rematchFromRoom, chooseMonopolyDraftSetting } from "./challengeBoard.js";
import { RoomProvisioner } from "./RoomProvisioner.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { roomTrail } from "./roomTrail.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as {
	findByRoomId: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
	addPoolMember: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	findOpenByHost: ReturnType<typeof vi.fn>;
	findByRematchedFrom: ReturnType<typeof vi.fn>;
};
const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };

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
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
	} as unknown as StringSelectMenuInteraction;
}

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
	storeMock.addPoolMember.mockResolvedValue(undefined);
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
		await handleInviteSelect(makeSelect(HOST, ["human-2", "bot-9"], members));

		expect(storeMock.update).toHaveBeenCalledOnce();
		const patch = storeMock.update.mock.calls[0][2] as { spectatorIds: string[] };
		expect(patch.spectatorIds).toEqual(["human-2"]);
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

// One rematch per finished room, ever: the result card stays clickable for the whole
// archive window, so without the marker every scroll-back press would spawn a room.
describe("the rematch button", () => {
	// The challenges channel the fresh card lands in. Object.create(TextChannel
	// .prototype) satisfies the `instanceof TextChannel` guard the resolver runs,
	// the same trick TestReminderJob's harness uses.
	function makeChallengesChannel() {
		return Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
			id: "chal-1",
			send: vi.fn().mockResolvedValue({ id: "card-1" }),
		});
	}

	function makeRematchButton(userId: string, channel: TextChannel): ButtonInteraction {
		return {
			guildId: "guild-1",
			guild: {
				id: "guild-1",
				members: { cache: new Map(), fetch: vi.fn().mockResolvedValue(null) },
				channels: { fetch: vi.fn().mockResolvedValue(channel) },
			},
			user: { id: userId, globalName: "Presser", username: "presser" },
			client: {},
			reply: vi.fn().mockResolvedValue(undefined),
		} as unknown as ButtonInteraction;
	}

	const finishedRoom = () =>
		makeRoom({ status: "finished", game: "rps", playerIds: [HOST, "p2"], visibility: "public" });

	beforeEach(() => {
		configMock.findByGuildId.mockResolvedValue({ arcadeChallengesChannelId: "chal-1" });
		storeMock.findByRematchedFrom.mockResolvedValue(null);
		storeMock.findOpenByHost.mockResolvedValue(null);
		storeMock.create.mockImplementation(async (input: Record<string, unknown>) => ({
			...makeRoom({ roomId: "room-2" }),
			...input,
			roomId: "room-2",
		}));
	});

	it("opens a fresh draft: presser as host, same game, the OTHER players pre-filling the pool", async () => {
		const channel = makeChallengesChannel();
		const interaction = makeRematchButton("p2", channel);

		await rematchFromRoom(interaction, finishedRoom());

		expect(storeMock.create).toHaveBeenCalledWith(
			expect.objectContaining({
				hostId: "p2",
				game: "rps",
				spectatorIds: [HOST],
				rematchedFromRoomId: "room-1",
			})
		);
		// The fresh card is real, and the finished room's transcript gets the one line
		// that connects the two (announcement 4e).
		expect(channel.send).toHaveBeenCalledOnce();
		expect(trailMock.postMove).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ roomId: "room-1" }),
			expect.objectContaining({ kind: "system", text: expect.stringContaining("<#chal-1>") })
		);
	});

	it("refuses a second rematch from the same finished room without creating a draft", async () => {
		storeMock.findByRematchedFrom.mockResolvedValue(makeRoom({ roomId: "room-2" }));
		const interaction = makeRematchButton("p2", makeChallengesChannel());

		await rematchFromRoom(interaction, finishedRoom());

		expect(storeMock.create).not.toHaveBeenCalled();
		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toMatch(/already offered/i);
	});

	it("refuses a rematch on a room that is not finished", async () => {
		const interaction = makeRematchButton("p2", makeChallengesChannel());
		await rematchFromRoom(interaction, makeRoom({ status: "playing", playerIds: [HOST, "p2"] }));
		expect(storeMock.create).not.toHaveBeenCalled();
		expect(storeMock.findByRematchedFrom).not.toHaveBeenCalled();
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

	it("starts a Monopoly pool of five, which seats six with the host, without asking who plays", async () => {
		const interaction = makeButton(HOST, members);
		await startMatch(interaction, makeRoom({ game: "monopoly", spectatorIds: ["a", "b", "c", "d", "e"] }));

		expect(interaction.reply).not.toHaveBeenCalled();
		expect(interaction.deferReply).toHaveBeenCalledOnce();
	});
});

// ── Monopoly's auction choice ─────────────────────────────────────────
// The host turns auctions on or off on the draft card; the choice rides the draft
// row, which the provisioner adopts, so it is read once when the match is seeded.
describe("the Monopoly auction toggle", () => {
	const members = makeMembers([{ id: HOST, bot: false, name: "Host" }]);
	const openMock = RoomProvisioner.open as unknown as ReturnType<typeof vi.fn>;

	it("stores the value the press names on the draft and acknowledges without a new message", async () => {
		const interaction = makeButton(HOST, members);
		await chooseMonopolyDraftSetting(interaction, makeRoom({ game: "monopoly", visibility: "public" }), "auctions", "on");

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { monopolyAuctions: true });
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		expect(interaction.reply).not.toHaveBeenCalled();
	});

	it("turns them back off", async () => {
		await chooseMonopolyDraftSetting(makeButton(HOST, members), makeRoom({ game: "monopoly", monopolyAuctions: true }), "auctions", "off");
		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { monopolyAuctions: false });
	});

	it("refuses the toggle on another game's draft, or with a value no card renders, and writes nothing", async () => {
		for (const [game, choice] of [["rps", "on"], ["monopoly", "maybe"]] as const) {
			const interaction = makeButton(HOST, members);
			await chooseMonopolyDraftSetting(interaction, makeRoom({ game }), "auctions", choice);
			expect(interaction.reply).toHaveBeenCalledOnce();
		}
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("stores the voice referee choice through the same handler, in its own field", async () => {
		const interaction = makeButton(HOST, members);
		await chooseMonopolyDraftSetting(interaction, makeRoom({ game: "monopoly", visibility: "public" }), "referee", "on");
		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { monopolyReferee: true });
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();

		await chooseMonopolyDraftSetting(makeButton(HOST, members), makeRoom({ game: "monopoly", monopolyReferee: true }), "referee", "off");
		expect(storeMock.update).toHaveBeenLastCalledWith("guild-1", "room-1", { monopolyReferee: false });
	});

	it("refuses the referee toggle on another game's draft and writes nothing", async () => {
		const interaction = makeButton(HOST, members);
		await chooseMonopolyDraftSetting(interaction, makeRoom({ game: "holdem" }), "referee", "on");
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.controlRetired }));
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("carries the host's choice from the draft into the match it opens", async () => {
		configMock.findByGuildId.mockResolvedValue({ gamesCategoryId: "arcade-cat", adminRoleId: null });
		openMock.mockResolvedValue({ ok: false, reason: "channel-failed" });
		const interaction = makeButton(HOST, members);
		Object.assign(interaction.guild as object, {
			channels: { fetch: vi.fn(async () => ({ id: "arcade-cat", type: ChannelType.GuildCategory })) },
		});

		await startMatch(interaction, makeRoom({ game: "monopoly", spectatorIds: ["a"], monopolyAuctions: true }));

		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ game: "monopoly", monopolyAuctions: true }));
	});
});
