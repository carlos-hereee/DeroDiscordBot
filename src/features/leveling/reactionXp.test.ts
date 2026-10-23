import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, MessageReaction, User } from "discord.js";

// ── reactionXp ─────────────────────────────────────────────────────────────
// The SECOND MessageReactionAdd listener in this codebase. Two things are worth
// pinning hardest: that it cannot be farmed (self reactions, emoji piling), and
// that it stays entirely out of ActivityTracker's way.

const mocks = vi.hoisted(() => ({ awardXp: vi.fn(), getLevelingConfig: vi.fn() }));

vi.mock("./awardXp.js", () => ({ awardXp: mocks.awardXp }));
vi.mock("./levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));

import { handleReaction, registerReactionXp } from "./reactionXp.js";
import { _clearXpWriter } from "./xpWriter.js";

const client = {} as Client;

interface Options {
	reactorId?: string;
	authorId?: string | null;
	authorIsBot?: boolean;
	messageId?: string;
	channelId?: string;
	guildId?: string | null;
	partial?: boolean;
}

let seq = 0;

function build(options: Options = {}): { reaction: MessageReaction; user: User } {
	const reactorId = options.reactorId ?? `reactor-${seq++}`;
	const authorId = options.authorId === undefined ? `author-${seq++}` : options.authorId;

	const reaction = {
		partial: options.partial ?? false,
		fetch: async () => reaction,
		client,
		message: {
			id: options.messageId ?? `m-${seq++}`,
			guildId: options.guildId === undefined ? "g1" : options.guildId,
			channelId: options.channelId ?? "c-general",
			channel: { parentId: null },
			author: authorId ? { id: authorId, bot: options.authorIsBot ?? false } : null,
			guild: { members: { cache: new Map() } },
		},
	} as unknown as MessageReaction;

	return { reaction, user: { id: reactorId, bot: false } as unknown as User };
}

const settings = (overrides: Record<string, unknown> = {}) => ({
	enabled: true,
	restrictionMode: "exclude",
	restrictedChannels: [],
	restrictedRoles: [],
	roleMultipliers: [],
	channelMultipliers: [],
	stackMultipliers: false,
	...overrides,
	// Merged LAST and field by field, so a case overriding one reaction setting
	// does not silently drop the other two.
	reaction: {
		enabled: true,
		cooldownSeconds: 300,
		awards: "reactor",
		...((overrides.reaction as Record<string, unknown>) ?? {}),
	},
});

const context = (overrides: Record<string, unknown> = {}) => ({ settings: settings(overrides), weekStart: "sunday" });

const awardedIds = (): string[] => mocks.awardXp.mock.calls.map((call) => (call[0] as { userId: string }).userId);

beforeEach(() => {
	_clearXpWriter();
	seq = 0;
	mocks.awardXp.mockReset().mockResolvedValue(undefined);
	mocks.getLevelingConfig.mockReset().mockResolvedValue(context());
});

describe("the anti farm guards", () => {
	it("pays NOBODY for reacting to your own message", async () => {
		// The single most obvious farm in the feature, and under awards "both" it
		// would be one member paying themselves twice.
		const { reaction, user } = build({ reactorId: "same", authorId: "same" });
		await handleReaction(reaction, user);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("pays a member ONCE per message however many emoji they pile on", async () => {
		const first = build({ reactorId: "r1", authorId: "a1", messageId: "m1" });
		await handleReaction(first.reaction, first.user);

		// Same reactor, same message, a different emoji. The reaction object is
		// rebuilt because Discord sends one per emoji.
		const second = build({ reactorId: "r1", authorId: "a1", messageId: "m1" });
		await handleReaction(second.reaction, second.user);

		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
	});

	it("applies the rate window per RECIPIENT across different messages", async () => {
		const first = build({ reactorId: "r1", authorId: "a1", messageId: "m1" });
		await handleReaction(first.reaction, first.user);

		const second = build({ reactorId: "r1", authorId: "a2", messageId: "m2" });
		await handleReaction(second.reaction, second.user);

		// r1's own reaction window is still burning, so the second reaction pays
		// nothing even though it is a different message.
		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
	});

	it("ignores a bot reactor", async () => {
		const { reaction } = build();
		await handleReaction(reaction, { id: "bot", bot: true } as unknown as User);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("ignores a reaction outside a guild", async () => {
		const { reaction, user } = build({ guildId: null });
		await handleReaction(reaction, user);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("respects a restricted channel, so an excluded channel cannot become a reaction farm", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ restrictedChannels: ["c-bots"] }));
		const { reaction, user } = build({ channelId: "c-bots" });
		await handleReaction(reaction, user);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});
});

describe("the awards modes", () => {
	it("reactor pays only the member who reacted", async () => {
		const { reaction, user } = build({ reactorId: "r1", authorId: "a1" });
		await handleReaction(reaction, user);
		expect(awardedIds()).toEqual(["r1"]);
	});

	it("author pays only the member who was reacted to", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ reaction: { awards: "author" } }));
		const { reaction, user } = build({ reactorId: "r1", authorId: "a1" });
		await handleReaction(reaction, user);
		expect(awardedIds()).toEqual(["a1"]);
	});

	it("both pays each of them once", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ reaction: { awards: "both" } }));
		const { reaction, user } = build({ reactorId: "r1", authorId: "a1" });
		await handleReaction(reaction, user);
		expect(awardedIds().sort()).toEqual(["a1", "r1"]);
	});

	it("counts reactionsGiven for the REACTOR only", async () => {
		// Being reacted to is not the same act as reacting, and the-applause
		// achievement counts the giving.
		mocks.getLevelingConfig.mockResolvedValue(context({ reaction: { awards: "both" } }));
		const { reaction, user } = build({ reactorId: "r1", authorId: "a1" });
		await handleReaction(reaction, user);

		const calls = mocks.awardXp.mock.calls.map((call) => call[0] as { userId: string; counters: Record<string, number> });
		expect(calls.find((call) => call.userId === "r1")?.counters).toEqual({ reactionsGiven: 1 });
		expect(calls.find((call) => call.userId === "a1")?.counters).toEqual({});
	});

	it("still pays the reactor when the author is a bot under both", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ reaction: { awards: "both" } }));
		const { reaction, user } = build({ reactorId: "r1", authorId: "botty", authorIsBot: true });
		await handleReaction(reaction, user);
		expect(awardedIds()).toEqual(["r1"]);
	});

	it("pays nobody under author when the author is a bot", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ reaction: { awards: "author" } }));
		const { reaction, user } = build({ reactorId: "r1", authorId: "botty", authorIsBot: true });
		await handleReaction(reaction, user);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});
});

describe("partials", () => {
	it("fetches a partial before reading its properties, the way ActivityTracker does", async () => {
		const { reaction, user } = build({ partial: true });
		const fetchSpy = vi.spyOn(reaction, "fetch");
		await handleReaction(reaction, user);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
	});
});

describe("removal never claws xp back", () => {
	it("registers MessageReactionAdd and nothing else", async () => {
		// There is deliberately no MessageReactionRemove listener anywhere in this
		// feature. Reversing an award on removal becomes its own farm loop (react,
		// unreact, react) and punishes the ordinary case of fixing a misclick.
		const events: string[] = [];
		registerReactionXp({ on: (event: string) => events.push(event) } as unknown as Client);

		expect(events).toEqual(["messageReactionAdd"]);
		expect(events).not.toContain("messageReactionRemove");
	});
});

describe("the enabled gates", () => {
	it("writes nothing when leveling is off", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ enabled: false }));
		const { reaction, user } = build();
		await handleReaction(reaction, user);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("writes nothing when reaction xp specifically is off", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ reaction: { enabled: false } }));
		const { reaction, user } = build();
		await handleReaction(reaction, user);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});
});
