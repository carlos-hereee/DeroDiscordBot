import { describe, it, expect } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import { buildRoomOverwrites, effectiveSpectatorMode, type RoomPermissionInput, type RoomOverwrite } from "./roomPermissions.js";
import type { RoomVisibility, SpectatorMode } from "./roomTypes.js";
import { buildBotSelfOverwrite } from "@utils/channelOverwrites.js";

const EVERYONE = "everyone-role";
const BOT = "bot-1";
const HOST = "host-1";
const PLAYER = "player-2";
const SPECTATOR = "spectator-3";
const ADMIN_ROLE = "admin-role";

function makeInput(overrides: Partial<RoomPermissionInput> = {}): RoomPermissionInput {
	return {
		everyoneRoleId: EVERYONE,
		botId: BOT,
		hostId: HOST,
		playerIds: [HOST, PLAYER],
		spectatorIds: [SPECTATOR],
		visibility: "invite",
		phase: "playing",
		adminRoleId: ADMIN_ROLE,
		...overrides,
	};
}

const entryFor = (overwrites: RoomOverwrite[], id: string) => overwrites.find((entry) => entry.id === id);

describe("buildRoomOverwrites, invite only, playing", () => {
	it("hides the room from @everyone, and denies reactions to everyone who is not playing", () => {
		const everyone = entryFor(buildRoomOverwrites(makeInput()), EVERYONE);
		expect(everyone?.deny).toEqual([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions]);
		// No ViewChannel allow: an invite room is invisible, not merely read-only.
		expect(everyone?.allow).toBeUndefined();
	});

	it("gives the host and every player view, send, history and reactions", () => {
		const overwrites = buildRoomOverwrites(makeInput());
		for (const id of [HOST, PLAYER]) {
			expect(entryFor(overwrites, id)?.allow).toEqual([
				PermissionFlagsBits.ViewChannel,
				PermissionFlagsBits.SendMessages,
				PermissionFlagsBits.ReadMessageHistory,
				PermissionFlagsBits.AddReactions,
			]);
		}
	});

	it("lets a spectator watch but not type, and not open a thread to type in", () => {
		const spectator = entryFor(buildRoomOverwrites(makeInput()), SPECTATOR);
		expect(spectator?.allow).toEqual([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
		expect(spectator?.deny).toEqual([
			PermissionFlagsBits.SendMessages,
			PermissionFlagsBits.CreatePublicThreads,
			PermissionFlagsBits.SendMessagesInThreads,
		]);
	});

	// The owner reversed the old rule on 2026-10-26 (2026-10 item 254, Arcade 11): only the
	// players react. The spectator's own entry neither allows nor denies it, so the one
	// @everyone deny decides, and no per member deny is ever spent on it.
	it("leaves a spectator unable to react, through the @everyone deny alone", () => {
		const overwrites = buildRoomOverwrites(makeInput());
		const spectator = entryFor(overwrites, SPECTATOR);
		expect(spectator?.allow).not.toContain(PermissionFlagsBits.AddReactions);
		expect(spectator?.deny).not.toContain(PermissionFlagsBits.AddReactions);
		expect(entryFor(overwrites, EVERYONE)?.deny).toContain(PermissionFlagsBits.AddReactions);
	});

	it("grants the admin role read-only, never write", () => {
		const admin = entryFor(buildRoomOverwrites(makeInput()), ADMIN_ROLE);
		expect(admin?.allow).toEqual([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
		expect(admin?.allow).not.toContain(PermissionFlagsBits.SendMessages);
	});

	it("omits the admin entry entirely when the guild has no admin role", () => {
		const overwrites = buildRoomOverwrites(makeInput({ adminRoleId: null }));
		expect(entryFor(overwrites, ADMIN_ROLE)).toBeUndefined();
		// An `{ id: null }` entry would throw at the Discord API rather than here.
		expect(overwrites.every((entry) => typeof entry.id === "string" && entry.id.length > 0)).toBe(true);
	});

	it("carries the shared bot overwrite verbatim", () => {
		// Identity with the setup path matters: a room the bot cannot post into is
		// discovered at post time, not at create time.
		expect(entryFor(buildRoomOverwrites(makeInput()), BOT)).toEqual(buildBotSelfOverwrite(BOT));
	});
});

describe("buildRoomOverwrites, public, playing", () => {
	const publicInput = makeInput({ visibility: "public", spectatorIds: [] });

	// ⚠️ THE LOAD BEARING ASSERTION OF THE FEATURE. One @everyone overwrite, never one
	// per member, is the difference between a room that works in a 5000 member guild and
	// one that does not.
	it("spends EXACTLY ONE @everyone overwrite", () => {
		const overwrites = buildRoomOverwrites(publicInput);
		expect(overwrites.filter((entry) => entry.id === EVERYONE)).toHaveLength(1);
	});

	it("lets everyone read and stops everyone writing or reacting", () => {
		const everyone = entryFor(buildRoomOverwrites(publicInput), EVERYONE);
		expect(everyone?.allow).toEqual([PermissionFlagsBits.ViewChannel]);
		expect(everyone?.deny).toEqual([PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions]);
	});

	it("still grants only the players write access", () => {
		const overwrites = buildRoomOverwrites(publicInput);
		const writers = overwrites.filter((entry) => entry.allow?.includes(PermissionFlagsBits.SendMessages));
		// The two players plus the bot. Nobody else may type in a public room.
		expect(writers.map((entry) => entry.id).sort()).toEqual([BOT, HOST, PLAYER].sort());
	});

	// A public room's watchers are covered by the single @everyone entry. Emitting
	// per-spectator overwrites here would reintroduce exactly the O(members) cost the
	// public case exists to avoid.
	it("ignores spectatorIds entirely, so a public room never grows per-member entries", () => {
		const withSpectators = buildRoomOverwrites(makeInput({ visibility: "public", spectatorIds: [SPECTATOR, "s4", "s5"] }));
		expect(entryFor(withSpectators, SPECTATOR)).toBeUndefined();
		expect(withSpectators).toHaveLength(buildRoomOverwrites(publicInput).length);
	});
});

describe("buildRoomOverwrites, finished (locked)", () => {
	// ⚠️ THE SUBTLETY THAT MAKES THE LOCK REAL. Removing a player's SendMessages ALLOW
	// is not a lock: with no deny anywhere they fall through to the guild-wide
	// @everyone base permission, which grants SendMessages in almost every server. The
	// lock has to be an explicit @everyone DENY, and these two tests are what prove it
	// is present in both visibilities rather than only in the public one (where it
	// happens to already exist for a different reason).
	it.each([
		["invite", "invite" as const],
		["public", "public" as const],
	])("denies SendMessages on @everyone in a %s room, which is what actually locks it", (_label, visibility) => {
		const everyone = entryFor(buildRoomOverwrites(makeInput({ visibility, phase: "finished" })), EVERYONE);
		expect(everyone?.deny).toContain(PermissionFlagsBits.SendMessages);
	});

	it("closes the thread bypass too, so 'nobody can type' means nobody", () => {
		const everyone = entryFor(buildRoomOverwrites(makeInput({ phase: "finished" })), EVERYONE);
		expect(everyone?.deny).toContain(PermissionFlagsBits.CreatePublicThreads);
		expect(everyone?.deny).toContain(PermissionFlagsBits.SendMessagesInThreads);
	});

	it("leaves an invite room hidden as well as locked", () => {
		const everyone = entryFor(buildRoomOverwrites(makeInput({ phase: "finished" })), EVERYONE);
		expect(everyone?.deny).toContain(PermissionFlagsBits.ViewChannel);
	});

	it("drops SendMessages from every player, leaving them the transcript", () => {
		const overwrites = buildRoomOverwrites(makeInput({ phase: "finished" }));
		for (const id of [HOST, PLAYER]) {
			expect(entryFor(overwrites, id)?.allow).toEqual([
				PermissionFlagsBits.ViewChannel,
				PermissionFlagsBits.ReadMessageHistory,
			]);
		}
	});

	it("leaves the BOT able to write, because the result card posts into the locked room", () => {
		const bot = entryFor(buildRoomOverwrites(makeInput({ phase: "finished" })), BOT);
		expect(bot?.allow).toContain(PermissionFlagsBits.SendMessages);
	});

	it("leaves nobody but the bot able to write", () => {
		const overwrites = buildRoomOverwrites(makeInput({ phase: "finished" }));
		const writers = overwrites.filter((entry) => entry.allow?.includes(PermissionFlagsBits.SendMessages));
		expect(writers.map((entry) => entry.id)).toEqual([BOT]);
	});
});

describe("buildRoomOverwrites, shape guarantees", () => {
	it("never emits two entries for the same id", () => {
		// Discord takes the LAST entry for an id, so a duplicate is a silent
		// last-write-wins rather than an error: a host listed twice, or a member who is
		// both player and spectator, would have their write access quietly replaced by
		// the spectator deny.
		const overwrites = buildRoomOverwrites(
			makeInput({ playerIds: [HOST, HOST, PLAYER], spectatorIds: [PLAYER, SPECTATOR, SPECTATOR] })
		);
		const ids = overwrites.map((entry) => entry.id);
		expect(ids).toHaveLength(new Set(ids).size);
	});

	it("keeps a player who was also listed as a spectator writable", () => {
		const overwrites = buildRoomOverwrites(makeInput({ playerIds: [HOST, PLAYER], spectatorIds: [PLAYER] }));
		expect(entryFor(overwrites, PLAYER)?.allow).toContain(PermissionFlagsBits.SendMessages);
		expect(entryFor(overwrites, PLAYER)?.deny).toBeUndefined();
	});

	it("includes the host even when playerIds forgot them", () => {
		const overwrites = buildRoomOverwrites(makeInput({ playerIds: [] }));
		expect(entryFor(overwrites, HOST)?.allow).toContain(PermissionFlagsBits.SendMessages);
	});
});

// ── the host's spectator setting (2026-10 item 254, Arcade 11) ──────────
describe("effectiveSpectatorMode", () => {
	it("reads a host who never chose as the default the visibility always had", () => {
		expect(effectiveSpectatorMode("public", null)).toBe("open");
		expect(effectiveSpectatorMode("invite", null)).toBe("invite");
		expect(effectiveSpectatorMode("invite", undefined)).toBe("invite");
	});

	it("keeps the host's choice on a public or invite room", () => {
		expect(effectiveSpectatorMode("public", "none")).toBe("none");
		expect(effectiveSpectatorMode("invite", "open")).toBe("open");
	});

	it("makes a solo room No spectators whatever the row says", () => {
		expect(effectiveSpectatorMode("solo", null)).toBe("none");
		expect(effectiveSpectatorMode("solo", "open")).toBe("none");
	});
});

describe("buildRoomOverwrites, the spectator setting matrix", () => {
	// Who can see the room, by setting: open spreads it to @everyone with ONE entry,
	// invite to the listed spectators, none to the players and admins only.
	const cases: Array<[RoomVisibility, SpectatorMode | null, SpectatorMode]> = [
		["public", null, "open"],
		["public", "open", "open"],
		["public", "invite", "invite"],
		["public", "none", "none"],
		["invite", null, "invite"],
		["invite", "open", "open"],
		["invite", "invite", "invite"],
		["invite", "none", "none"],
		["solo", null, "none"],
		["solo", "open", "none"],
	];

	it.each(cases)("%s visibility with setting %s behaves as %s", (visibility, stored, effective) => {
		const overwrites = buildRoomOverwrites(makeInput({ visibility, spectatorMode: stored, spectatorIds: [SPECTATOR, "s4"] }));
		const everyone = entryFor(overwrites, EVERYONE);

		// Exactly one @everyone entry in every setting, and it always denies reactions.
		expect(overwrites.filter((entry) => entry.id === EVERYONE)).toHaveLength(1);
		expect(everyone?.deny).toContain(PermissionFlagsBits.AddReactions);
		// Only the players and the bot may type, whatever the setting.
		const writers = overwrites.filter((entry) => entry.allow?.includes(PermissionFlagsBits.SendMessages));
		expect(writers.map((entry) => entry.id).sort()).toEqual([BOT, HOST, PLAYER].sort());
		// Only the players and the bot (whose shared overwrite carries reactions) may react.
		const reactors = overwrites.filter((entry) => entry.allow?.includes(PermissionFlagsBits.AddReactions));
		expect(reactors.map((entry) => entry.id).sort()).toEqual([BOT, HOST, PLAYER].sort());

		if (effective === "open") {
			expect(everyone?.allow).toEqual([PermissionFlagsBits.ViewChannel]);
			expect(everyone?.deny).not.toContain(PermissionFlagsBits.ViewChannel);
		} else {
			expect(everyone?.allow).toBeUndefined();
			expect(everyone?.deny).toContain(PermissionFlagsBits.ViewChannel);
		}
		// Per member watcher entries exist under Invite only and nowhere else.
		const watcherIds = [SPECTATOR, "s4"].filter((id) => entryFor(overwrites, id));
		expect(watcherIds).toEqual(effective === "invite" ? [SPECTATOR, "s4"] : []);
	});

	it("keeps a locked room unwritable and unreactable in every setting", () => {
		for (const spectatorMode of ["open", "invite", "none"] as const) {
			const overwrites = buildRoomOverwrites(makeInput({ visibility: "public", spectatorMode, phase: "finished" }));
			const everyone = entryFor(overwrites, EVERYONE);
			expect(everyone?.deny).toContain(PermissionFlagsBits.SendMessages);
			expect(everyone?.deny).toContain(PermissionFlagsBits.AddReactions);
			expect(overwrites.filter((entry) => entry.allow?.includes(PermissionFlagsBits.AddReactions)).map((entry) => entry.id)).not.toContain(HOST);
		}
	});
});
