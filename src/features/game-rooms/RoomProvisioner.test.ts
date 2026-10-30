import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordAPIError, PermissionFlagsBits } from "discord.js";
import type { CategoryChannel, Guild } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findOpenByHost: vi.fn(),
		countOpenInGuild: vi.fn(),
		countOpenInGuildByVisibility: vi.fn(),
		create: vi.fn(),
		claimForPlay: vi.fn(),
		update: vi.fn(),
		findByRoomId: vi.fn(),
	},
}));

vi.mock("@db/stores/botLogStore.js", () => ({
	botLogStore: { log: vi.fn() },
}));

// The tier decision, defaulted to "not enforcing" (infinite quota) so every test that
// is not about the quota costs nothing, exactly like production today.
vi.mock("@features/entitlements/gameRoomAccess.js", () => ({
	checkGameRoomAccess: vi.fn(),
}));
// The server's challenge reach (2026-10 item 244 Phase 4), read on a public open. No
// config reads as "server", today's behavior, so only the reach cases set one.
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));

import { RoomProvisioner, _clearInflightOpens, describeRoomOpenFailure, openerPingIds, type RoomOpenInput } from "./RoomProvisioner.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { checkGameRoomAccess } from "@features/entitlements/gameRoomAccess.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { HANGMAN_WORD_BANK } from "@features/games/hangmanWords.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

const storeMock = gameRoomStore as unknown as {
	findOpenByHost: ReturnType<typeof vi.fn>;
	countOpenInGuild: ReturnType<typeof vi.fn>;
	countOpenInGuildByVisibility: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	claimForPlay: ReturnType<typeof vi.fn>;
	findByRoomId: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
};
const logMock = botLogStore as unknown as { log: ReturnType<typeof vi.fn> };
const accessMock = checkGameRoomAccess as unknown as ReturnType<typeof vi.fn>;

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
		send: vi.fn().mockResolvedValue({ id: "opener-1", pin: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) }),
		delete: vi.fn().mockResolvedValue(undefined),
		createInvite: vi.fn(createInviteImpl ?? (async () => ({ code: "invite-1" }))),
	};
	return {
		id: "guild-1",
		roles: { everyone: { id: "everyone" } },
		// channels.fetch backs roomTrail's channel resolution on the solo-hangman seed
		// path; null keeps the trail post a no-op in these unit tests.
		client: { user: { id: "bot-1" }, channels: { fetch: vi.fn().mockResolvedValue(null) } },
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
	storeMock.countOpenInGuildByVisibility.mockResolvedValue(0);
	storeMock.create.mockResolvedValue({ roomId: "room-1", guildId: "guild-1" });
	// The start claim answers the row BEFORE it (a draft), and the re-read the row after it.
	storeMock.claimForPlay.mockResolvedValue({ roomId: "room-1", guildId: "guild-1", hostId: "host-1", status: "draft", buyInPaidBy: [] });
	storeMock.findByRoomId.mockResolvedValue({ roomId: "room-1", guildId: "guild-1", status: "playing" });
	logMock.log.mockResolvedValue(undefined);
	// Production default: not enforcing, infinite quota, zero cost.
	accessMock.mockResolvedValue({ allowed: true, privateQuota: Number.POSITIVE_INFINITY });
});

// 2026-10 item 276, audit P1-2: the move to playing is a claim on a row still waiting to start.
// A draft Call it off (or the idle sweep, or the leave watcher) closed while the room was being
// built must not come back to life as a playing room with its joiners seated.
describe("RoomProvisioner.open, a draft that closed while its room was built", () => {
	it("opens nothing, and takes back the channel and the opener it already made", async () => {
		storeMock.claimForPlay.mockResolvedValue(null);
		const input = makeInput({ existingRoomId: "room-1" });
		storeMock.findByRoomId.mockResolvedValue({ roomId: "room-1", guildId: "guild-1", status: "draft" });

		const result = await RoomProvisioner.open(input);

		expect(result).toEqual({ ok: false, reason: "calledOff" });
		const created = (await (input.guild.channels.create as unknown as ReturnType<typeof vi.fn>).mock.results[0].value) as { delete: ReturnType<typeof vi.fn> };
		expect(created.delete).toHaveBeenCalled();
		const opener = (await (await createdChannelOf(input.guild)).send.mock.results[0].value) as { delete: ReturnType<typeof vi.fn> };
		expect(opener.delete).toHaveBeenCalled();
		expect(storeMock.update).not.toHaveBeenCalled();
		expect(describeRoomOpenFailure({ ok: false, reason: "calledOff" })).toBe(gameRoomsCopy.board.draftGone);
	});
});

describe("RoomProvisioner.open, happy path", () => {
	it("creates the channel under the arcade category and moves the room to playing", async () => {
		const input = makeInput();
		const result = await RoomProvisioner.open(input);

		expect(result.ok).toBe(true);
		const createMock = input.guild.channels.create as unknown as ReturnType<typeof vi.fn>;
		const opts = createMock.mock.calls[0][0] as { name: string; parent: string; permissionOverwrites: unknown[] };
		expect(opts.name).toBe("🪢hangman-qwerty");
		expect(opts.parent).toBe("arcade-cat");

		// The row's channelId is written on the SAME transition that marks it playing,
		// so a room is never "playing" with a null channel for any observable moment.
		// An invite only room takes no invite link (2026-10 item 254, Arcade 10).
		expect(storeMock.claimForPlay).toHaveBeenCalledWith("guild-1", "room-1", {
			channelId: "room-channel-1",
			openerMessageId: "opener-1",
			inviteCode: null,
			startedAt: expect.any(Date),
		}, undefined);
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
		const input = makeInput({ category: makeCategory(["🪢hangman-qwerty"]) });
		await RoomProvisioner.open(input);

		const createMock = input.guild.channels.create as unknown as ReturnType<typeof vi.fn>;
		expect((createMock.mock.calls[0][0] as { name: string }).name).toBe("🪢hangman-qwerty-2");
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
		expect(storeMock.claimForPlay).toHaveBeenCalledWith(
			"guild-1",
			"room-1",
			expect.objectContaining({ inviteCode: "invite-1" }), undefined
		);
		// And the URL rides the opener description as an inline link.
		const opener = channel.send.mock.calls[0][0] as { embeds: { data: { description?: string } }[] };
		expect(opener.embeds[0].data.description).toContain("https://discord.gg/invite-1");
	});

	// 2026-10 item 254, Arcade 10: a link into a channel the newcomer cannot see is a lie,
	// so only a public room everyone may watch mints one. Each case below mints nothing.
	it.each([
		["an invite only room", { visibility: "invite" as const }],
		["an invite only room the host opened to spectators", { visibility: "invite" as const, spectatorMode: "open" as const }],
		["a public room with Invite only spectators", { visibility: "public" as const, spectatorMode: "invite" as const }],
		["a public room with no spectators", { visibility: "public" as const, spectatorMode: "none" as const }],
	])("mints no invite for %s, and the opener shows no link", async (_label, overrides) => {
		const input = makeInput(overrides);
		await RoomProvisioner.open(input);

		const channel = await createdChannelOf(input.guild);
		expect(channel.createInvite).not.toHaveBeenCalled();
		const opener = channel.send.mock.calls[0][0] as { embeds: { data: { description?: string } }[] };
		expect(opener.embeds[0].data.description).not.toContain("discord.gg");
		expect(storeMock.claimForPlay).toHaveBeenCalledWith("guild-1", "room-1", expect.objectContaining({ inviteCode: null }), undefined);
	});

	it("mints for a public room open to spectators by the host's explicit choice", async () => {
		const input = makeInput({ visibility: "public", spectatorMode: "open" });
		await RoomProvisioner.open(input);

		const channel = await createdChannelOf(input.guild);
		expect(channel.createInvite).toHaveBeenCalledTimes(1);
		const opener = channel.send.mock.calls[0][0] as { embeds: { data: { description?: string } }[] };
		// The opener says the link stops working when the match ends, which is when finish deletes it.
		expect(opener.embeds[0].data.description).toContain("until the match ends: https://discord.gg/invite-1");
	});

	it("degrades to inviteCode null when the mint throws, without failing the open", async () => {
		// The 50013 shape: the bot's CreateInstantInvite bit is missing on the channel.
		const denied = Object.assign(Object.create(DiscordAPIError.prototype), { code: 50013 });
		const input = makeInput({ visibility: "public", guild: makeGuild(undefined, async () => Promise.reject(denied)) });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const result = await RoomProvisioner.open(input);

		expect(result.ok).toBe(true);
		expect(storeMock.claimForPlay).toHaveBeenCalledWith(
			"guild-1",
			"room-1",
			expect.objectContaining({ inviteCode: null }), undefined
		);
		const channel = await createdChannelOf(input.guild);
		const opener = channel.send.mock.calls[0][0] as { embeds: { data: { description?: string } }[] };
		expect(opener.embeds[0].data.description).not.toContain("discord.gg");
		errorSpy.mockRestore();
	});
});

describe("RoomProvisioner.open, solo rooms", () => {
	it("seats exactly the host, drops passed spectators, and persists visibility solo", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const input = makeInput({
			game: "solo-hangman",
			visibility: "solo",
			playerIds: ["host-1", "stowaway-1"],
			spectatorIds: ["watcher-1", "watcher-2"],
		});
		const result = await RoomProvisioner.open(input);

		expect(result.ok).toBe(true);
		// One seat, no watchers, whatever the caller passed: solo is structural, not
		// a convention the call sites have to remember.
		expect(storeMock.create).toHaveBeenCalledWith(
			expect.objectContaining({ visibility: "solo", playerIds: ["host-1"], spectatorIds: [] })
		);

		// And the permission matrix Discord receives carries no per-member spectator
		// entry: @everyone (denied), the bot, and the host. Nothing else.
		const createMock = input.guild.channels.create as unknown as ReturnType<typeof vi.fn>;
		const overwrites = (createMock.mock.calls[0][0] as { permissionOverwrites: { id: string; deny?: bigint[] }[] })
			.permissionOverwrites;
		expect(overwrites.map((entry) => entry.id).sort()).toEqual(["admin-role", "bot-1", "everyone", "host-1"]);
		expect(overwrites.find((entry) => entry.id === "everyone")?.deny).toContain(PermissionFlagsBits.ViewChannel);
		warnSpy.mockRestore();
	});

	it("seeds solo-hangman with a bank word (no author) and mints no invite link", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const input = makeInput({ game: "solo-hangman", visibility: "solo", playerIds: [] });
		await RoomProvisioner.open(input);

		// The bank seed: a real word, authoredBy null so the host may guess it, and the
		// hint the bank carries beside it (the 1.7.0 test fixes, item 12).
		const seed = storeMock.update.mock.calls.find(
			(call) => (call[2] as { secret?: { word?: string } })?.secret?.word
		)?.[2] as { secret: { word: string; authoredBy: string | null; hint: string } };
		expect(seed.secret.word).toMatch(/^[a-z]+$/);
		expect(seed.secret.authoredBy).toBeNull();
		expect(seed.secret.hint.length).toBeGreaterThan(0);

		// No invite for a room only one member can ever see.
		const channel = await createdChannelOf(input.guild);
		expect(channel.createInvite).not.toHaveBeenCalled();
		expect(storeMock.claimForPlay).toHaveBeenCalledWith(
			"guild-1",
			"room-1",
			expect.objectContaining({ inviteCode: null }), undefined
		);
		warnSpy.mockRestore();
	});

	it("seeds solo-hangman from the shelf the 🕹️games category start picked", async () => {
		// 2026-10 item 245 Phase 4a: the category start threads its shelf through open.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await RoomProvisioner.open(makeInput({ game: "solo-hangman", visibility: "solo", playerIds: [], hangmanCategory: "space" }));

		const seed = storeMock.update.mock.calls.find(
			(call) => (call[2] as { secret?: { word?: string } })?.secret?.word
		)?.[2] as { secret: { word: string; hint: string } };
		expect(HANGMAN_WORD_BANK.space).toContainEqual({ word: seed.secret.word, hint: seed.secret.hint });
		warnSpy.mockRestore();
	});

	it("opens a hosted hangman room on the author button AND the category select", async () => {
		const input = makeInput();
		await RoomProvisioner.open(input);

		const channel = await createdChannelOf(input.guild);
		const opener = channel.send.mock.calls[0][0] as { components: { toJSON(): { components: { custom_id: string }[] } }[] };
		expect(opener.components.map((row) => row.toJSON().components[0].custom_id)).toEqual([
			"gameroom:author:room-1",
			"gameroomSelect:hcategory:room-1",
		]);
	});

	it("gives solo-blackjack a bare opener: its board message is not the opener's job", async () => {
		const input = makeInput({ game: "solo-blackjack", visibility: "solo", playerIds: [] });
		await RoomProvisioner.open(input);

		const channel = await createdChannelOf(input.guild);
		const opener = channel.send.mock.calls[0][0] as { components?: unknown[] };
		// SELF_BOARDED_GAMES: the table board is posted by startBlackjackTable after
		// the open, so the opener carries no controls at all.
		expect(opener.components).toBeUndefined();
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

describe("RoomProvisioner.open, the private tier quota (②ᵇ)", () => {
	beforeEach(() => {
		accessMock.mockResolvedValue({ allowed: true, privateQuota: 10, tierKey: "free" });
	});

	it("refuses a private room at the ceiling, naming the number and the plan", async () => {
		storeMock.countOpenInGuildByVisibility.mockResolvedValue(10);
		const input = makeInput({ visibility: "invite" });

		const result = await RoomProvisioner.open(input);

		expect(result).toEqual({ ok: false, reason: "privateQuotaHit", quota: 10, tier: "free" });
		expect(input.guild.channels.create).not.toHaveBeenCalled();
		const copy = describeRoomOpenFailure(result as never);
		expect(copy).toContain("(10)");
		expect(copy).toContain("Starter");
		// The count asked for exactly the private visibilities, never public.
		expect(storeMock.countOpenInGuildByVisibility).toHaveBeenCalledWith("guild-1", ["invite", "solo"]);
	});

	it("counts solo rooms against the same ceiling", async () => {
		storeMock.countOpenInGuildByVisibility.mockResolvedValue(10);
		const result = await RoomProvisioner.open(makeInput({ game: "solo-hangman", visibility: "solo", playerIds: [] }));
		expect(result).toEqual({ ok: false, reason: "privateQuotaHit", quota: 10, tier: "free" });
	});

	it("never gates a PUBLIC room on the private quota, and never even counts", async () => {
		storeMock.countOpenInGuildByVisibility.mockResolvedValue(999);
		const result = await RoomProvisioner.open(makeInput({ visibility: "public" }));
		expect(result.ok).toBe(true);
		expect(storeMock.countOpenInGuildByVisibility).not.toHaveBeenCalled();
	});

	it("skips the count entirely while the quota is infinite (enforcement off)", async () => {
		accessMock.mockResolvedValue({ allowed: true, privateQuota: Number.POSITIVE_INFINITY });
		const result = await RoomProvisioner.open(makeInput({ visibility: "invite" }));
		expect(result.ok).toBe(true);
		expect(storeMock.countOpenInGuildByVisibility).not.toHaveBeenCalled();
	});

	it("lets a draft AT the ceiling promote itself: it is already one of the counted rooms", async () => {
		// The adopted draft carries its own visibility row, so the count of 10
		// includes it; refusing here would refuse the very room being started.
		storeMock.countOpenInGuildByVisibility.mockResolvedValue(10);
		storeMock.findByRoomId.mockResolvedValue({ roomId: "draft-1", guildId: "guild-1" });
		const result = await RoomProvisioner.open(makeInput({ visibility: "invite", existingRoomId: "draft-1" }));
		expect(result.ok).toBe(true);
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

describe("RoomProvisioner.open, the server's challenge reach (2026-10 item 244 Phase 4)", () => {
	const configMock = guildConfigStore.findByGuildId as unknown as ReturnType<typeof vi.fn>;

	it("refuses a public room in an invite only server before any channel exists, with words to show", async () => {
		configMock.mockResolvedValue({ challengeReach: "invite-only" });
		const input = makeInput({ visibility: "public" });

		const result = await RoomProvisioner.open(input);

		expect(result).toEqual({ ok: false, reason: "outsideReach" });
		expect(input.guild.channels.create).not.toHaveBeenCalled();
		expect(describeRoomOpenFailure(result as never)).toBe(rokCommanderCopy.arcadeHostControls.reach.publicRefused);
	});

	it("still opens an invite room there, and a public room at Server and Network reach", async () => {
		configMock.mockResolvedValue({ challengeReach: "invite-only" });
		expect((await RoomProvisioner.open(makeInput({ visibility: "invite" }))).ok).toBe(true);
		for (const challengeReach of ["server", "network"]) {
			_clearInflightOpens();
			configMock.mockResolvedValue({ challengeReach });
			expect((await RoomProvisioner.open(makeInput({ visibility: "public" }))).ok).toBe(true);
		}
	});
});

// ── the opener's ping (2026-10 item 263 R3-24) ────────────────────────
// The line pointing at a room left 💬dero-commands, so the room's own opener is where its
// players are pinged: in its content (an embed mention never notifies), naming only them.
describe("RoomProvisioner.open, the opener's ping", () => {
	type OpenerPayload = { content?: string; allowedMentions?: { parse: string[]; users: string[] } };
	const openerOf = async (input: RoomOpenInput): Promise<OpenerPayload> => (await createdChannelOf(input.guild)).send.mock.calls[0][0] as OpenerPayload;

	it.each([
		["a hangman room", "hangman", ["host-1", "player-2"]],
		["a coin flip room", "coinflip", ["host-1", "player-2"]],
		["a solo coin flip room", "solo-coinflip", ["host-1"]],
	] as const)("pings every member player of %s once, in the opener's content", async (_label, game, playerIds) => {
		const input = makeInput({ game, playerIds: [...playerIds], visibility: "public", spectatorIds: ["watcher-9"] } as Partial<RoomOpenInput>);
		await RoomProvisioner.open(input);

		const opener = await openerOf(input);
		expect(opener.content).toBe(gameRoomsCopy.opener.playersCall([...playerIds]));
		expect(opener.allowedMentions).toEqual({ parse: [], users: [...playerIds] });
		expect(opener.allowedMentions!.users).not.toContain("watcher-9");
	});

	it("never names or pings a Dero bot seat, even one handed in as a player", async () => {
		const input = makeInput({ playerIds: ["host-1", "dero-bot-rook"] });
		await RoomProvisioner.open(input);

		const opener = await openerOf(input);
		expect(opener.content).not.toContain("dero-bot-rook");
		expect(opener.allowedMentions!.users).toEqual(["host-1"]);
	});
});

describe("openerPingIds", () => {
	it("leaves out the member the first turn line pings, and nobody else", () => {
		expect(openerPingIds("monopoly", "host-1", ["host-1", "player-2", "player-3"])).toEqual(["player-2", "player-3"]);
		expect(openerPingIds("solo-rps", "host-1", ["host-1"])).toEqual([]);
		expect(openerPingIds("blackjack", "host-1", ["host-1", "player-2"])).toEqual(["player-2"]);
		expect(openerPingIds("hangman", "host-1", ["host-1", "player-2"])).toEqual(["host-1", "player-2"]);
		expect(openerPingIds("holdem", "host-1", ["host-1", "player-2"])).toEqual(["host-1", "player-2"]);
	});
});
