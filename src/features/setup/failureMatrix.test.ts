import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Collection, DiscordAPIError, RESTJSONErrorCodes, type Client, type Guild } from "discord.js";

// ── Dero setup flow redo failure matrix (2026-11 item 285 Phase 5) ─────────
// One describe per row of the master plan's Risk Register (section 4). Where a row's
// mitigation is cheap to drive, the REAL module runs here with the stores faked; where
// an earlier phase already pins the row in depth, a guard test proves the named test
// still exists, so a deleted or renamed case turns this file red instead of silently
// leaving the row uncovered. The plan is companyuno-growth/product-planning/TODO-PLANS/
// dero-setup-flow-redo-master-plan-2026-11-02.md.
//
// Coverage, row by row:
//   R1  owner DMs closed             driven: a closed DM is logged, never thrown, key unset
//   R2  chip renders as plain text   driven: no command id sends the typed /setup text
//   R3  HQ-only branch leaks         driven: only a row with no notice board id reads HQ-only
//   R4  racing first on demand call  guarded: onDemandChannel.test.ts "concurrent calls"
//   R5  tutorial without a category  guarded: onDemandChannel.test.ts first call builds both
//   R6  Dismantle loses adopted      driven: turnArcadeOff through the real teardown
//   R7  OnboardingCheck regression   guarded: OnboardingCheck.test.ts, both guilds
//   R8  backfill DMs every owner     driven: one send per guild, spaced, one failure no stop
//   R9  em dash in new copy          driven: both packs, setupCopy and the new sources
//   R10 consumer reads a null id     driven: every on demand field has a card, and no
//                                    consumer builds one (2026-11 item 289)
//   R11 Enable stub sends a DM       driven: the handler source has no DM or private reply;
//                                    the stub itself is retired (2026-11 item 285 debug pass)
// Owner manual (no seam a test can reach): the live DM and chip render in Discord, the
// soak on two test guilds and the restart that sends no second DM; all in the runbook.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	has: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { has: mocks.has, log: mocks.log } }));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";
import { GuildSetupManager, isHeadquartersOnly } from "./GuildSetupManager.js";
import { isOnDemandField } from "./onDemandChannel.js";
import { TUTORIAL_CHANNELS } from "./tutorialCards.js";
import { turnArcadeOff } from "./arcadeSwitch.js";
import { setupCopy } from "./setupCopy.js";
import { _resetSetupCommandIdCache, backfillSetupInvitations, sendSetupInvitation } from "./setupInvitation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..");
const sourceOf = (relativeToSrc: string): string => readFileSync(join(SRC, relativeToSrc), "utf8");

// The en dash and the em dash, built from their code points so this file carries neither.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const SETUP_ID = "111222333444555666";

function commandManager(list: Array<{ id: string; name: string }>) {
	const collection = new Collection(list.map((command) => [command.id, command]));
	return { cache: collection, fetch: vi.fn(async () => collection) };
}

function makeClient(commands = commandManager([{ id: SETUP_ID, name: "setup" }]), guilds: Guild[] = []): Client {
	return { application: { commands }, guilds: { cache: new Collection(guilds.map((guild) => [guild.id, guild])) } } as unknown as Client;
}

function makeGuild(id: string, send: (payload: unknown) => Promise<unknown> = async () => undefined): { guild: Guild; send: ReturnType<typeof vi.fn> } {
	const sendMock = vi.fn(send);
	const guild = { id, name: "Test Realm", ownerId: `owner-${id}`, commands: commandManager([]), fetchOwner: vi.fn(async () => ({ send: sendMock })) } as unknown as Guild;
	return { guild, send: sendMock };
}

function dmClosedError(): DiscordAPIError {
	return new DiscordAPIError(
		{ code: RESTJSONErrorCodes.CannotSendMessagesToThisUser, message: "Cannot send messages to this user" },
		RESTJSONErrorCodes.CannotSendMessagesToThisUser,
		403,
		"POST",
		"/channels/1/messages",
		{}
	);
}

const loggedEvents = (): string[] => mocks.log.mock.calls.map((call) => call[1] as string);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	_resetSetupCommandIdCache();
	mocks.has.mockResolvedValue(false);
	mocks.log.mockResolvedValue(undefined);
	mocks.update.mockResolvedValue(undefined);
	mocks.findByGuildId.mockResolvedValue(null);
});

describe("R1: the owner has closed DMs", () => {
	it("logs the failure under its own key, writes no sent key and throws nothing", async () => {
		const { guild } = makeGuild("g1", async () => {
			throw dmClosedError();
		});

		await expect(sendSetupInvitation(guild, makeClient())).resolves.toBeUndefined();

		expect(loggedEvents()).toEqual([BOT_LOG_EVENTS.SETUP_INVITATION_FAILED]);
		expect(loggedEvents()).not.toContain(BOT_LOG_EVENTS.SETUP_INVITATION_SENT);
	});

	it("leaves /setup itself untouched: the invitation module never writes a GuildConfig", async () => {
		const { guild } = makeGuild("g1", async () => {
			throw dmClosedError();
		});

		await sendSetupInvitation(guild, makeClient());

		expect(mocks.update).not.toHaveBeenCalled();
	});
});

describe("R2: the clickable mention cannot render", () => {
	it("still delivers, with the typed /setup instead of a chip, when no command id resolves anywhere", async () => {
		const { guild, send } = makeGuild("g1");

		await sendSetupInvitation(guild, makeClient(commandManager([])));

		expect(send).toHaveBeenCalledOnce();
		const description = (send.mock.calls[0]![0] as { embeds: Array<{ data: { description?: string } }> }).embeds[0]!.data.description ?? "";
		expect(description).toContain("/setup");
		expect(description).not.toMatch(/<\/setup:/);
		expect(loggedEvents()).toEqual([BOT_LOG_EVENTS.SETUP_INVITATION_SENT]);
		expect(mocks.log.mock.calls[0]![2]).toMatchObject({ mentionResolved: false });
	});
});

describe("R3: the Headquarters only branch leaks to an existing guild", () => {
	it("reads only a row with no notice board id and a Headquarters id as Headquarters only", () => {
		expect(isHeadquartersOnly({ categoryId: null, headquartersCategoryId: "hq" })).toBe(true);
		expect(isHeadquartersOnly({ headquartersCategoryId: "hq" })).toBe(true);
	});

	it("reads every legacy shape as a full build: a notice board id, with or without Headquarters, or no row", () => {
		expect(isHeadquartersOnly({ categoryId: "notice", headquartersCategoryId: "hq" })).toBe(false);
		expect(isHeadquartersOnly({ categoryId: "notice", headquartersCategoryId: null })).toBe(false);
		expect(isHeadquartersOnly({ categoryId: "notice", gamesCategoryId: "arcade" })).toBe(false);
		expect(isHeadquartersOnly(null)).toBe(false);
		expect(isHeadquartersOnly(undefined)).toBe(false);
	});
});

describe("R4: two callers race the first on demand build", () => {
	it("is pinned by onDemandChannel.test.ts, same slot built once and a lost category claim cleaned up", () => {
		const pinned = sourceOf("features/setup/onDemandChannel.test.ts");
		expect(pinned).toContain('describe("concurrent calls"');
		expect(pinned).toContain("resolve to the same channel, built once");
		expect(pinned).toContain("keeps the first stored category when another process wins the claim, and removes its own");
	});
});

describe("R5: a tutorial press finds no notice board category", () => {
	it("is pinned by onDemandChannel.test.ts, which builds the category first, then the channel", () => {
		const pinned = sourceOf("features/setup/onDemandChannel.test.ts");
		expect(pinned).toContain("builds the notice board category, then the channel inside it");
		expect(pinned).toContain("a category Discord refused to build");
	});

	it("routes every card press through that one builder, never a second build path", () => {
		const source = sourceOf("features/setup/tutorialCards.ts");
		expect(source).toContain("ensureOnDemandChannel(guild, field");
		expect(source).not.toMatch(/createManagedCategory|buildSingleChannel|repairOneChannel/);
	});
});

describe("R6: Dismantle Arcade loses track of adopted channels", () => {
	it("deletes the arcade's own channels and keeps one the server adopted into it", async () => {
		const ownChannel = { delete: vi.fn(async () => undefined) };
		const adoptedChannel = { delete: vi.fn(async () => undefined) };
		const channels = new Map<string, typeof ownChannel>([
			["ch-own", ownChannel],
			["ch-adopted", adoptedChannel],
		]);
		const arcadeFields = GuildSetupManager.CHANNEL_SPECS.filter((spec) => spec.categoryField === "gamesCategoryId").map((spec) => spec.configField);
		const row: Record<string, unknown> = {
			guildId: "g1",
			gamesCategoryId: "cat-games",
			userRemovedChannels: [],
			adoptedChannelIds: ["ch-adopted"],
		};
		row[arcadeFields[0]!] = "ch-own";
		row[arcadeFields[1]!] = "ch-adopted";
		mocks.findByGuildId.mockResolvedValue(row);
		const guild = { id: "g1", channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) } } as unknown as Guild;

		expect(await turnArcadeOff(guild)).toBe("off");

		expect(ownChannel.delete).toHaveBeenCalledOnce();
		expect(adoptedChannel.delete).not.toHaveBeenCalled();
		// The category pass ran too (the real teardown, whose fetch finds nothing here).
		expect(guild.channels.fetch).toHaveBeenCalledWith("cat-games");
	});
});

describe("R7: the OnboardingCheck guard regresses the Default Channels DM", () => {
	it("is pinned by OnboardingCheck.test.ts, silent on Headquarters only and still warning a legacy guild", () => {
		const pinned = sourceOf("features/setup/OnboardingCheck.test.ts");
		expect(pinned).toContain("stays silent on a Headquarters only install and writes no log, so a later boot can still warn");
		expect(pinned).toContain("still warns a legacy guild that also has Headquarters");
	});
});

describe("R8: the backfill DMs every owner on the first boot", () => {
	it("sends each missing guild exactly one DM, waiting the spacing constant between sends and never before the first", async () => {
		const first = makeGuild("g1");
		const second = makeGuild("g2");
		const third = makeGuild("g3");
		const sleeps: number[] = [];

		await backfillSetupInvitations(makeClient(undefined, [first.guild, second.guild, third.guild]), async (ms) => {
			sleeps.push(ms);
		});

		expect([first.send, second.send, third.send].map((send) => send.mock.calls.length)).toEqual([1, 1, 1]);
		expect(sleeps).toEqual([BOT_CONSTANTS.SETUP_INVITATION_DM_SPACING_MS, BOT_CONSTANTS.SETUP_INVITATION_DM_SPACING_MS]);
	});

	it("skips a guild whose key is already written, so a second boot sends nothing", async () => {
		const only = makeGuild("g1");
		mocks.has.mockResolvedValue(true);

		await backfillSetupInvitations(makeClient(undefined, [only.guild]), async () => undefined);

		expect(only.send).not.toHaveBeenCalled();
		expect(mocks.log).not.toHaveBeenCalled();
	});

	it("keeps walking after one owner's DM fails", async () => {
		const blocked = makeGuild("g1", async () => {
			throw dmClosedError();
		});
		const open = makeGuild("g2");

		await backfillSetupInvitations(makeClient(undefined, [blocked.guild, open.guild]), async () => undefined);

		expect(open.send).toHaveBeenCalledOnce();
	});
});

describe("R9: a new copy line carries an em or en dash", () => {
	it("finds none anywhere in either copy pack, which holds the invitation, tutorial, Dismantle, stub and rename lines", () => {
		expect(JSON.stringify(rokCommanderCopy)).not.toMatch(LONG_DASHES);
		expect(JSON.stringify(generalEventsCopy)).not.toMatch(LONG_DASHES);
	});

	it("finds none in the admin facing setup copy", () => {
		expect(JSON.stringify(setupCopy)).not.toMatch(LONG_DASHES);
	});

	it("finds none in any source file the plan added or extended", () => {
		for (const file of [
			"features/setup/setupInvitation.ts",
			"features/setup/onDemandChannel.ts",
			"features/setup/removeChannel.ts",
			"features/setup/tutorialCards.ts",
			"features/setup/arcadeControlCards.ts",
			"features/setup/renameInfoStep.ts",
			"features/setup/headquartersCards.ts",
			"features/setup/headquartersSteps.ts",
		]) {
			expect(sourceOf(file), file).not.toMatch(LONG_DASHES);
		}
	});
});

describe("R10: a consumer still reads a null notice board channel id", () => {
	it("gives every on demand field a step card, the one way to build it", () => {
		const tutorialFields = new Set<string>(Object.values(TUTORIAL_CHANNELS));
		const everyField = GuildSetupManager.CHANNEL_SPECS.filter((spec) => spec.categoryField === "categoryId").map((spec) => spec.configField);

		const withoutCard = everyField.filter((field) => isOnDemandField(field) && !tutorialFields.has(field));

		expect(withoutCard).toEqual([]);
	});

	it.each(["features/leveling/LevelsBoard.ts", "features/schedule/NextUpBoard.ts", "utils/answerInChannel.ts"])("leaves %s no way to build a channel", (file) => {
		const source = sourceOf(file);
		expect(source).not.toContain("ensureOnDemandChannel");
		expect(source).not.toContain("onDemandChannel.js");
	});
});

describe("R11: the Enable Arcade stub sends a DM", () => {
	it("has no DM call and no private reply anywhere in its handler module", () => {
		const source = sourceOf("features/setup/arcadeControlCards.ts");
		expect(source).not.toMatch(/createDM|\.send\(|users\.send|MessageFlags\.Ephemeral|ephemeral\s*:/);
	});

	// The coming soon stub is retired: the card no longer carries it, and an older card's
	// press runs the enable step instead (2026-11 item 285 debug pass, owner ruling).
	it("no longer puts the stub on the card", () => {
		const source = sourceOf("features/setup/arcadeControlCards.ts");
		expect(source).not.toMatch(/handleEnableStub|enableStubButton/);
	});
});
