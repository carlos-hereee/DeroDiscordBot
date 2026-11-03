import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, VoiceChannel, type Guild } from "discord.js";

// ── onDemandChannel ─────────────────────────────────────────────────────────
// The one path that builds a notice board channel after install (2026-11 item 285
// Phase 3). GuildSetupManager is faked at its four entry points, so these tests pin what
// this module decides: when to build, what it builds with, what it writes, and that two
// callers at once get one channel. repairOneChannel's own adoption of the server's
// welcome and rules channels is covered by GuildSetupManager.welcomeRules.test.ts.

// Hoisted with the mocks, because the GuildSetupManager fake below reads it.
const { NOTICE_BOARD_FIELDS } = vi.hoisted(() => ({
	NOTICE_BOARD_FIELDS: [
		"introChannelId",
		"commandsChannelId",
		"leaderboardChannelId",
		"scheduleChannelId",
		"announcementsChannelId",
		"nextDecreeChannelId",
		"welcomeChannelId",
		"rulesChannelId",
		"meetingVoiceChannelId",
		"commandOutputChannelId",
	],
}));

const mocks = vi.hoisted(() => ({
	row: null as Record<string, unknown> | null,
	findByGuildId: vi.fn(),
	claimEmptySlot: vi.fn(),
	pullFromLists: vi.fn(),
	findExistingManagedCategory: vi.fn(),
	createManagedCategory: vi.fn(),
	repairOneChannel: vi.fn(),
	adminLogEmit: vi.fn(),
	refreshHeadquartersCards: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: { findByGuildId: mocks.findByGuildId, claimEmptySlot: mocks.claimEmptySlot, pullFromLists: mocks.pullFromLists },
}));
vi.mock("./GuildSetupManager.js", () => ({
	GuildSetupManager: {
		CHANNEL_SPECS: NOTICE_BOARD_FIELDS.map((configField) => ({ configField, categoryField: "categoryId", kind: configField === "meetingVoiceChannelId" ? "voice" : "public" })),
		specFieldsUnder: (categoryField: string) => (categoryField === "categoryId" ? [...NOTICE_BOARD_FIELDS] : []),
		findExistingManagedCategory: mocks.findExistingManagedCategory,
		createManagedCategory: mocks.createManagedCategory,
		repairOneChannel: mocks.repairOneChannel,
	},
}));
vi.mock("./adminLog.js", () => ({ adminLog: { emit: mocks.adminLogEmit } }));
vi.mock("./headquartersCards.js", () => ({ refreshHeadquartersCards: mocks.refreshHeadquartersCards }));

import { ensureOnDemandChannel, isOnDemandField } from "./onDemandChannel.js";

const GUILD_ID = "g1";
const CATEGORY_ID = "cat-notice";

function textChannel(id: string, parentId: string | null = CATEGORY_ID): TextChannel {
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	Object.defineProperty(channel, "id", { value: id });
	Object.defineProperty(channel, "name", { value: `channel-${id}` });
	Object.defineProperty(channel, "parentId", { value: parentId });
	return channel;
}

function voiceChannel(id: string): VoiceChannel {
	const channel = Object.create(VoiceChannel.prototype) as VoiceChannel;
	Object.defineProperty(channel, "id", { value: id });
	Object.defineProperty(channel, "name", { value: "meeting-hall" });
	Object.defineProperty(channel, "parentId", { value: CATEGORY_ID });
	return channel;
}

// A guild whose channels.fetch answers from `live`, a map of the channels Discord holds.
function guildWith(live: Map<string, unknown>): Guild {
	return {
		id: GUILD_ID,
		ownerId: "owner",
		client: {},
		channels: { fetch: vi.fn(async (id: string) => live.get(id) ?? null) },
	} as unknown as Guild;
}

const category = { id: CATEGORY_ID, delete: vi.fn(async () => undefined) };

// A Headquarters only row, as Phase 2 stores it.
const headquartersOnlyRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	guildId: GUILD_ID,
	categoryId: null,
	headquartersCategoryId: "cat-hq",
	adminRoleId: "role-admin",
	userRemovedChannels: [],
	onDemandChannels: [],
	...Object.fromEntries(NOTICE_BOARD_FIELDS.map((field) => [field, null])),
	...overrides,
});

let live: Map<string, unknown>;
let builtCount: number;

beforeEach(() => {
	live = new Map();
	builtCount = 0;
	category.delete.mockClear();
	mocks.row = headquartersOnlyRow();
	mocks.findByGuildId.mockReset().mockImplementation(async () => (mocks.row ? { ...mocks.row } : null));
	// The conditional write: it lands only while the field is still null, like the store's.
	mocks.claimEmptySlot.mockReset().mockImplementation(async (_guildId: string, field: string, value: string, extra: Record<string, unknown>) => {
		if (!mocks.row || mocks.row[field]) return null;
		mocks.row = { ...mocks.row, ...extra, [field]: value };
		return { ...mocks.row };
	});
	mocks.pullFromLists.mockReset().mockImplementation(async (_guildId: string, lists: string[], value: string) => {
		for (const list of lists) mocks.row![list] = ((mocks.row![list] as string[] | undefined) ?? []).filter((entry) => entry !== value);
	});
	mocks.findExistingManagedCategory.mockReset().mockImplementation(async (_guild: Guild, _field: string, storedId: string | null) => (storedId === CATEGORY_ID ? category : null));
	mocks.createManagedCategory.mockReset().mockImplementation(async () => category);
	// repairOneChannel builds the channel and stores its id, as the real one does.
	mocks.repairOneChannel.mockReset().mockImplementation(async (_guild: Guild, _parent: unknown, spec: { configField: string; kind: string }, stored: Record<string, unknown>) => {
		builtCount += 1;
		const id = `built-${spec.configField}-${builtCount}`;
		const channel = spec.kind === "voice" ? voiceChannel(id) : textChannel(id);
		live.set(id, channel);
		mocks.row = { ...mocks.row, [spec.configField]: id };
		return { newChannel: channel, stored: { ...stored, [spec.configField]: id } };
	});
	mocks.adminLogEmit.mockReset();
	mocks.refreshHeadquartersCards.mockReset();
});

describe("the allowlist", () => {
	it("is every notice board field and nothing else", () => {
		for (const field of NOTICE_BOARD_FIELDS) expect(isOnDemandField(field)).toBe(true);
		expect(isOnDemandField("adminChannelId")).toBe(false);
		expect(isOnDemandField("arcadeGamesChannelId")).toBe(false);
	});

	it("throws for a field outside the notice board, before reading anything", async () => {
		await expect(ensureOnDemandChannel(guildWith(live), "adminChannelId")).rejects.toThrow(/not a notice board channel/);
		expect(mocks.findByGuildId).not.toHaveBeenCalled();
	});
});

describe("the first call on a Headquarters only server", () => {
	it("builds the notice board category, then the channel inside it", async () => {
		const channel = await ensureOnDemandChannel(guildWith(live), "leaderboardChannelId");

		expect(mocks.createManagedCategory).toHaveBeenCalledWith(expect.anything(), "categoryId", "owner", "role-admin", expect.anything());
		expect(mocks.repairOneChannel).toHaveBeenCalledTimes(1);
		expect(mocks.repairOneChannel.mock.calls[0]![1]).toBe(category);
		expect(mocks.repairOneChannel.mock.calls[0]![2]).toMatchObject({ configField: "leaderboardChannelId" });
		expect(channel?.id).toBe("built-leaderboardChannelId-1");
		expect(mocks.row!.leaderboardChannelId).toBe("built-leaderboardChannelId-1");
	});

	it("stores the category conditionally and lists every other empty slot as waiting", async () => {
		await ensureOnDemandChannel(guildWith(live), "leaderboardChannelId");

		const [, field, value, extra] = mocks.claimEmptySlot.mock.calls[0]!;
		expect(field).toBe("categoryId");
		expect(value).toBe(CATEGORY_ID);
		expect((extra as { onDemandChannels: string[] }).onDemandChannels).toEqual(NOTICE_BOARD_FIELDS.filter((entry) => entry !== "leaderboardChannelId"));
	});

	it("takes the built slot off the waiting and removed lists, logs one line and redraws the tutorial", async () => {
		await ensureOnDemandChannel(guildWith(live), "leaderboardChannelId");

		expect(mocks.pullFromLists).toHaveBeenCalledWith(GUILD_ID, ["onDemandChannels", "userRemovedChannels"], "leaderboardChannelId");
		expect(mocks.adminLogEmit).toHaveBeenCalledTimes(1);
		expect(mocks.adminLogEmit.mock.calls[0]![0]).toMatchObject({ kind: "config.change", actor: { source: "dero" } });
		expect(mocks.refreshHeadquartersCards).toHaveBeenCalledWith(expect.anything(), "onboarding");
	});

	it("names the admin who asked in the log line", async () => {
		await ensureOnDemandChannel(guildWith(live), "introChannelId", { explicitRequest: true, actorUserId: "u-admin" });
		expect(mocks.adminLogEmit.mock.calls[0]![0]).toMatchObject({ actor: { userId: "u-admin" } });
	});

	it("reuses a category already carrying the notice board's name instead of building one", async () => {
		mocks.findExistingManagedCategory.mockImplementation(async () => category);
		await ensureOnDemandChannel(guildWith(live), "introChannelId");
		expect(mocks.createManagedCategory).not.toHaveBeenCalled();
		expect(mocks.claimEmptySlot).toHaveBeenCalledWith(GUILD_ID, "categoryId", CATEGORY_ID, expect.anything());
	});
});

describe("a second call", () => {
	it("returns the existing channel with no build and no write", async () => {
		const guild = guildWith(live);
		const first = await ensureOnDemandChannel(guild, "leaderboardChannelId");
		mocks.claimEmptySlot.mockClear();
		mocks.pullFromLists.mockClear();

		const second = await ensureOnDemandChannel(guild, "leaderboardChannelId");

		expect(second).toBe(first);
		expect(mocks.repairOneChannel).toHaveBeenCalledTimes(1);
		expect(mocks.claimEmptySlot).not.toHaveBeenCalled();
		expect(mocks.pullFromLists).not.toHaveBeenCalled();
	});

	it("builds a second slot under the stored category without building another", async () => {
		const guild = guildWith(live);
		await ensureOnDemandChannel(guild, "leaderboardChannelId");
		await ensureOnDemandChannel(guild, "nextDecreeChannelId");

		expect(mocks.createManagedCategory).toHaveBeenCalledTimes(1);
		expect(mocks.claimEmptySlot).toHaveBeenCalledTimes(1);
		expect(mocks.repairOneChannel.mock.calls[1]![1]).toBe(category);
	});
});

describe("concurrent calls", () => {
	it("for the same slot resolve to the same channel, built once", async () => {
		const guild = guildWith(live);
		const [first, second, third] = await Promise.all([
			ensureOnDemandChannel(guild, "commandOutputChannelId"),
			ensureOnDemandChannel(guild, "commandOutputChannelId"),
			ensureOnDemandChannel(guild, "commandOutputChannelId"),
		]);

		expect(first?.id).toBe("built-commandOutputChannelId-1");
		expect(second?.id).toBe(first?.id);
		expect(third?.id).toBe(first?.id);
		expect(mocks.repairOneChannel).toHaveBeenCalledTimes(1);
		expect(mocks.createManagedCategory).toHaveBeenCalledTimes(1);
	});

	it("keeps the first stored category when another process wins the claim, and removes its own", async () => {
		const otherCategory = { id: "cat-other", delete: vi.fn() };
		// Another process stores its category between this call's read and its write.
		mocks.claimEmptySlot.mockImplementationOnce(async () => {
			mocks.row = { ...mocks.row, categoryId: "cat-other" };
			return null;
		});
		mocks.findExistingManagedCategory.mockImplementation(async (_guild: Guild, _field: string, storedId: string | null) => (storedId === "cat-other" ? otherCategory : null));

		await ensureOnDemandChannel(guildWith(live), "introChannelId");

		expect(category.delete).toHaveBeenCalledTimes(1);
		expect(mocks.repairOneChannel.mock.calls[0]![1]).toBe(otherCategory);
	});
});

describe("adoption runs before a fresh build", () => {
	// The adoption scan lives in repairOneChannel (adoptExistingChannel through
	// adoption.scanAndClaim), so ensure must hand it the notice board and the stored row
	// for exactly the slots that adopt, and must not log a build it did not make.
	it.each(["welcomeChannelId", "rulesChannelId", "introChannelId"])("hands %s to repairOneChannel with the notice board and the row", async (field) => {
		await ensureOnDemandChannel(guildWith(live), field);
		const [, parent, spec, stored] = mocks.repairOneChannel.mock.calls[0]!;
		expect(parent).toBe(category);
		expect(spec).toMatchObject({ configField: field });
		expect(stored).toMatchObject({ categoryId: CATEGORY_ID, guildId: GUILD_ID });
	});

	it("writes no build line for the server's own channel adopted where it stands", async () => {
		mocks.repairOneChannel.mockImplementationOnce(async (_guild: Guild, _parent: unknown, spec: { configField: string }, stored: Record<string, unknown>) => {
			const adopted = textChannel("server-rules", "cat-elsewhere");
			live.set(adopted.id, adopted);
			mocks.row = { ...mocks.row, [spec.configField]: adopted.id };
			return { newChannel: adopted, stored: { ...stored, [spec.configField]: adopted.id } };
		});

		const channel = await ensureOnDemandChannel(guildWith(live), "rulesChannelId");

		expect(channel?.id).toBe("server-rules");
		expect(mocks.adminLogEmit).not.toHaveBeenCalled();
	});
});

describe("what it refuses", () => {
	it("a slot an admin removed, when a feature asks", async () => {
		mocks.row = headquartersOnlyRow({ categoryId: CATEGORY_ID, userRemovedChannels: ["leaderboardChannelId"] });
		await expect(ensureOnDemandChannel(guildWith(live), "leaderboardChannelId")).resolves.toBeNull();
		expect(mocks.repairOneChannel).not.toHaveBeenCalled();
	});

	it("but builds it when an admin asks by name, and takes it off the removed list", async () => {
		mocks.row = headquartersOnlyRow({ categoryId: CATEGORY_ID, userRemovedChannels: ["leaderboardChannelId"] });
		const channel = await ensureOnDemandChannel(guildWith(live), "leaderboardChannelId", { explicitRequest: true });
		expect(channel).not.toBeNull();
		expect(mocks.row!.userRemovedChannels).toEqual([]);
	});

	it("a deleted channel on a server with auto heal off", async () => {
		mocks.row = headquartersOnlyRow({ categoryId: CATEGORY_ID, leaderboardChannelId: "gone", autoHealEnabled: false });
		await expect(ensureOnDemandChannel(guildWith(live), "leaderboardChannelId")).resolves.toBeNull();
		expect(mocks.repairOneChannel).not.toHaveBeenCalled();
	});

	it("a server with no row, or a self destructed one", async () => {
		mocks.row = null;
		await expect(ensureOnDemandChannel(guildWith(live), "introChannelId")).resolves.toBeNull();
		mocks.row = headquartersOnlyRow({ homebaseDestroyed: true });
		await expect(ensureOnDemandChannel(guildWith(live), "introChannelId")).resolves.toBeNull();
		expect(mocks.createManagedCategory).not.toHaveBeenCalled();
	});

	it("a stored notice board that is gone, which the boot sweep rebuilds whole", async () => {
		mocks.row = headquartersOnlyRow({ categoryId: "cat-deleted" });
		await expect(ensureOnDemandChannel(guildWith(live), "introChannelId")).resolves.toBeNull();
		expect(mocks.createManagedCategory).not.toHaveBeenCalled();
	});

	it("a category Discord refused to build", async () => {
		mocks.createManagedCategory.mockResolvedValue(null);
		await expect(ensureOnDemandChannel(guildWith(live), "introChannelId")).resolves.toBeNull();
		expect(mocks.claimEmptySlot).not.toHaveBeenCalled();
	});
});

describe("on a legacy server", () => {
	it("returns the live stored channel and creates nothing", async () => {
		const existing = textChannel("legacy-leaderboard");
		live.set(existing.id, existing);
		mocks.row = headquartersOnlyRow({ categoryId: CATEGORY_ID, leaderboardChannelId: existing.id });

		await expect(ensureOnDemandChannel(guildWith(live), "leaderboardChannelId")).resolves.toBe(existing);
		expect(mocks.findExistingManagedCategory).not.toHaveBeenCalled();
		expect(mocks.createManagedCategory).not.toHaveBeenCalled();
		expect(mocks.repairOneChannel).not.toHaveBeenCalled();
	});
});
