import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, Guild } from "discord.js";

// ── Discord Onboarding compatibility ───────────────────────────────────────
// The check exists to stop a guild's new members being blind to the bot. As of
// the 🎮 ARCADE GAMES work there are TWO managed categories, and a guild whose
// homebase is defaulted while its arcade is not has members who can read
// announcements and cannot find a single game. That is the same discovery
// problem this check was built for, one surface over, so it must warn on either.
//
// The function had NO tests before this file, which is the same gap that let
// applyAdminRole silently skip a channel for months.

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { has: vi.fn(), log: vi.fn() } }));

import { checkOnboardingAndNotifyOwner } from "./OnboardingCheck.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const logMock = botLogStore as unknown as { has: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> };

const HOMEBASE = "cat-1";
const ARCADE = "games-cat-1";

// `defaults` is the set of category ids the admin added to Onboarding's Default
// Channels list. Everything not in it is hidden from new members until they opt in.
function makeGuild(defaults: string[]): { guild: Guild; send: ReturnType<typeof vi.fn> } {
	const send = vi.fn(async () => undefined);
	const guild = {
		id: "guild-1",
		name: "Test Guild",
		features: ["COMMUNITY"],
		fetchOnboarding: async () => ({ enabled: true, prompts: new Map(), defaultChannels: new Set(defaults) }),
		fetchOwner: async () => ({ send }),
	} as unknown as Guild;
	return { guild, send };
}

const run = (guild: Guild) => checkOnboardingAndNotifyOwner({} as Client, guild);
const dmBody = (send: ReturnType<typeof vi.fn>): string => String(send.mock.calls[0][0]);

beforeEach(() => {
	vi.clearAllMocks();
	logMock.has.mockResolvedValue(false);
	logMock.log.mockResolvedValue(undefined);
	configMock.findByGuildId.mockResolvedValue({ categoryId: HOMEBASE, gamesCategoryId: ARCADE });
});

describe("checkOnboardingAndNotifyOwner", () => {
	it("stays silent when BOTH managed categories are already defaulted", async () => {
		const { guild, send } = makeGuild([HOMEBASE, ARCADE]);
		await run(guild);
		expect(send).not.toHaveBeenCalled();
		// Deliberately no idempotency row either: if the admin later removes one
		// from defaults, the next restart must catch it.
		expect(logMock.log).not.toHaveBeenCalled();
	});

	it("warns when only the ARCADE category is hidden", async () => {
		// The case that did not exist before this change. A homebase-only check
		// would have gone silent here and left members unable to find any game.
		const { guild, send } = makeGuild([HOMEBASE]);
		await run(guild);

		expect(send).toHaveBeenCalledOnce();
		expect(dmBody(send)).toContain(rokCommanderCopy.setup.gamesCategoryName);
		// And does NOT tell the owner to fix the one they already fixed.
		expect(dmBody(send)).not.toContain(rokCommanderCopy.setup.categoryName);
	});

	it("warns when only the homebase category is hidden", async () => {
		const { guild, send } = makeGuild([ARCADE]);
		await run(guild);
		expect(dmBody(send)).toContain(rokCommanderCopy.setup.categoryName);
		expect(dmBody(send)).not.toContain(rokCommanderCopy.setup.gamesCategoryName);
	});

	it("names both when both are hidden, in one DM rather than two", async () => {
		const { guild, send } = makeGuild([]);
		await run(guild);
		expect(send).toHaveBeenCalledOnce();
		expect(dmBody(send)).toContain(rokCommanderCopy.setup.categoryName);
		expect(dmBody(send)).toContain(rokCommanderCopy.setup.gamesCategoryName);
	});

	it("ignores an arcade category that does not exist yet", async () => {
		// A legacy row carries null until the boot sweep builds it. A category that
		// does not exist is the sweep's problem, not something to nag the owner about.
		configMock.findByGuildId.mockResolvedValue({ categoryId: HOMEBASE, gamesCategoryId: null });
		const { guild, send } = makeGuild([HOMEBASE]);
		await run(guild);
		expect(send).not.toHaveBeenCalled();
	});

	// 2026-11 item 285 Phase 2: a fresh install builds 🏰 DERO HEADQUARTERS alone, which is
	// admin only, so the Default Channels warning has nothing members could miss.
	it("stays silent on a Headquarters only install and writes no log, so a later boot can still warn", async () => {
		configMock.findByGuildId.mockResolvedValue({ categoryId: null, gamesCategoryId: null, headquartersCategoryId: "hq-cat-1" });
		const { guild, send } = makeGuild([]);
		await run(guild);
		expect(send).not.toHaveBeenCalled();
		expect(logMock.log).not.toHaveBeenCalled();
	});

	it("still warns a legacy guild that also has Headquarters", async () => {
		configMock.findByGuildId.mockResolvedValue({ categoryId: HOMEBASE, gamesCategoryId: ARCADE, headquartersCategoryId: "hq-cat-1" });
		const { guild, send } = makeGuild([ARCADE]);
		await run(guild);
		expect(send).toHaveBeenCalledOnce();
		expect(dmBody(send)).toContain(rokCommanderCopy.setup.categoryName);
	});

	it("records which categories were hidden, so an operator can tell the cases apart", async () => {
		const { guild } = makeGuild([HOMEBASE]);
		await run(guild);
		const metadata = logMock.log.mock.calls[0][2] as { hiddenCategoryIds: string[] };
		expect(metadata.hiddenCategoryIds).toEqual([ARCADE]);
	});
});
