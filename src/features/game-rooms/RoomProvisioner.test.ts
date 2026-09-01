import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordAPIError, PermissionFlagsBits } from "discord.js";
import type { CategoryChannel, Guild } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findOpenByHost: vi.fn(),
		countOpenInGuild: vi.fn(),
		create: vi.fn(),
		setStatus: vi.fn(),
	},
}));

vi.mock("@db/stores/botLogStore.js", () => ({
	botLogStore: { log: vi.fn() },
}));

import { RoomProvisioner, _clearInflightOpens, describeRoomOpenFailure, type RoomOpenInput } from "./RoomProvisioner.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

const storeMock = gameRoomStore as unknown as {
	findOpenByHost: ReturnType<typeof vi.fn>;
	countOpenInGuild: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
};
const logMock = botLogStore as unknown as { log: ReturnType<typeof vi.fn> };

// A category whose children.cache exposes just the `map` the provisioner uses to
// collect taken names.
function makeCategory(childNames: string[] = []): CategoryChannel {
	return {
		id: "arcade-cat",
		children: { cache: { map: (fn: (child: { name: string }) => string) => childNames.map((name) => fn({ name })) } },
	} as unknown as CategoryChannel;
}

function makeGuild(
	createImpl?: (opts: unknown) => Promise<unknown>,
	createInviteImpl?: () => Promise<unknown>
): Guild {
	const created = {
		id: "room-channel-1",
		send: vi.fn().mockResolvedValue({ id: "opener-1", pin: vi.fn().mockResolvedValue(undefined) }),
		delete: vi.fn().mockResolvedValue(undefined),
		createInvite: vi.fn(createInviteImpl ?? (async () => ({ code: "invite-1" }))),
	};
	return {
		id: "guild-1",
		roles: { everyone: { id: "everyone" } },
		client: { user: { id: "bot-1" } },
		channels: { create: vi.fn(createImpl ?? (async () => created)) },
	} as unknown as Guild;
}

// The channel the guild's create resolved to, so a test can reach the send/invite
// mocks that live on it.
async function createdChannelOf(guild: Guild): Promise<{
	send: ReturnType<typeof vi.fn>;
	createInvite: ReturnType<typeof vi.fn>;
}> {
	const createMock = guild.channels.create as unknown as ReturnType<typeof vi.fn>;
	return (await createMock.mock.results[0].value) as never;
}

function makeInput(overrides: Partial<RoomOpenInput> = {}): RoomOpenInput {
	return {
		guild: makeGuild(),
		category: makeCategory(),
		game: "hangman",
		hostId: "host-1",
		hostDisplayName: "Qwerty",
		playerIds: ["host-1", "player-2"],
		visibility: "invite",
		adminRoleId: "admin-role",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	_clearInflightOpens();
	storeMock.findOpenByHost.mockResolvedValue(null);
	storeMock.countOpenInGuild.mockResolvedValue(0);
	storeMock.create.mockResolvedValue({ roomId: "room-1", guildId: "guild-1" });
	storeMock.setStatus.mockResolvedValue({ roomId: "room-1", guildId: "guild-1", status: "playing" });
	logMock.log.mockResolvedValue(undefined);
});

describe("RoomProvisioner.open, happy path", () => {
	it("creates the channel under the arcade category and moves the room to playing", async () => {
		const input = makeInput();
		const result = await RoomProvisioner.open(input);

		expect(result.ok).toBe(true);
		const createMock = input.guild.channels.create as unknown as ReturnType<typeof vi.fn>;
		const opts = createMock.mock.calls[0][0] as { name: string; parent: string; permissionOverwrites: unknown[] };
		expect(opts.name).toBe("hangman-qwerty");
		expect(opts.parent).toBe("arcade-cat");

		// The row's channelId is written on the SAME transition that marks it playing,
		// so a room is never "playing" with a null channel for any observable moment.
		expect(storeMock.setStatus).toHaveBeenCalledWith("guild-1", "room-1", "playing", {
			channelId: "room-channel-1",
			openerMessageId: "opener-1",
			inviteCode: "invite-1",
			startedAt: expect.any(Date),
		});
	});

	it("hands the real permission matrix to Discord rather than an empty array", async () => {
		// Cheap smoke over the seam between the pure matrix and the create call: an
		// invite room must arrive at Discord already hiding itself from @everyone.
		const input = makeInput();
		await RoomProvisioner.open(input);

		const createMock = input.guild.channels.create as unknown as ReturnType<typeof vi.fn>;
		const overwrites = (createMock.mock.calls[0][0] as { permissionOverwrites: { id: string; deny?: bigint[] }[] })
			.permissionOverwrites;
		expect(overwrites.find((entry) => entry.id === "everyone")?.deny).toContain(PermissionFlagsBits.ViewChannel);
		expect(overwrites.some((entry) => entry.id === "bot-1")).toBe(true);
	});

	it("logs the room create without letting a failed audit write break the room", async () => {
		logMock.log.mockRejectedValue(new Error("mongo down"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const result = await RoomProvisioner.open(makeInput());

		// House rule 7: a side effect after a successful primary action logs and never
		// throws back into the caller. The members can already see the channel.
		expect(result.ok).toBe(true);
		expect(logMock.log).toHaveBeenCalledOnce();
		errorSpy.mockRestore();
	});

	it("sidesteps a name already taken by the host's cooling-off room", async () => {
		const input = makeInput({ category: makeCategory(["hangman-qwerty"]) });
		await RoomProvisioner.open(input);

		const createMock = input.guild.channels.create as unknown as ReturnType<typeof vi.fn>;
		expect((createMock.mock.calls[0][0] as { name: string }).name).toBe("hangman-qwerty-2");
	});
});

describe("RoomProvisioner.open, the invite link", () => {
	it("mints an invite for a public room and persists the CODE on the row", async () => {
		const input = makeInput({ visibility: "public" });
		const result = await RoomProvisioner.open(input);

		expect(result.ok).toBe(true);
		const channel = await createdChannelOf(input.guild);
		expect(channel.createInvite).toHaveBeenCalledWith(
			expect.objectContaining({ maxAge: 0, maxUses: 0, unique: true })
		);
		// The code, not the URL: the renderer owns the URL shape.
		expect(storeMock.setStatus).toHaveBeenCalledWith(
			"guild-1",
			"room-1",
			"playing",
			expect.objectContaining({ inviteCode: "invite-1" })
		);
		// And the URL rides the opener description as an inline link.
		const opener = channel.send.mock.calls[0][0] as { embeds: { data: { description?: string } }[] };
		expect(opener.embeds[0].data.description).toContain("https://discord.gg/invite-1");
	});

	it("mints for an invite-only room too, with the hidden-from-newcomers caveat (fork a)", async () => {
		const input = makeInput({ visibility: "invite" });
		await RoomProvisioner.open(input);

		const channel = await createdChannelOf(input.guild);
		const opener = channel.send.mock.calls[0][0] as { embeds: { data: { description?: string } }[] };
		// The link is a GUILD invite and does not touch the room's overwrites, so the
		// caveat sentence is what keeps it from reading as broken.
		expect(opener.embeds[0].data.description).toContain("https://discord.gg/invite-1");
		expect(opener.embeds[0].data.description).toContain("hidden from members who were not invited");
		expect(storeMock.setStatus).toHaveBeenCalledWith(
			"guild-1",
			"room-1",
			"playing",
			expect.objectContaining({ inviteCode: "invite-1" })
		);
	});

	it("degrades to inviteCode null when the mint throws, without failing the open", async () => {
		// The 50013 shape: the bot's CreateInstantInvite bit is missing on the channel.
		const denied = Object.assign(Object.create(DiscordAPIError.prototype), { code: 50013 });
		const input = makeInput({ guild: makeGuild(undefined, async () => Promise.reject(denied)) });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const result = await RoomProvisioner.open(input);

		expect(result.ok).toBe(true);
		expect(storeMock.setStatus).toHaveBeenCalledWith(
			"guild-1",
			"room-1",
			"playing",
			expect.objectContaining({ inviteCode: null })
		);
		const channel = await createdChannelOf(input.guild);
		const opener = channel.send.mock.calls[0][0] as { embeds: { data: { description?: string } }[] };
		expect(opener.embeds[0].data.description).not.toContain("discord.gg");
		errorSpy.mockRestore();
	});
});

describe("RoomProvisioner.open, refusals", () => {
	it("refuses a host who already holds a room, with a jump link and no channel", async () => {
		storeMock.findOpenByHost.mockResolvedValue({ roomId: "old", channelId: "old-channel" });
		const input = makeInput();

		const result = await RoomProvisioner.open(input);

		expect(result).toEqual({ ok: false, reason: "alreadyHosting", existingChannelId: "old-channel" });
		expect(input.guild.channels.create).not.toHaveBeenCalled();
		expect(describeRoomOpenFailure(result as never)).toContain("<#old-channel>");
	});

	it("refuses when the guild is at its room cap, and says the number out loud", async () => {
		storeMock.countOpenInGuild.mockResolvedValue(BOT_CONSTANTS.GAME_ROOM_MAX_PER_GUILD);
		const input = makeInput();

		const result = await RoomProvisioner.open(input);

		expect(result).toEqual({ ok: false, reason: "guildFull" });
		expect(input.guild.channels.create).not.toHaveBeenCalled();
		expect(describeRoomOpenFailure(result as never)).toContain(String(BOT_CONSTANTS.GAME_ROOM_MAX_PER_GUILD));
	});

	// ⚠️ NEVER RETRY A 50013. The bot cannot grant itself the permission, so a retry
	// loop is an infinite loop with a rate limit at the end of it.
	it("refuses a 50013 without retrying the create", async () => {
		const missingPerms = Object.assign(Object.create(DiscordAPIError.prototype), { code: 50013 });
		const input = makeInput({ guild: makeGuild(async () => Promise.reject(missingPerms)) });

		const result = await RoomProvisioner.open(input);

		expect(result).toEqual({ ok: false, reason: "missingPermissions" });
		expect(input.guild.channels.create).toHaveBeenCalledOnce();
	});

	it("rolls the channel back when the row cannot be written", async () => {
		// The channel exists and the row does not, so the sweep (which only ever reads
		// rows) would never see it. An orphan channel in the arcade category is
		// permanent until an admin notices it.
		const createdChannel = {
			id: "room-channel-1",
			send: vi.fn(),
			delete: vi.fn().mockResolvedValue(undefined),
		};
		const input = makeInput({ guild: makeGuild(async () => createdChannel) });
		storeMock.create.mockRejectedValue(Object.assign(new Error("E11000"), { code: 11000 }));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const result = await RoomProvisioner.open(input);

		expect(result).toEqual({ ok: false, reason: "createFailed" });
		expect(createdChannel.delete).toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});

describe("RoomProvisioner.open, the in-flight guard", () => {
	// ⚠️ THE DOUBLE CLICK. Two interactions land milliseconds apart, well inside the
	// round trip of the cap check plus the channel create, so both would pass every
	// check and build two channels. The unique index catches the second ROW, but only
	// after its channel exists, leaving an orphan nothing sweeps.
	it("collapses a double click into ONE channel", async () => {
		const input = makeInput();

		const [first, second] = await Promise.all([RoomProvisioner.open(input), RoomProvisioner.open(input)]);

		expect(input.guild.channels.create).toHaveBeenCalledOnce();
		expect(storeMock.create).toHaveBeenCalledOnce();
		// Both clicks resolve to the same outcome, so the second reads as one slightly
		// slow click rather than as an error.
		expect(second).toBe(first);
	});

	it("releases the slot so the host can open again afterwards", async () => {
		const input = makeInput();
		await RoomProvisioner.open(input);
		await RoomProvisioner.open(makeInput());

		// A leaked entry would pin this host's next open to the previous result
		// forever: one member permanently unable to start a game, everyone else fine,
		// which is close to undiagnosable from a log.
		expect(storeMock.create).toHaveBeenCalledTimes(2);
	});

	it("releases the slot even when the open throws", async () => {
		storeMock.findOpenByHost.mockRejectedValueOnce(new Error("mongo blip"));
		await expect(RoomProvisioner.open(makeInput())).rejects.toThrow("mongo blip");

		// The finally is what makes this pass. Without it the throw would leave the
		// entry behind and every later attempt would return the rejected promise.
		storeMock.findOpenByHost.mockResolvedValue(null);
		const result = await RoomProvisioner.open(makeInput());
		expect(result.ok).toBe(true);
	});

	it("keys the guard per host, so two hosts are not serialized behind each other", async () => {
		const hostA = makeInput({ hostId: "host-a" });
		const hostB = makeInput({ hostId: "host-b" });

		await Promise.all([RoomProvisioner.open(hostA), RoomProvisioner.open(hostB)]);

		expect(storeMock.create).toHaveBeenCalledTimes(2);
	});
});
