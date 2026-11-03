import { describe, it, expect, vi } from "vitest";
import { TextChannel, VoiceChannel, type Guild } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import {
	acceptsDeroContent,
	fetchAcceptsDeroContent,
	findRulesChannel,
	findWelcomeChannel,
	matchesAdoptionPattern,
	moveIntoNoticeBoard,
	normalizeAdoptionName,
	readAdoptedChannelIds,
	readAdoptionChoice,
	scanAndClaim,
} from "./adoption.js";

// ── adoption (2026-10 item 247 Phase 2) ─────────────────────────────────────
// The scan decides which of a server's own channels Dero moves into the notice
// board, so a false positive moves a channel nobody asked to move (risk R2). These
// pin the exact base match, the tie break, the move's respect for the owner's own
// overwrites, and the content gate that keeps Dero's intro off the owner's text.

const WELCOME = BOT_CONSTANTS.WELCOME_ADOPTION_PATTERNS;
const RULES = BOT_CONSTANTS.RULES_ADOPTION_PATTERNS;
const NOTICE_BOARD = { id: "cat-notice" };

function textChannel(id: string, name: string, options: { parentId?: string | null; rawPosition?: number } = {}): TextChannel {
	return Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
		id,
		name,
		parentId: options.parentId ?? null,
		rawPosition: options.rawPosition ?? 0,
	});
}

function guildWith(...channels: unknown[]): Pick<Guild, "channels"> {
	return { channels: { cache: new Map(channels.map((channel, index) => [`k${index}`, channel])) } } as unknown as Pick<Guild, "channels">;
}

describe("normalizeAdoptionName and matchesAdoptionPattern", () => {
	it("strips the leading emoji and symbols and lowercases the rest", () => {
		expect(normalizeAdoptionName("👋welcome")).toBe("welcome");
		expect(normalizeAdoptionName("📘┃Rules")).toBe("rules");
		expect(normalizeAdoptionName("#-New-Members")).toBe("new-members");
	});

	it("matches every owner pattern exactly, whatever decorates the front", () => {
		for (const pattern of WELCOME) expect(matchesAdoptionPattern(`🎉${pattern}`, WELCOME), pattern).toBe(true);
		for (const pattern of RULES) expect(matchesAdoptionPattern(`📜 ${pattern.toUpperCase()}`, RULES), pattern).toBe(true);
	});

	it("refuses a name that only CONTAINS a pattern", () => {
		// Exact base, never a substring: these are Dero's own arcade card, an owner's
		// chat channel, and a pattern with a suffix, none of which is a rules channel.
		expect(matchesAdoptionPattern("📋arcade-rules", RULES)).toBe(false);
		expect(matchesAdoptionPattern("rules-chat", RULES)).toBe(false);
		expect(matchesAdoptionPattern("welcome-back", WELCOME)).toBe(false);
	});

	it("refuses a name that is all decoration", () => {
		expect(matchesAdoptionPattern("👋", WELCOME)).toBe(false);
	});
});

describe("scanAndClaim", () => {
	it("returns null when nothing matches", () => {
		expect(scanAndClaim(guildWith(textChannel("1", "general")), NOTICE_BOARD, WELCOME)).toBeNull();
	});

	it("returns the server's own channel when one matches", () => {
		const own = textChannel("2", "welcome");
		expect(scanAndClaim(guildWith(textChannel("1", "general"), own), NOTICE_BOARD, WELCOME)).toBe(own);
	});

	it("never takes a voice channel, whatever it is called", () => {
		const voice = Object.assign(Object.create(VoiceChannel.prototype) as VoiceChannel, { id: "3", name: "welcome" });
		expect(scanAndClaim(guildWith(voice), NOTICE_BOARD, WELCOME)).toBeNull();
	});

	it("passes over an id stored under another slot and a channel carrying Dero's own name", () => {
		const elsewhere = textChannel("4", "welcome");
		const derosOwn = textChannel("5", "👋welcome");
		const exclude = { ids: new Set(["4"]), names: new Set(["👋welcome"]) };
		expect(scanAndClaim(guildWith(elsewhere, derosOwn), NOTICE_BOARD, WELCOME, exclude)).toBeNull();
	});

	it("on a tie prefers a match already in the notice board, then the lowest position", () => {
		const outsideLow = textChannel("6", "welcome", { rawPosition: 0 });
		const insideHigh = textChannel("7", "joins", { parentId: NOTICE_BOARD.id, rawPosition: 9 });
		expect(scanAndClaim(guildWith(outsideLow, insideHigh), NOTICE_BOARD, WELCOME)).toBe(insideHigh);

		const second = textChannel("8", "rules", { rawPosition: 2 });
		const first = textChannel("9", "read-me", { rawPosition: 1 });
		expect(scanAndClaim(guildWith(second, first), NOTICE_BOARD, RULES)).toBe(first);
	});

	it("reads a guild with no channel cache as nothing to adopt", () => {
		expect(scanAndClaim({ channels: {} } as unknown as Pick<Guild, "channels">, NOTICE_BOARD, WELCOME)).toBeNull();
	});
});

describe("moveIntoNoticeBoard", () => {
	function movable(parentId: string | null) {
		const ownerRole = { id: "role-custom", allow: {}, deny: {} };
		const everyone = { id: "everyone", allow: {}, deny: {} };
		const channel = textChannel("10", "rules", { parentId });
		const setParent = vi.fn(async () => channel);
		const set = vi.fn(async () => channel);
		Object.assign(channel, {
			setParent,
			permissionOverwrites: { cache: new Map([["everyone", everyone], ["role-custom", ownerRole]]), set },
		});
		return { channel, setParent, set, ownerRole };
	}
	const SHAPE = [{ id: "everyone", allow: [1n], deny: [2n] }, { id: "bot-1", allow: [1n] }];

	it("leaves a channel already in the notice board exactly as it is", async () => {
		const { channel, setParent, set } = movable(NOTICE_BOARD.id);
		expect(await moveIntoNoticeBoard(channel, NOTICE_BOARD, SHAPE)).toBe(false);
		expect(setParent).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
	});

	it("moves without syncing to the category, and keeps every overwrite Dero does not manage", async () => {
		const { channel, setParent, set, ownerRole } = movable("cat-elsewhere");
		expect(await moveIntoNoticeBoard(channel, NOTICE_BOARD, SHAPE)).toBe(true);
		expect(setParent).toHaveBeenCalledWith(NOTICE_BOARD.id, expect.objectContaining({ lockPermissions: false }));
		// Dero's entries replace the @everyone one; the owner's own role stays.
		expect(set).toHaveBeenCalledWith([...SHAPE, ownerRole], expect.any(String));
	});

	// 2026-10 item 257, item 2: the parent went first, so a refused overwrite (350003 on
	// a channel Onboarding uses) left the channel half moved and setup built a second one.
	it("writes the overwrite before the parent", async () => {
		const { channel, setParent, set } = movable("cat-elsewhere");
		await moveIntoNoticeBoard(channel, NOTICE_BOARD, SHAPE);
		expect(set.mock.invocationCallOrder[0]!).toBeLessThan(setParent.mock.invocationCallOrder[0]!);
	});

	it("leaves the parent unchanged when Discord refuses the overwrite", async () => {
		const { channel, setParent, set } = movable("cat-elsewhere");
		set.mockRejectedValueOnce(Object.assign(new Error("Onboarding channels must be readable by everyone"), { code: 350003 }));
		await expect(moveIntoNoticeBoard(channel, NOTICE_BOARD, SHAPE)).rejects.toThrow();
		expect(setParent).not.toHaveBeenCalled();
		expect(channel.parentId).toBe("cat-elsewhere");
	});
});

describe("the content gate", () => {
	const SELF = "bot-1";
	const isDero = (message: { author: { id: string }; marker?: boolean }) => message.author.id === SELF && message.marker === true;

	it("accepts an empty channel", () => {
		expect(acceptsDeroContent([], isDero)).toBe(true);
	});

	it("accepts a channel that already holds Dero's own intro, even beside the owner's text", () => {
		expect(acceptsDeroContent([{ author: { id: "owner" } }, { author: { id: SELF }, marker: true }], isDero)).toBe(true);
	});

	it("refuses a channel holding only someone else's content", () => {
		expect(acceptsDeroContent([{ author: { id: "owner" } }, { author: { id: SELF } }], isDero)).toBe(false);
	});

	it("reads one fetch of the configured limit", async () => {
		const fetch = vi.fn(async () => new Map());
		expect(await fetchAcceptsDeroContent({ id: "c1", messages: { fetch } } as never, () => false)).toBe(true);
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledWith({ limit: BOT_CONSTANTS.ADOPTION_CONTENT_SCAN_LIMIT });
	});

	it("treats a channel it cannot read as the owner's, and posts nothing there", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const fetch = vi.fn(async () => {
			throw new Error("Missing Access");
		});
		expect(await fetchAcceptsDeroContent({ id: "c1", messages: { fetch } } as never, () => true)).toBe(false);
		warn.mockRestore();
	});
});

describe("readAdoptedChannelIds", () => {
	it("reads a legacy row with no field as adopting nothing", () => {
		expect(readAdoptedChannelIds({})).toEqual([]);
		expect(readAdoptedChannelIds(null)).toEqual([]);
	});

	it("reads the ids, dropping anything that is not a string", () => {
		expect(readAdoptedChannelIds({ adoptedChannelIds: ["a", 7, "b"] })).toEqual(["a", "b"]);
	});
});

describe("readAdoptionChoice", () => {
	it("reads an admin's answer from a hydrated Map or a lean object, and null when nobody chose", () => {
		expect(readAdoptionChoice({ adoptedChannelChoices: new Map([["c1", "move"]]) }, "c1")).toBe("move");
		expect(readAdoptionChoice({ adoptedChannelChoices: { c1: "stay" } }, "c1")).toBe("stay");
		expect(readAdoptionChoice({ adoptedChannelChoices: { c1: "sideways" } }, "c1")).toBeNull();
		expect(readAdoptionChoice({}, "c1")).toBeNull();
		expect(readAdoptionChoice(null, "c1")).toBeNull();
	});
});

// ── findRulesChannel (2026-10 item 257 Phase 1a) ─────────────────────────────

describe("findRulesChannel", () => {
	const byId = (rulesChannelId: string | null, ...channels: TextChannel[]) =>
		({ channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) }, rulesChannelId }) as unknown as Pick<Guild, "channels" | "rulesChannelId">;

	it("takes the server's Community rules channel before any name match, whatever it is called", () => {
		const guidelines = textChannel("guidelines", "📜guidelines");
		const rules = textChannel("rules", "rules");
		expect(findRulesChannel(byId("guidelines", guidelines, rules), NOTICE_BOARD, RULES)).toEqual({ channel: guidelines, inPlace: false });
	});

	it("scans by name when the server names no rules channel, or when that one is Dero's own", () => {
		const derosRules = textChannel("dero", "📘rules");
		const rulebook = textChannel("rulebook", "rulebook");
		expect(findRulesChannel(byId(null, rulebook), NOTICE_BOARD, RULES)).toEqual({ channel: rulebook, inPlace: false });
		expect(findRulesChannel(byId("dero", derosRules, rulebook), NOTICE_BOARD, RULES, { names: new Set(["📘rules"]) })).toEqual({ channel: rulebook, inPlace: false });
	});
});

// ── findWelcomeChannel (post-launch plan item 2) ─────────────────────────────

describe("findWelcomeChannel", () => {
	const withSystem = (systemChannelId: string | null, ...channels: TextChannel[]) =>
		({ ...guildWith(...channels), systemChannelId }) as unknown as Pick<Guild, "channels" | "systemChannelId">;
	const byId = (...channels: TextChannel[]) => ({ channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) } });

	it("takes #spawn-point by name, to be moved", () => {
		const spawn = textChannel("spawn", "🚪spawn-point");
		expect(findWelcomeChannel(withSystem(null, spawn), NOTICE_BOARD, WELCOME)).toEqual({ channel: spawn, inPlace: false });
	});

	it("takes the system channel before any name match, moved when it carries a welcome name", () => {
		const arrivals = textChannel("arrivals", "arrivals");
		const spawn = textChannel("spawn", "spawn-point");
		const guild = { ...byId(arrivals, spawn), systemChannelId: "spawn" } as unknown as Pick<Guild, "channels" | "systemChannelId">;
		expect(findWelcomeChannel(guild, NOTICE_BOARD, WELCOME)).toEqual({ channel: spawn, inPlace: false });
	});

	it("takes a system channel with any other name IN PLACE, since it is the server's main chat", () => {
		const general = textChannel("general", "general");
		const guild = { ...byId(general), systemChannelId: "general" } as unknown as Pick<Guild, "channels" | "systemChannelId">;
		expect(findWelcomeChannel(guild, NOTICE_BOARD, WELCOME)).toEqual({ channel: general, inPlace: true });
	});

	it("passes over a system channel already stored under another slot, or carrying Dero's own name, and scans by name instead", () => {
		const derosWelcome = textChannel("dero", "👋welcome");
		const spawn = textChannel("spawn", "spawn-point");
		const guild = { ...byId(derosWelcome, spawn), systemChannelId: "dero" } as unknown as Pick<Guild, "channels" | "systemChannelId">;
		expect(findWelcomeChannel(guild, NOTICE_BOARD, WELCOME, { names: new Set(["👋welcome"]) })).toEqual({ channel: spawn, inPlace: false });
		expect(findWelcomeChannel(guild, NOTICE_BOARD, WELCOME, { ids: new Set(["dero", "spawn"]) })).toBeNull();
	});

	it("never takes a system channel that is not a text channel", () => {
		const announcements = Object.assign(Object.create(VoiceChannel.prototype) as VoiceChannel, { id: "stage", name: "general" });
		const guild = { channels: { cache: new Map([["stage", announcements]]) }, systemChannelId: "stage" } as unknown as Pick<Guild, "channels" | "systemChannelId">;
		expect(findWelcomeChannel(guild, NOTICE_BOARD, WELCOME)).toBeNull();
	});
});
