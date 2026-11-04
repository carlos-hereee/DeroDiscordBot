import { describe, it, expect, vi, beforeEach } from "vitest";
import { CategoryChannel, type Guild } from "discord.js";

// ── removeChannel ──────────────────────────────────────────
// The one way a card takes a notice board channel away (2026-11 item 289). The store runs in
// memory and records every write beside every delete in one list, so the order the module
// promises is pinned rather than inferred, and selfDestruct.demolishChannels is the real one.

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
	row: {} as Record<string, unknown>,
	order: [] as string[],
	updates: [] as Array<Record<string, unknown>>,
	revokeDeroVoiceRooms: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: {
		findByGuildId: async () => mocks.row,
		addToList: async (_guildId: string, list: string, value: string) => {
			mocks.order.push(`list ${list}`);
			mocks.row[list] = [...new Set([...((mocks.row[list] as string[]) ?? []), value])];
			return mocks.row;
		},
		pullFromLists: async (_guildId: string, lists: string[], value: string) => {
			for (const list of lists) {
				mocks.order.push(`unlist ${list}`);
				mocks.row[list] = ((mocks.row[list] as string[]) ?? []).filter((entry) => entry !== value);
			}
			return mocks.row;
		},
		update: async (_guildId: string, data: Record<string, unknown>) => {
			mocks.order.push("update");
			mocks.updates.push(data);
			Object.assign(mocks.row, data);
			return mocks.row;
		},
	},
}));
vi.mock("@features/voice/deroVoiceRooms.js", () => ({ revokeDeroVoiceRooms: mocks.revokeDeroVoiceRooms, DERO_VOICE_ROOM_FIELDS: [] }));
vi.mock("./GuildSetupManager.js", () => ({
	GuildSetupManager: { specFieldsUnder: (categoryField: string) => (categoryField === "categoryId" ? [...NOTICE_BOARD_FIELDS] : []) },
}));

import { removeNoticeBoardChannel } from "./removeChannel.js";

const GUILD_ID = "g1";
const CATEGORY_ID = "cat-notice";
const INTRO_STEP = "onboarding:intro";

type Deletable = { id: string; delete: ReturnType<typeof vi.fn> };

let live: Map<string, unknown>;

/** A channel Discord holds, whose delete lands in the shared order and takes it off the server. */
function channel(id: string): Deletable {
	const made: Deletable = {
		id,
		delete: vi.fn(async () => {
			mocks.order.push(`delete ${id}`);
			live.delete(id);
		}),
	};
	live.set(id, made);
	return made;
}

/** A channel Discord refuses to delete: it stays on the server, as a Community channel does. */
function refusingChannel(id: string): Deletable {
	const made: Deletable = { id, delete: vi.fn(async () => Promise.reject(new Error("Cannot delete a channel required for community servers"))) };
	live.set(id, made);
	return made;
}

function noticeBoardCategory(children: Array<{ id: string }>): CategoryChannel & { delete: ReturnType<typeof vi.fn> } {
	const category = Object.create(CategoryChannel.prototype) as CategoryChannel & { delete: ReturnType<typeof vi.fn> };
	Object.defineProperty(category, "id", { value: CATEGORY_ID });
	Object.defineProperty(category, "children", { value: { cache: new Map(children.map((child) => [child.id, child])) } });
	Object.defineProperty(category, "delete", {
		value: vi.fn(async () => {
			mocks.order.push("delete category");
		}),
	});
	live.set(CATEGORY_ID, category);
	return category;
}

const guild = (): Guild => ({ id: GUILD_ID, channels: { fetch: vi.fn(async (id: string) => live.get(id) ?? null) } }) as unknown as Guild;

beforeEach(() => {
	live = new Map();
	mocks.order = [];
	mocks.updates = [];
	mocks.revokeDeroVoiceRooms.mockReset().mockResolvedValue(undefined);
	mocks.row = {
		guildId: GUILD_ID,
		categoryId: CATEGORY_ID,
		adoptedChannelIds: [],
		userRemovedChannels: [],
		setupStepsSkipped: [],
		onDemandChannels: ["rulesChannelId"],
		...Object.fromEntries(NOTICE_BOARD_FIELDS.map((field) => [field, null])),
		// A second filled slot, so only the tidy tests reach the category.
		announcementsChannelId: "c-announcements",
	};
});

describe("Remove on a channel Dero built", () => {
	beforeEach(() => {
		mocks.row.introChannelId = "c-intro";
	});

	it("writes the opt out before the delete, so ChannelDeleteWatcher cannot rebuild it", async () => {
		channel("c-intro");

		await expect(removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP)).resolves.toBe("deleted");

		expect(mocks.order).toEqual(["list userRemovedChannels", "delete c-intro", "update", "list setupStepsSkipped"]);
		expect(mocks.row.userRemovedChannels).toEqual(["introChannelId"]);
	});

	it("names the removal in Discord's own audit log", async () => {
		const built = channel("c-intro");

		await removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP);

		expect(built.delete).toHaveBeenCalledWith("Channel removed from its Dero setup card");
	});

	it("keeps the step moved past, so the tutorial never walks backward", async () => {
		channel("c-intro");

		await removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP);

		expect(mocks.row.setupStepsSkipped).toEqual([INTRO_STEP]);
	});

	it("empties the slot and its intro in one write, and touches no other slot", async () => {
		channel("c-intro");

		await removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP);

		expect(mocks.updates).toEqual([{ introChannelId: null, "introMessageIds.introChannelId": null, adoptedChannelIds: [] }]);
		expect(mocks.row.announcementsChannelId).toBe("c-announcements");
	});

	it.each([
		["scheduleChannelId", ["scheduleMessageId"]],
		["leaderboardChannelId", ["leaderboardMessageId", "levelsMessageId"]],
		["commandsChannelId", ["introMessageIds.inviteCardId"]],
	] as const)("clears %s's board anchors in that one write", async (field, anchors) => {
		mocks.row[field] = "c-board";
		channel("c-board");

		await removeNoticeBoardChannel(guild(), field, "onboarding:board");

		expect(mocks.updates).toHaveLength(1);
		for (const anchor of anchors) expect(mocks.updates[0]).toHaveProperty([anchor], null);
	});

	it("empties a slot whose channel an admin already deleted by hand", async () => {
		await expect(removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP)).resolves.toBe("deleted");

		expect(mocks.row.introChannelId).toBeNull();
		expect(mocks.row.userRemovedChannels).toEqual(["introChannelId"]);
	});
});

describe("Remove on an adopted channel", () => {
	beforeEach(() => {
		mocks.row.welcomeChannelId = "c-theirs";
		mocks.row.adoptedChannelIds = ["c-theirs", "c-other"];
		mocks.row.adoptedChannelChoices = new Map([["c-theirs", "stay"]]);
	});

	it("never deletes it, and releases the slot", async () => {
		const theirs = channel("c-theirs");

		await expect(removeNoticeBoardChannel(guild(), "welcomeChannelId", "onboarding:welcome")).resolves.toBe("released");

		expect(theirs.delete).not.toHaveBeenCalled();
		expect(mocks.row.welcomeChannelId).toBeNull();
		expect(mocks.row.adoptedChannelIds).toEqual(["c-other"]);
		expect(mocks.row.userRemovedChannels).toEqual(["welcomeChannelId"]);
		expect(mocks.row.setupStepsSkipped).toEqual(["onboarding:welcome"]);
	});

	it("leaves the stored answer alone, so re-adopting keeps it", async () => {
		channel("c-theirs");

		await removeNoticeBoardChannel(guild(), "welcomeChannelId", "onboarding:welcome");

		expect(mocks.updates[0]).not.toHaveProperty("adoptedChannelChoices");
	});
});

describe("a refused delete", () => {
	it("rolls the opt out back and leaves the slot as it was", async () => {
		mocks.row.rulesChannelId = "c-rules";
		mocks.row.onDemandChannels = [];
		refusingChannel("c-rules");

		await expect(removeNoticeBoardChannel(guild(), "rulesChannelId", "onboarding:rules")).resolves.toBe("refused");

		expect(mocks.order).toEqual(["list userRemovedChannels", "unlist userRemovedChannels"]);
		expect(mocks.row.userRemovedChannels).toEqual([]);
		expect(mocks.row.rulesChannelId).toBe("c-rules");
		expect(mocks.row.setupStepsSkipped).toEqual([]);
	});
});

describe("the Meeting Hall", () => {
	it("comes off Dero's voice allow list with its id", async () => {
		mocks.row.meetingVoiceChannelId = "c-voice";
		channel("c-voice");

		await removeNoticeBoardChannel(guild(), "meetingVoiceChannelId", "onboarding:meetingVoice");

		expect(mocks.revokeDeroVoiceRooms).toHaveBeenCalledWith(GUILD_ID, ["c-voice"]);
	});

	it("is the only slot that touches the allow list", async () => {
		mocks.row.introChannelId = "c-intro";
		channel("c-intro");

		await removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP);

		expect(mocks.revokeDeroVoiceRooms).not.toHaveBeenCalled();
	});

	it("stays on the list when Discord refused the delete", async () => {
		mocks.row.meetingVoiceChannelId = "c-voice";
		refusingChannel("c-voice");

		await removeNoticeBoardChannel(guild(), "meetingVoiceChannelId", "onboarding:meetingVoice");

		expect(mocks.revokeDeroVoiceRooms).not.toHaveBeenCalled();
	});
});

describe("an empty slot", () => {
	it("is already gone, with no write and no delete", async () => {
		await expect(removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP)).resolves.toBe("gone");

		expect(mocks.order).toEqual([]);
	});

	it("answers a second confirmed prompt, which waited behind the first", async () => {
		mocks.row.introChannelId = "c-intro";
		const built = channel("c-intro");
		const server = guild();

		const outcomes = await Promise.all([removeNoticeBoardChannel(server, "introChannelId", INTRO_STEP), removeNoticeBoardChannel(server, "introChannelId", INTRO_STEP)]);

		expect(outcomes).toEqual(["deleted", "gone"]);
		expect(built.delete).toHaveBeenCalledTimes(1);
	});
});

describe("the category tidy", () => {
	beforeEach(() => {
		mocks.row.introChannelId = "c-intro";
		mocks.row.announcementsChannelId = null;
	});

	it("takes an emptied category with the last Remove, its two fields written first", async () => {
		const built = channel("c-intro");
		const category = noticeBoardCategory([built]);

		await removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP);

		expect(mocks.order).toEqual(["list userRemovedChannels", "delete c-intro", "update", "list setupStepsSkipped", "update", "delete category"]);
		expect(mocks.updates[1]).toEqual({ categoryId: null, onDemandChannels: [] });
		expect(category.delete).toHaveBeenCalledTimes(1);
	});

	it("keeps the category for a channel an admin filed there, and never deletes that channel", async () => {
		const built = channel("c-intro");
		const filed = channel("c-admins-own");
		const category = noticeBoardCategory([built, filed]);

		await removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP);

		expect(category.delete).not.toHaveBeenCalled();
		expect(filed.delete).not.toHaveBeenCalled();
		expect(mocks.row.categoryId).toBe(CATEGORY_ID);
	});

	it("keeps the category while any other slot holds a channel", async () => {
		mocks.row.announcementsChannelId = "c-announcements";
		const category = noticeBoardCategory([]);
		channel("c-intro");

		await removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP);

		expect(category.delete).not.toHaveBeenCalled();
		expect(mocks.row.categoryId).toBe(CATEGORY_ID);
	});

	it("keeps the category for a released adopted channel, a live child of it", async () => {
		mocks.row.adoptedChannelIds = ["c-intro"];
		const theirs = channel("c-intro");
		const category = noticeBoardCategory([theirs]);

		await expect(removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP)).resolves.toBe("released");

		expect(category.delete).not.toHaveBeenCalled();
		expect(mocks.row.categoryId).toBe(CATEGORY_ID);
	});

	it("still answers deleted when the category could not be deleted", async () => {
		const built = channel("c-intro");
		const category = noticeBoardCategory([built]);
		category.delete.mockRejectedValueOnce(new Error("Missing Permissions"));

		await expect(removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP)).resolves.toBe("deleted");
		expect(mocks.row.introChannelId).toBeNull();
	});

	it("writes nothing for a category that is already gone", async () => {
		channel("c-intro");

		await removeNoticeBoardChannel(guild(), "introChannelId", INTRO_STEP);

		expect(mocks.updates).toHaveLength(1);
		expect(mocks.row.categoryId).toBe(CATEGORY_ID);
	});
});
