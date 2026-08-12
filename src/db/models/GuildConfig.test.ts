import { describe, it, expect } from "vitest";
import GuildConfigModel from "./GuildConfig.js";

// ── GuildConfig round trip for the GAME ROOMS fields (plan risk R1) ───────
// WHY THIS FILE EXISTS, and it is not bookkeeping. Mongoose runs in strict mode, so a write to
// a field the schema does not declare is dropped IN SILENCE: no throw, no warning, and the
// read afterwards returns undefined. This repo has already shipped that bug once, and the post
// mortem is still in GuildConfig.ts: `schedulePaused` was written by two HTTP routes for weeks
// while undeclared, so pause/resume returned 200 from the dashboard and persisted nothing.
//
// The Game Rooms work adds three top level fields AND two keys inside the `introMessageIds`
// subdocument, and the subdocument keys are the nastier half: `refreshIntroEmbeds` reads an
// undefined anchor as "no intro posted yet, post one and save the id", so an undeclared key
// there does not merely fail, it reposts both intro cards on EVERY BOOT of every guild forever.
//
// What this proves without a database: strict mode drops undeclared paths at DOCUMENT
// CONSTRUCTION, not at the server, so `new Model({...})` reproduces the exact failure locally.
// The control case at the bottom is what gives the rest of the file teeth: it asserts an
// undeclared field really IS dropped, so a passing round trip above means the schema declares
// the path rather than meaning strict mode was off.

// The schema's required paths. Validation only runs on save, but filling them keeps the fixture
// honest about what a real row looks like.
const baseRow = {
	guildId: "guild-1",
	categoryId: "cat-1",
	introChannelId: "c-intro",
	commandsChannelId: "c-commands",
	leaderboardChannelId: "c-leaderboard",
	scheduleChannelId: "c-schedule",
	announcementsChannelId: "c-announcements",
	adminChannelId: "c-admin",
};

describe("GuildConfig declares the GAME ROOMS category fields", () => {
	it("round trips all three ids through a document rather than dropping them", () => {
		const doc = new GuildConfigModel({
			...baseRow,
			gamesCategoryId: "games-cat",
			gamesRulesChannelId: "c-rules",
			gamesChallengesChannelId: "c-challenges",
		});

		expect(doc.get("gamesCategoryId")).toBe("games-cat");
		expect(doc.get("gamesRulesChannelId")).toBe("c-rules");
		expect(doc.get("gamesChallengesChannelId")).toBe("c-challenges");

		// toObject() is what the store hands back to callers, so the values must survive it too.
		const plain = doc.toObject() as Record<string, unknown>;
		expect(plain.gamesCategoryId).toBe("games-cat");
		expect(plain.gamesRulesChannelId).toBe("c-rules");
		expect(plain.gamesChallengesChannelId).toBe("c-challenges");
	});

	it("defaults every new id to null so legacy rows load cleanly", () => {
		// Nullable, not required. Making gamesCategoryId required would fail validation on every
		// row already in the collection the moment this ships. Null is what the boot sweep reads
		// as "missing, build it", which is also the backfill path for guilds set up before today.
		const doc = new GuildConfigModel(baseRow);
		expect(doc.get("gamesCategoryId")).toBeNull();
		expect(doc.get("gamesRulesChannelId")).toBeNull();
		expect(doc.get("gamesChallengesChannelId")).toBeNull();
	});

	it("exposes each id as a real schema path, which is what keeps $set updates from being stripped", () => {
		// Document construction is only half the exposure. Strict mode also strips undeclared
		// paths out of an update payload, so guildConfigStore.update would silently no-op on a
		// field missing here. A declared path is the one thing that prevents both.
		for (const path of ["gamesCategoryId", "gamesRulesChannelId", "gamesChallengesChannelId"]) {
			expect(GuildConfigModel.schema.path(path), `${path} is not declared`).toBeDefined();
			expect(GuildConfigModel.schema.path(path).instance).toBe("String");
		}
	});
});

describe("GuildConfig declares the GAME ROOMS intro anchors inside introMessageIds", () => {
	it("round trips both anchor ids through the subdocument", () => {
		// The failure this guards is not a missing id, it is an infinite repost: refreshIntroEmbeds
		// treats an undefined anchor as "nothing posted yet", so a dropped write here means both
		// game rooms intro cards are re-posted on every single boot, forever, silently.
		const doc = new GuildConfigModel({
			...baseRow,
			introMessageIds: {
				gamesRulesChannelId: "msg-rules",
				gamesChallengesChannelId: "msg-challenges",
			},
		});

		expect(doc.get("introMessageIds.gamesRulesChannelId")).toBe("msg-rules");
		expect(doc.get("introMessageIds.gamesChallengesChannelId")).toBe("msg-challenges");
	});

	it("does not disturb the anchors that were already there", () => {
		// Adding keys to a subdocument is the kind of edit that quietly reshapes it. Pin one
		// pre-existing per-channel key and one pre-existing flat key so a future edit that
		// restructures introMessageIds has to notice.
		const doc = new GuildConfigModel({
			...baseRow,
			introMessageIds: {
				introChannelId: "msg-intro",
				inviteCardId: "msg-invite",
				gamesRulesChannelId: "msg-rules",
			},
		});

		expect(doc.get("introMessageIds.introChannelId")).toBe("msg-intro");
		expect(doc.get("introMessageIds.inviteCardId")).toBe("msg-invite");
		expect(doc.get("introMessageIds.gamesRulesChannelId")).toBe("msg-rules");
	});
});

describe("GuildConfig declares the LEVELING subtree", () => {
	it("declares levelsMessageId beside leaderboardMessageId without disturbing it", () => {
		// Two boards, two anchors, one channel. Sharing an anchor would make each
		// board overwrite the other's message on every refresh.
		const doc = new GuildConfigModel({ ...baseRow, levelsMessageId: "msg-levels", leaderboardMessageId: "msg-lb" });
		expect(doc.get("levelsMessageId")).toBe("msg-levels");
		expect(doc.get("leaderboardMessageId")).toBe("msg-lb");
	});

	it("defaults levelsMessageId to null so the first refresh posts fresh", () => {
		expect(new GuildConfigModel(baseRow).get("levelsMessageId")).toBeNull();
	});

	it("ships leveling ENABLED on every legacy row, with no backfill", () => {
		// Locked decision D4: leveling is on in every guild immediately, no opt in.
		// A legacy row that has never seen /setup-level-system must therefore load
		// with a complete working configuration, which is what these defaults are.
		const doc = new GuildConfigModel(baseRow);
		expect(doc.get("leveling.enabled")).toBe(true);
		expect(doc.get("leveling.curve")).toBe("dero");
		expect(doc.get("leveling.curveMultiplier")).toBe(1);
		expect(doc.get("leveling.maxLevel")).toBeNull();
		expect(doc.get("leveling.milestoneMode")).toBe("prime");
		expect(doc.get("leveling.announceMode")).toBe("announcements");
		expect(doc.get("leveling.reactionEmoji")).toBe("🎉");
	});

	it("defaults the three earn sources to the documented rates", () => {
		const doc = new GuildConfigModel(baseRow);

		expect(doc.get("leveling.message.enabled")).toBe(true);
		expect(doc.get("leveling.message.min")).toBe(15);
		expect(doc.get("leveling.message.max")).toBe(40);
		// The industry floor, and the single most effective anti farm measure here.
		expect(doc.get("leveling.message.cooldownSeconds")).toBe(60);

		expect(doc.get("leveling.reaction.awards")).toBe("reactor");
		expect(doc.get("leveling.reaction.cooldownSeconds")).toBe(300);

		expect(doc.get("leveling.voice.perMinute")).toBe(5);
		expect(doc.get("leveling.voice.minMembers")).toBe(2);
		expect(doc.get("leveling.voice.decayAfterMinutes")).toBe(120);
		expect(doc.get("leveling.voice.decayFactor")).toBe(0.25);
	});

	it("defaults approvedChannels to EMPTY, which means nobody earns voice xp", () => {
		// ⚠️ The opposite polarity from every other list in the subtree, and the
		// one a later reader is most likely to invert. Voice xp is opt in PER
		// CHANNEL by construction, so a guild that never configures it never has a
		// voice farming surface. If this ever defaults to "all channels", a 24/7
		// voice self bot earns from day one in every guild on the platform.
		const doc = new GuildConfigModel(baseRow);
		expect(doc.get("leveling.voice.approvedChannels")).toEqual([]);
	});

	it("defaults restrictions to excluding NOTHING, so nothing silently earns zero", () => {
		// One mode plus one list. The failure this shape makes unrepresentable is
		// Arcane's largest support item: a sibling whitelist where adding a single
		// channel silently kills xp in every other channel.
		const doc = new GuildConfigModel(baseRow);
		expect(doc.get("leveling.restrictionMode")).toBe("exclude");
		expect(doc.get("leveling.restrictedChannels")).toEqual([]);
		expect(doc.get("leveling.restrictedRoles")).toEqual([]);
	});

	it("defaults rewards and multipliers to empty and non stacking", () => {
		const doc = new GuildConfigModel(baseRow);
		expect(doc.get("leveling.rewards")).toEqual([]);
		expect(doc.get("leveling.roleMultipliers")).toEqual([]);
		expect(doc.get("leveling.channelMultipliers")).toEqual([]);
		expect(doc.get("leveling.stackRewards")).toBe(true);
		expect(doc.get("leveling.stackMultipliers")).toBe(false);
	});

	it("round trips an admin's configuration rather than dropping it", () => {
		const doc = new GuildConfigModel({
			...baseRow,
			leveling: {
				enabled: false,
				curve: "linear",
				curveMultiplier: 2.5,
				maxLevel: 50,
				announceMode: "milestone",
				announceChannelId: "c-levels",
				restrictionMode: "only",
				restrictedChannels: ["c-general"],
				voice: { approvedChannels: ["v-1", "v-2"], minMembers: 3 },
				rewards: [{ level: 10, roleId: "role-10" }],
				roleMultipliers: [{ roleId: "role-boost", multiplier: 1.5 }],
			},
		});

		expect(doc.get("leveling.enabled")).toBe(false);
		expect(doc.get("leveling.curve")).toBe("linear");
		expect(doc.get("leveling.curveMultiplier")).toBe(2.5);
		expect(doc.get("leveling.maxLevel")).toBe(50);
		expect(doc.get("leveling.announceMode")).toBe("milestone");
		expect(doc.get("leveling.announceChannelId")).toBe("c-levels");
		expect(doc.get("leveling.restrictionMode")).toBe("only");
		expect(doc.get("leveling.restrictedChannels")).toEqual(["c-general"]);
		expect(doc.get("leveling.voice.approvedChannels")).toEqual(["v-1", "v-2"]);
		expect(doc.get("leveling.voice.minMembers")).toBe(3);
		expect(doc.get("leveling.rewards")).toHaveLength(1);
		expect(doc.get("leveling.rewards")[0].roleId).toBe("role-10");
		expect(doc.get("leveling.roleMultipliers")[0].multiplier).toBe(1.5);

		// A partial write must not wipe the siblings it did not mention.
		expect(doc.get("leveling.voice.perMinute")).toBe(5);
		expect(doc.get("leveling.message.cooldownSeconds")).toBe(60);
	});

	it("keeps leveling.enabled entirely separate from leaderboardTrackingEnabled", () => {
		// Two toggles, two systems. leaderboardTrackingEnabled governs PARTICIPATION
		// writes (PlayerActivity, the ROK event score) and must never be reused,
		// extended or renamed to cover leveling, or turning one off silently kills
		// the other.
		const doc = new GuildConfigModel({ ...baseRow, leveling: { enabled: false } });
		expect(doc.get("leveling.enabled")).toBe(false);
		expect(doc.get("leaderboardTrackingEnabled")).toBe(true);
	});

	it("exposes every leveling leaf as a real schema path, so $set updates are not stripped", () => {
		// Document construction is only half the exposure. Strict mode also strips
		// undeclared paths out of an UPDATE payload, so /setup-level-system would
		// silently no-op on any field missing here.
		const paths = [
			"leveling.enabled",
			"leveling.curve",
			"leveling.curveMultiplier",
			"leveling.maxLevel",
			"leveling.milestoneMode",
			"leveling.milestoneEveryN",
			"leveling.message.min",
			"leveling.message.max",
			"leveling.message.cooldownSeconds",
			"leveling.reaction.awards",
			"leveling.voice.approvedChannels",
			"leveling.voice.decayFactor",
			"leveling.announceMode",
			"leveling.announceChannelId",
			"leveling.reactionEmoji",
			"leveling.restrictionMode",
			"leveling.restrictedChannels",
			"leveling.restrictedRoles",
			"leveling.stackRewards",
			"leveling.stackMultipliers",
			"levelsMessageId",
		];
		for (const path of paths) {
			expect(GuildConfigModel.schema.path(path), `${path} is not declared`).toBeDefined();
		}
	});
});

describe("the control case: strict mode really is on", () => {
	// Without this, every assertion above could pass for the wrong reason. If strict mode were
	// off, an undeclared field would round trip happily and the tests would be measuring nothing.
	it("silently drops an undeclared top level field", () => {
		const withGhost = { ...baseRow, definitelyNotAField: "ghost" } as unknown as Record<string, unknown>;
		const doc = new GuildConfigModel(withGhost);
		expect(doc.get("definitelyNotAField")).toBeUndefined();
	});

	it("silently drops an undeclared key inside introMessageIds", () => {
		const withGhost = {
			...baseRow,
			introMessageIds: { definitelyNotAnAnchor: "ghost" },
		} as unknown as Record<string, unknown>;
		const doc = new GuildConfigModel(withGhost);
		expect(doc.get("introMessageIds.definitelyNotAnAnchor")).toBeUndefined();
	});
});
