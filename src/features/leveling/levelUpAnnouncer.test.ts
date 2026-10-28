import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, PermissionFlagsBits, TextChannel } from "discord.js";
import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── levelUpAnnouncer ───────────────────────────────────────────────────────
// The owner's locked decision D3 is that NO leveling message ever pings, and the
// first describe block below is the enforcement of it. Everything else here
// pins the behaviour that makes shipping this on by default survivable: the
// claim that makes a double announcement impossible, the two tiers of
// celebration, and a permission failure that logs instead of throwing.

const mocks = vi.hoisted(() => ({
	getLevelingConfig: vi.fn(),
	claimAnnouncement: vi.fn(),
	botLogHas: vi.fn(),
	botLogLog: vi.fn(),
	renderLevelUpCard: vi.fn(),
	renderAchievementUnlockCard: vi.fn(),
	renderRoleUnlockCard: vi.fn(),
}));

vi.mock("./levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));
vi.mock("@db/stores/memberLevelStore.js", () => ({
	memberLevelStore: { claimAnnouncement: mocks.claimAnnouncement },
}));
vi.mock("@db/stores/botLogStore.js", () => ({
	botLogStore: { has: mocks.botLogHas, log: mocks.botLogLog },
}));
// Both card renderers answer null by default, so every case above the "rendered
// cards" describe pins the EMBED path, the fallback members get whenever a card
// cannot be drawn. That describe swaps cards in.
vi.mock("./levelUpRenderer.js", () => ({ LEVEL_UP_AVATAR_SIZE: 128, renderLevelUpCard: mocks.renderLevelUpCard }));
vi.mock("./roleUnlockRenderer.js", () => ({ ROLE_UNLOCK_AVATAR_SIZE: 256, renderRoleUnlockCard: mocks.renderRoleUnlockCard }));
vi.mock("./achievementUnlockRenderer.js", () => ({
	ACHIEVEMENT_UNLOCK_AVATAR_SIZE: 128,
	renderAchievementUnlockCard: mocks.renderAchievementUnlockCard,
}));

import {
	_clearAdminNoticeGuard,
	_clearAnnouncerQueues,
	_drainAnnouncerNow,
	_queuedChannels,
	announceAchievements,
	announceRoleUnlock,
	applyTemplate,
	handleLevelCrossing,
} from "./levelUpAnnouncer.js";

const CHANNEL_ID = "c-announcements";

interface Harness {
	client: Client;
	send: ReturnType<typeof vi.fn>;
	react: ReturnType<typeof vi.fn>;
}

function harness(options: { missingPermission?: bigint } = {}): Harness {
	const react = vi.fn(async () => undefined);
	const send = vi.fn(async () => ({ react }));

	// Object.create against the real prototype so the module's `instanceof
	// TextChannel` guard passes. Same technique TestReminderJob's suite uses.
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(channel, {
		id: CHANNEL_ID,
		guildId: "g1",
		send,
		guild: {
			id: "g1",
			name: "The Kingdom",
			// The two reward roles the role unlock cases draw: one with a color, and
			// one with none, which Discord reports as 0 and "#000000".
			roles: {
				cache: new Map([
					["role-knight", { name: "Knight", color: 0xe11d48, hexColor: "#e11d48" }],
					["role-plain", { name: "Plain", color: 0, hexColor: "#000000" }],
				]),
			},
			members: {
				me: { id: "bot" },
				cache: new Map([
					[
						"u1",
						{
							displayName: "Silent",
							user: { id: "u1", avatar: "a1", displayAvatarURL: () => "https://cdn.discordapp.com/avatars/1/a1.png?size=128" },
						},
					],
				]),
			},
		},
		permissionsFor: () => ({
			has: (flag: bigint) => flag !== options.missingPermission,
		}),
	});

	const client = { channels: { fetch: async () => channel } } as unknown as Client;
	return { client, send, react };
}

const context = (overrides: Record<string, unknown> = {}) => ({
	settings: {
		enabled: true,
		curve: "dero",
		curveMultiplier: 1,
		maxLevel: null,
		milestoneMode: "prime",
		milestoneEveryN: 5,
		announceMode: "announcements",
		announceChannelId: CHANNEL_ID,
		reactionEmoji: "🎉",
		...overrides,
	},
	announcementsChannelId: CHANNEL_ID,
	adminChannelId: null,
	homebaseDestroyed: false,
	copyOverrides: null,
	weekStart: "sunday",
});

// dero curve boundaries: level 2 at 151, level 3 at 358, level 4 at 630.
// 3 is prime (a milestone), 4 is not.
const TO_LEVEL_2 = 151;
const TO_LEVEL_3 = 358;
const TO_LEVEL_4 = 630;

const cross = async (client: Client, from: number, to: number, userId = "u1") =>
	handleLevelCrossing({ client, guildId: "g1", userId, username: "Silent", oldTotalXp: from, newTotalXp: to });

const payloads = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map((call) => call[0] as Record<string, unknown>);

beforeEach(() => {
	_clearAnnouncerQueues();
	_clearAdminNoticeGuard();
	mocks.getLevelingConfig.mockReset().mockResolvedValue(context());
	mocks.claimAnnouncement.mockReset().mockResolvedValue(true);
	mocks.botLogHas.mockReset().mockResolvedValue(true);
	mocks.botLogLog.mockReset().mockResolvedValue(undefined);
	mocks.renderLevelUpCard.mockReset().mockResolvedValue(null);
	mocks.renderAchievementUnlockCard.mockReset().mockResolvedValue(null);
	mocks.renderRoleUnlockCard.mockReset().mockResolvedValue(null);
});

describe("⚠️ THE NEVER PING INVARIANT", () => {
	it("pins allowedMentions to parse [] on an ordinary level up", async () => {
		const { client, send } = harness();
		await cross(client, TO_LEVEL_3, TO_LEVEL_4); // level 3 -> 4, not prime
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(payloads(send)[0].allowedMentions).toEqual({ parse: [], roles: [], users: [] });
	});

	it("pins allowedMentions on a milestone card", async () => {
		const { client, send } = harness();
		await cross(client, TO_LEVEL_2, TO_LEVEL_3); // level 2 -> 3, prime
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(payloads(send)[0].allowedMentions).toEqual({ parse: [], roles: [], users: [] });
	});

	it("pins allowedMentions on the combined burst message", async () => {
		const { client, send } = harness();
		for (const userId of ["u1", "u2", "u3", "u4"]) await cross(client, TO_LEVEL_3, TO_LEVEL_4, userId);
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(payloads(send)[0].allowedMentions).toEqual({ parse: [], roles: [], users: [] });
	});

	it("pins allowedMentions on EVERY send, whatever the shape", async () => {
		// The catch-all. A future branch that forgets it fails here rather than in
		// production at a thousand notifications.
		const { client, send } = harness();
		await cross(client, TO_LEVEL_2, TO_LEVEL_3, "u1"); // milestone card
		await cross(client, TO_LEVEL_3, TO_LEVEL_4, "u2"); // compact line
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(send).toHaveBeenCalledTimes(2);
		for (const payload of payloads(send)) {
			expect(payload.allowedMentions).toEqual({ parse: [], roles: [], users: [] });
		}
	});

	it("keeps the leveling kind OUT of the PINGABLE allow list", async () => {
		expect(BOT_CONSTANTS.PINGABLE.has("leveling.levelUp")).toBe(false);
	});

	it("fails loudly if somebody adds leveling to PINGABLE", async () => {
		// The structural half of the rule: adding a ping now means adding a NAMED
		// kind to a named list, which somebody can review, rather than deleting one
		// allowedMentions line, which nobody notices.
		BOT_CONSTANTS.PINGABLE.add("leveling.levelUp");
		try {
			const { client, send } = harness();
			await cross(client, TO_LEVEL_3, TO_LEVEL_4);
			await _drainAnnouncerNow(CHANNEL_ID);
			expect(send).not.toHaveBeenCalled();
		} finally {
			BOT_CONSTANTS.PINGABLE.delete("leveling.levelUp");
		}
	});
});

describe("the two tiers of celebration", () => {
	it("posts an ordinary level as a card embed with Dero's still, not a plain text line", async () => {
		const { client, send } = harness();
		await cross(client, TO_LEVEL_3, TO_LEVEL_4);
		await _drainAnnouncerNow(CHANNEL_ID);

		const payload = payloads(send)[0] as unknown as { content?: string; embeds: Array<{ data: { description?: string } }>; files: unknown[] };
		expect(payload.content).toBeUndefined();
		expect(payload.embeds[0].data.description).toContain("**level 4**");
		expect(payload.files).toHaveLength(1);
	});

	it("renders a PRIME level as a full card with art and a reaction", async () => {
		const { client, send, react } = harness();
		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		await _drainAnnouncerNow(CHANNEL_ID);

		const payload = payloads(send)[0];
		expect(payload.embeds).toBeDefined();
		expect(payload.files).toBeDefined();
		expect(react).toHaveBeenCalledWith("🎉");
	});

	it("puts the reaction on the BOT'S OWN post", async () => {
		// A level up can come from a voice sweep, where there is no message of the
		// member's to react to, so anchoring to the bot's own post is the only
		// version that always works.
		const { client, send, react } = harness();
		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(react).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("does not react on an ordinary level", async () => {
		const { client, react } = harness();
		await cross(client, TO_LEVEL_3, TO_LEVEL_4);
		await _drainAnnouncerNow(CHANNEL_ID);
		expect(react).not.toHaveBeenCalled();
	});

	it("survives a reaction the bot cannot use", async () => {
		// A guild can configure a custom emoji from a server the bot is not in. That
		// must not turn a successful celebration into a failed announcement.
		const { client, send, react } = harness();
		react.mockRejectedValue(new Error("Unknown Emoji"));

		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		await expect(_drainAnnouncerNow(CHANNEL_ID)).resolves.toBeUndefined();
		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe("coalescing and the burst threshold", () => {
	it("absorbs later level ups into the FIRST window rather than resetting the timer", async () => {
		const { client } = harness();
		await cross(client, TO_LEVEL_3, TO_LEVEL_4, "u1");
		await cross(client, TO_LEVEL_3, TO_LEVEL_4, "u2");

		expect(_queuedChannels()).toEqual([CHANNEL_ID]);
	});

	it("posts two or three ordinary level ups in one window as separate cards", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { client, send } = harness();
		for (const userId of ["u1", "u2", "u3"]) await cross(client, TO_LEVEL_3, TO_LEVEL_4, userId);
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(send).toHaveBeenCalledTimes(3);
		for (const payload of payloads(send)) expect(payload.allowedMentions).toEqual({ parse: [], roles: [], users: [] });
	});

	it("still coalesces four ordinary level ups, the threshold being a burst of MORE than three", async () => {
		const { client, send } = harness();
		for (const userId of ["u1", "u2", "u3", "u4"]) await cross(client, TO_LEVEL_3, TO_LEVEL_4, userId);
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(send).toHaveBeenCalledTimes(1);
	});

	it("collapses a burst above the threshold into ONE combined message", async () => {
		// Solves both the "trains your community to mute the channel" complaint and
		// Discord's per channel 429 risk with one mechanism.
		const { client, send } = harness();
		for (const userId of ["u1", "u2", "u3", "u4", "u5"]) await cross(client, TO_LEVEL_3, TO_LEVEL_4, userId);
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(send).toHaveBeenCalledTimes(1);
		expect(payloads(send)[0].embeds).toBeDefined();
	});

	it("gives each milestone its own card below the threshold", async () => {
		const { client, send } = harness();
		await cross(client, TO_LEVEL_2, TO_LEVEL_3, "u1");
		await cross(client, TO_LEVEL_2, TO_LEVEL_3, "u2");
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(send).toHaveBeenCalledTimes(2);
	});
});

describe("the announcement claim", () => {
	it("sends nothing when another path already claimed this level", async () => {
		// modifiedCount 0 means a concurrent flush announced it first. This is what
		// makes a double announcement impossible.
		mocks.claimAnnouncement.mockResolvedValue(false);
		const { client, send } = harness();

		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		await _drainAnnouncerNow(CHANNEL_ID);
		expect(send).not.toHaveBeenCalled();
	});

	it("does not claim, or send, when no level was crossed", async () => {
		const { client, send } = harness();
		await cross(client, 100, 140); // still level 1
		expect(mocks.claimAnnouncement).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("claims the HIGHER level when two are crossed at once", async () => {
		const { client, send } = harness();
		await cross(client, 0, TO_LEVEL_4); // level 1 straight to 4
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(mocks.claimAnnouncement).toHaveBeenCalledWith("g1", "u1", 4);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("does NOT claim a level the guild does not want announced", async () => {
		// The claim is a high water mark, so claiming a level under announceMode
		// "off" would silently consume it: if the admin later turned announcements
		// on, that level could never be announced again.
		mocks.getLevelingConfig.mockResolvedValue(context({ announceMode: "off" }));
		const { client, send } = harness();

		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		expect(mocks.claimAnnouncement).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("under milestone mode announces a prime level and skips an ordinary one", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ announceMode: "milestone" }));
		const { client, send } = harness();

		await cross(client, TO_LEVEL_3, TO_LEVEL_4, "u1"); // 4, not prime
		expect(mocks.claimAnnouncement).not.toHaveBeenCalled();

		await cross(client, TO_LEVEL_2, TO_LEVEL_3, "u2"); // 3, prime
		await _drainAnnouncerNow(CHANNEL_ID);
		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe("permissions and other silent failures", () => {
	it("logs a warning and does NOT throw when a permission is missing", async () => {
		// Otherwise the failure is completely invisible to an admin: the feature is
		// on, the bot is in the channel, and nothing ever appears.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { client, send } = harness({ missingPermission: PermissionFlagsBits.EmbedLinks });

		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		await expect(_drainAnnouncerNow(CHANNEL_ID)).resolves.toBeUndefined();

		expect(send).not.toHaveBeenCalled();
		expect(warn.mock.calls.flat().join(" ")).toContain("EmbedLinks");
		warn.mockRestore();
	});

	it("needs AddReactions, because the congratulations reaction is part of the payload", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { client, send } = harness({ missingPermission: PermissionFlagsBits.AddReactions });

		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(send).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("stays silent when leveling is disabled", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ enabled: false }));
		const { client, send } = harness();
		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		expect(send).not.toHaveBeenCalled();
	});

	it("stays silent in a self destructed guild", async () => {
		mocks.getLevelingConfig.mockResolvedValue({ ...context(), homebaseDestroyed: true });
		const { client, send } = harness();
		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		expect(send).not.toHaveBeenCalled();
	});

	it("never throws when the store rejects", async () => {
		mocks.claimAnnouncement.mockRejectedValue(new Error("mongo is down"));
		const { client } = harness();
		await expect(cross(client, TO_LEVEL_2, TO_LEVEL_3)).resolves.toBeUndefined();
	});
});

describe("the one time admin notice", () => {
	it("posts to the admin channel on the first level up and logs it once", async () => {
		mocks.botLogHas.mockResolvedValue(false);
		mocks.getLevelingConfig.mockResolvedValue({ ...context(), adminChannelId: CHANNEL_ID });
		const { client, send } = harness();

		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		// Give the fire and forget notice a turn of the event loop to land.
		await new Promise((resolve) => setImmediate(resolve));

		expect(mocks.botLogLog).toHaveBeenCalledTimes(1);
		expect(String(payloads(send)[0].content)).toContain("/leveling settings");
	});

	it("does not post again once the guild has been told", async () => {
		mocks.botLogHas.mockResolvedValue(true);
		mocks.getLevelingConfig.mockResolvedValue({ ...context(), adminChannelId: CHANNEL_ID });
		const { client } = harness();

		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		await new Promise((resolve) => setImmediate(resolve));

		expect(mocks.botLogLog).not.toHaveBeenCalled();
	});

	it("reads the log once per guild per process, not once per level up", async () => {
		mocks.botLogHas.mockResolvedValue(true);
		mocks.getLevelingConfig.mockResolvedValue({ ...context(), adminChannelId: CHANNEL_ID });
		const { client } = harness();

		await cross(client, TO_LEVEL_2, TO_LEVEL_3, "u1");
		await cross(client, TO_LEVEL_3, TO_LEVEL_4, "u2");
		await new Promise((resolve) => setImmediate(resolve));

		expect(mocks.botLogHas).toHaveBeenCalledTimes(1);
	});
});

describe("applyTemplate", () => {
	const event = { userId: "u1", level: 13, xpIntoLevel: 42, earnedRoleId: null };
	const templateContext = { displayName: "Silent", guildName: "The Kingdom" };

	it("renders every documented tag", () => {
		const rendered = applyTemplate(
			"{user.mention} {user.name} reached {user.level} with {user.xp} in {guild.name}",
			event,
			templateContext
		);
		expect(rendered).toBe("<@u1> Silent reached 13 with 42 in The Kingdom");
	});

	it("falls back to a mention when the member is not cached", () => {
		const rendered = applyTemplate("{user.name}", event, { ...templateContext, displayName: null });
		expect(rendered).toBe("<@u1>");
	});

	it("DROPS the earned block entirely when no role was granted", () => {
		// A template that mentions a reward must still read correctly for a member
		// who did not get one.
		const rendered = applyTemplate("Level {user.level}{earned: and earned {role.mention}}", event, templateContext);
		expect(rendered).toBe("Level 13");
	});

	it("renders the earned block when a role WAS granted", () => {
		const rendered = applyTemplate(
			"Level {user.level}{earned: and earned {role.mention}}",
			{ ...event, earnedRoleId: "role-9" },
			templateContext
		);
		expect(rendered).toBe("Level 13 and earned <@&role-9>");
	});

	it("appends the role when the template never mentions it", () => {
		// A reward must never be silent just because the default copy predates it.
		const rendered = applyTemplate("Level {user.level}", { ...event, earnedRoleId: "role-9" }, templateContext);
		expect(rendered).toContain("<@&role-9>");
	});

	it("leaves an UNKNOWN tag verbatim rather than deleting it", () => {
		// A typo in an owner's override should read as a typo, not silently remove a
		// word and leave them wondering what happened.
		expect(applyTemplate("hello {user.rank}", event, templateContext)).toBe("hello {user.rank}");
	});
});

describe("the rendered cards and their fallbacks (2026-10 item 243 Phase 2)", () => {
	type CardPayload = { embeds: Array<{ data: { image?: { url: string }; description?: string } }>; files?: AttachmentBuilder[]; allowedMentions: unknown };
	const card = (name: string) => {
		const attachment = new AttachmentBuilder(Buffer.from("img"), { name });
		return { attachment, ref: `attachment://${name}` };
	};
	const UNLOCKS = [{ id: "chatterbox", tier: "bronze", earnedBy: "sent 53 messages" }];

	it("posts the milestone EMBED with Dero's bundled still when the level up renderer answers null", async () => {
		const { client, send } = harness();
		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		await _drainAnnouncerNow(CHANNEL_ID);

		const payload = payloads(send)[0] as unknown as CardPayload;
		expect(payload.files?.[0]?.name).toBe("dero-avatar-512.png");
		expect(payload.embeds[0].data.image?.url).toBe("attachment://dero-avatar-512.png");
	});

	it("posts the milestone card in the embed's image slot, keeping the congratulations and the never ping pin", async () => {
		const rendered = card("level-up-abc.gif");
		mocks.renderLevelUpCard.mockResolvedValue(rendered);
		const { client, send, react } = harness();

		await cross(client, TO_LEVEL_2, TO_LEVEL_3);
		await _drainAnnouncerNow(CHANNEL_ID);

		const payload = payloads(send)[0] as unknown as CardPayload;
		expect(payload.files).toEqual([rendered.attachment]);
		expect(payload.embeds[0].data.image?.url).toBe(rendered.ref);
		expect(payload.embeds[0].data.description).toContain("level 3");
		expect(payload.allowedMentions).toEqual({ parse: [], roles: [], users: [] });
		expect(react).toHaveBeenCalledWith("🎉");
		expect(mocks.renderLevelUpCard).toHaveBeenCalledWith(
			expect.objectContaining({ level: 3, milestone: true, displayName: "Silent", avatar: expect.objectContaining({ userId: "u1", size: 128 }) })
		);
	});

	it("renders the card for an ordinary level, with the ordinary treatment, no reaction and no ping", async () => {
		const rendered = card("level-up-def.png");
		mocks.renderLevelUpCard.mockResolvedValue(rendered);
		const { client, send, react } = harness();

		await cross(client, TO_LEVEL_3, TO_LEVEL_4);
		await _drainAnnouncerNow(CHANNEL_ID);

		expect(mocks.renderLevelUpCard).toHaveBeenCalledWith(expect.objectContaining({ level: 4, milestone: false, displayName: "Silent" }));
		const payload = payloads(send)[0] as unknown as CardPayload;
		expect(payload.files).toEqual([rendered.attachment]);
		expect(payload.embeds[0].data.image?.url).toBe(rendered.ref);
		expect(payload.allowedMentions).toEqual({ parse: [], roles: [], users: [] });
		expect(react).not.toHaveBeenCalled();
	});

	it("posts the unlock EMBED, with no files, when the unlock renderer answers null", async () => {
		const { client, send } = harness();

		await announceAchievements(client, "g1", "u1", UNLOCKS, "Silent");

		const payload = payloads(send)[0] as unknown as CardPayload;
		expect(payload.files).toBeUndefined();
		expect(payload.embeds[0].data.description).toContain("chatterbox");
		expect(payload.embeds[0].data.image).toBeUndefined();
	});

	it("posts the unlock medallion card, the mention line staying in text", async () => {
		const rendered = card("achievement-unlock-abc.png");
		mocks.renderAchievementUnlockCard.mockResolvedValue(rendered);
		const { client, send } = harness();

		await announceAchievements(client, "g1", "u1", UNLOCKS, "Silent");

		const payload = payloads(send)[0] as unknown as CardPayload;
		expect(payload.files).toEqual([rendered.attachment]);
		expect(payload.embeds[0].data.image?.url).toBe(rendered.ref);
		expect(payload.embeds[0].data.description).toContain("<@u1>");
		expect(payload.allowedMentions).toEqual({ parse: [], roles: [], users: [] });
	});

	it("draws the stored username when the member cannot be fetched", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { client } = harness();

		// u2 is not in the harness cache and the harness guild cannot fetch.
		await announceAchievements(client, "g1", "u2", UNLOCKS, "Gone Member");

		expect(mocks.renderAchievementUnlockCard).toHaveBeenCalledWith(expect.objectContaining({ userId: "u2", displayName: "Gone Member", avatar: null }));
	});
});

// ── the role unlock card (2026-10 item 243 Phase 4) ────────────────────────
describe("announceRoleUnlock", () => {
	type UnlockPayload = { embeds: Array<{ data: { image?: { url: string }; description?: string } }>; files?: AttachmentBuilder[]; allowedMentions: unknown };

	it("posts the role unlock EMBED, with no files and no pings, when the card answers null", async () => {
		const { client, send } = harness();

		await announceRoleUnlock(client, "g1", "u1", "role-knight", 10);

		const payload = payloads(send)[0] as unknown as UnlockPayload;
		expect(payload.files).toBeUndefined();
		expect(payload.embeds[0].data.image).toBeUndefined();
		expect(payload.embeds[0].data.description).toContain("<@&role-knight>");
		expect(payload.allowedMentions).toEqual({ parse: [], roles: [], users: [] });
	});

	it("posts the card with the role's name, color and level when it draws", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("img"), { name: "role-unlock-abc.png" });
		mocks.renderRoleUnlockCard.mockResolvedValue({ attachment, ref: "attachment://role-unlock-abc.png" });
		const { client, send } = harness();

		await announceRoleUnlock(client, "g1", "u1", "role-knight", 10);

		expect(mocks.renderRoleUnlockCard).toHaveBeenCalledWith(
			expect.objectContaining({ roleName: "Knight", roleColor: "#e11d48", level: 10, displayName: "Silent", avatar: expect.objectContaining({ userId: "u1", size: 256 }) })
		);
		const payload = payloads(send)[0] as unknown as UnlockPayload;
		expect(payload.files).toEqual([attachment]);
		expect(payload.embeds[0].data.image?.url).toBe("attachment://role-unlock-abc.png");
	});

	it("rings a colorless role in the milestone violet rather than black", async () => {
		const { client } = harness();
		await announceRoleUnlock(client, "g1", "u1", "role-plain", 5);
		expect(mocks.renderRoleUnlockCard).toHaveBeenCalledWith(expect.objectContaining({ roleColor: "#a855f7" }));
	});

	it("stays quiet when the guild switched announcements off", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ announceMode: "off" }));
		const { client, send } = harness();
		await announceRoleUnlock(client, "g1", "u1", "role-knight", 10);
		expect(send).not.toHaveBeenCalled();
	});
});
