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
