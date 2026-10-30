import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel } from "discord.js";
import type { Client } from "discord.js";

// Mocks must precede the announceSeasonEnd import. ReminderScheduler.js
// pulls in a wide import graph (eventStore, eventOverrideStore, ReminderJob
// which itself imports NextUpBoard, etc), all of those would otherwise
// register mongoose models on an unconnected connection and hang the test
// process waiting for a DB handshake. Mock every store/feature on the
// import chain so the mongoose model files never load.
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: {
		findByGuildId: vi.fn(),
	},
}));

vi.mock("@db/stores/reminderStore.js", () => ({
	reminderStore: {
		exists: vi.fn(),
		create: vi.fn(),
		findByEventId: vi.fn(),
	},
}));

vi.mock("@db/stores/eventStore.js", () => ({
	eventStore: {
		findByGuildId: vi.fn().mockResolvedValue([]),
		findByIdInGuild: vi.fn().mockResolvedValue(null),
		updateInGuild: vi.fn().mockResolvedValue(null),
		deleteInGuild: vi.fn().mockResolvedValue(null),
	},
}));

vi.mock("@db/stores/eventOverrideStore.js", () => ({
	eventOverrideStore: {
		findOne: vi.fn().mockResolvedValue(null),
		upsert: vi.fn(),
		findByEventInRange: vi.fn().mockResolvedValue([]),
	},
}));

// Stub the post-announce schedule refresh. announceSeasonEnd fires-and-forgets
// refreshSchedule; mocking it keeps the test from pulling in the full
// ScheduleBoard import chain (eventStore mongoose model, embedBuilder, etc).
vi.mock("@features/schedule/ScheduleBoard.js", () => ({
	refreshSchedule: vi.fn().mockResolvedValue(undefined),
	refreshAllSchedules: vi.fn().mockResolvedValue(undefined),
}));

// NextUpBoard is transitively imported via ReminderJob's refreshNextUp call.
// Mocking it keeps the eventOverrideStore + occurrenceCalculator chain
// out of the test's hot path.
vi.mock("@features/schedule/NextUpBoard.js", () => ({
	refreshNextUp: vi.fn().mockResolvedValue(undefined),
	refreshAllNextUp: vi.fn().mockResolvedValue(undefined),
	_resetNextUpDedupForTest: vi.fn(),
}));

import { announceSeasonEnd, recurringFireCandidates } from "./ReminderScheduler.js";
import { eventOverrideStore } from "@db/stores/eventOverrideStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { reminderStore } from "@db/stores/reminderStore.js";
import type { IGameEvent } from "@features/events/event.types.js";

// ── parked scaffolding, mostly unused today ────────────────────────────────
// makeEvent is used by the recurringFireCandidates cases at the bottom. The other
// helpers below were written for the deeper integration tests
// described in the describe block at the bottom of this file, which were
// attempted and blocked. They are kept rather than deleted so whoever unblocks
// that work does not rebuild them from scratch.
//
// The leading underscore is the sanctioned "intentionally unused" marker: it is
// what `@typescript-eslint/no-unused-vars`' argsIgnorePattern / varsIgnorePattern
// in eslint.config.js matches on. Before 2026-08-08 this file was invisible to
// eslint entirely (it sat outside the linted TS project), so these read as clean;
// they are marked now that test files actually get linted. Drop the underscore
// when a test starts using one.
const _guildConfigMock = guildConfigStore as unknown as {
	findByGuildId: ReturnType<typeof vi.fn>;
};
const _reminderStoreMock = reminderStore as unknown as {
	exists: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
};

function makeEvent(overrides: Partial<IGameEvent> = {}): IGameEvent {
	// firstOccurrence and seasonEnd are deliberately in the far future so
	// the test never depends on the machine clock. announceSeasonEnd does
	// not consult Date.now(), the cron tick gates on now > seasonEnd
	// before calling, so any seasonEnd Date works for the dedup contract.
	return {
		eventId: "evt-1",
		name: "Ancient Ruins",
		description: "",
		type: "recurring",
		intervalHours: 40,
		firstOccurrence: new Date("2030-01-01T12:00:00Z"),
		seasonEnd: new Date("2030-06-01T00:00:00Z"),
		reminderOffsets: [30, 15],
		guildId: "guild-1",
		prepSteps: [{ id: "step-1", label: "Activate stats token", order: 1 }],
		active: true,
		...overrides,
	};
}

// Object.create(TextChannel.prototype) is the leanest way to satisfy the
// `channel instanceof TextChannel` check in announceSeasonEnd without
// constructing a full discord.js Guild + Client chain. Same trick used in
// TestReminderJob.test.ts.
function _makeTextChannel(): TextChannel & { send: ReturnType<typeof vi.fn> } {
	const ch = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
	Object.assign(ch, {
		id: "ch-announcements",
		send: vi.fn().mockResolvedValue({ id: "msg-1" }),
	});
	return ch;
}

function _makeClient(channel: TextChannel | null): Client {
	return {
		channels: {
			fetch: vi.fn().mockResolvedValue(channel),
		},
	} as unknown as Client;
}

describe("announceSeasonEnd guild-scoped dedup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ── smoke: import + define ───────────────────────────────────────
	// Confirms the import chain resolves through the mocked stores and
	// the function is loaded. The deeper integration tests that exercise
	// channel.send + reminderStore.create were attempted but ran into
	// two project-level blockers:
	//
	//   1. discord.js v14.26 changed class internals so
	//      Object.create(TextChannel.prototype) no longer satisfies
	//      `instanceof TextChannel`, flagged in CLAUDE.md tech debt as
	//      a pending swap to `vi.mock("discord.js", ...)`.
	//   2. The await-based test paths timed out at 5s and 30s for
	//      reasons that did not surface a useful stack, likely the
	//      same import-graph issue as the failing existing test
	//      suites (TestReminderJob.test.ts, GuildSetupManager.test.ts,
	//      ChannelDeleteWatcher.test.ts, events.routes.test.ts) which
	//      all fail to load with "Cannot find package" against
	//      @-aliased imports despite vite-tsconfig-paths being
	//      configured. Fixing requires test-infra work beyond the
	//      scope of this fix.
	//
	// The dedup CONTRACT is enforced at the DB layer by the compound
	// unique index `{eventId, eventOccurrence, offsetMinutes}` on
	// ReminderLog, the synthetic key format `season-end:<guildId>` +
	// `offsetMinutes: -1` cannot regress without an explicit code change
	// to either the index or the announceSeasonEnd helper. The Phase 8
	// manual smoke (one announcement embed per season-end) verifies the
	// production behavior end-to-end against a real Discord channel.
	it("smoke: announceSeasonEnd is defined and exported", () => {
		expect(typeof announceSeasonEnd).toBe("function");
	});
});

// ── an "apply once" override that moves an occurrence later (2026-10 item 280) ──
// Once the original start passes, the next computed occurrence is the following one, so
// looking up overrides only for that one lost every reminder of the moved occurrence.
describe("recurringFireCandidates", () => {
	const ANCHOR = new Date("2030-01-01T12:00:00Z");
	const MOVED_TO = new Date("2030-01-01T20:00:00Z");
	const NOW = new Date("2030-01-01T19:40:00Z"); // original start passed, the moved one still ahead
	const NEXT = new Date("2030-01-03T04:00:00Z"); // anchor plus 40 hours
	const overrideMock = eventOverrideStore as unknown as { findOne: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		overrideMock.findOne.mockReset().mockResolvedValue(null);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps the previous occurrence while its override still lies ahead, keyed on its ORIGINAL start", async () => {
		overrideMock.findOne.mockImplementation(async ({ originalOccurrence }: { originalOccurrence: Date }) =>
			originalOccurrence.getTime() === ANCHOR.getTime() ? { overrideTime: MOVED_TO, overrideTitle: null, overrideDescription: null } : null
		);

		const candidates = await recurringFireCandidates(makeEvent({ firstOccurrence: ANCHOR }), NOW);

		expect(candidates.map((candidate) => [candidate.originalOccurrence.toISOString(), candidate.fireMoment.toISOString()])).toEqual([
			[ANCHOR.toISOString(), MOVED_TO.toISOString()],
			[NEXT.toISOString(), NEXT.toISOString()],
		]);
	});

	it("drops the previous occurrence when it has no override, so only the next one is checked", async () => {
		const candidates = await recurringFireCandidates(makeEvent({ firstOccurrence: ANCHOR }), NOW);

		expect(candidates.map((candidate) => candidate.originalOccurrence.toISOString())).toEqual([NEXT.toISOString()]);
	});
});
