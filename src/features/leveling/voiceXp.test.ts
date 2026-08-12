import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType } from "discord.js";
import type { Client } from "discord.js";

// ── voiceXp ────────────────────────────────────────────────────────────────
// Four gates and a decay, and every one of them exists because a 24/7 voice self
// bot is a real, public, mature tool. Gate 1 (an admin approved channel list) is
// this bot's own addition and is strictly stronger than anything the category
// offers; gates 2 to 4 are Arcane's anti farm set copied wholesale.
//
// The most important case in the file is the one that pays NOTHING: alone, or
// muted, or in an unapproved channel.

const mocks = vi.hoisted(() => ({ awardXp: vi.fn(), getLevelingConfig: vi.fn() }));

vi.mock("./awardXp.js", () => ({ awardXp: mocks.awardXp }));
vi.mock("./levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));

import { _clearVoiceSessions, _voiceSessionCount, sweepVoiceXp } from "./voiceXp.js";
import { _clearXpWriter } from "./xpWriter.js";

interface MemberSpec {
	id: string;
	bot?: boolean;
	selfMute?: boolean;
	selfDeaf?: boolean;
	serverMute?: boolean;
	serverDeaf?: boolean;
	roleIds?: string[];
}

function buildClient(channels: Array<{ id: string; members: MemberSpec[]; type?: ChannelType }>): Client {
	const guild = { id: "g1", channels: { cache: new Map<string, unknown>() } };

	for (const channel of channels) {
		guild.channels.cache.set(channel.id, {
			id: channel.id,
			type: channel.type ?? ChannelType.GuildVoice,
			members: new Map(
				channel.members.map((member) => [
					member.id,
					{
						id: member.id,
						displayName: member.id,
						user: { bot: member.bot ?? false },
						guild,
						client: {},
						voice: {
							selfMute: member.selfMute ?? false,
							selfDeaf: member.selfDeaf ?? false,
							serverMute: member.serverMute ?? false,
							serverDeaf: member.serverDeaf ?? false,
						},
						roles: { cache: new Map((member.roleIds ?? []).map((id) => [id, {}])) },
					},
				])
			),
		});
	}

	return { guilds: { cache: new Map([["g1", guild]]) } } as unknown as Client;
}

const settings = (voice: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) => ({
	enabled: true,
	restrictionMode: "exclude",
	restrictedChannels: [],
	restrictedRoles: [],
	roleMultipliers: [],
	channelMultipliers: [],
	stackMultipliers: false,
	...rest,
	voice: {
		enabled: true,
		perMinute: 5,
		cooldownSeconds: 60,
		approvedChannels: ["v-approved"],
		minMembers: 2,
		decayAfterMinutes: 120,
		decayFactor: 0.25,
		...voice,
	},
});

const context = (voice: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) => ({
	settings: settings(voice, rest),
	weekStart: "sunday",
});

const MINUTE = 60_000;
const amountOf = (index = 0): number => (mocks.awardXp.mock.calls[index][0] as { amount: number }).amount;

// A member is only paid on the SECOND sighting: the first starts their session
// clock, because paying on arrival would reward joining and leaving repeatedly.
async function sweepTwice(client: Client, gapMs: number, start = 1_000_000): Promise<void> {
	await sweepVoiceXp(client, start);
	await sweepVoiceXp(client, start + gapMs);
}

beforeEach(() => {
	_clearVoiceSessions();
	_clearXpWriter();
	mocks.awardXp.mockReset().mockResolvedValue(undefined);
	mocks.getLevelingConfig.mockReset().mockResolvedValue(context());
});

describe("GATE 1, the approved channel list", () => {
	it("pays NOBODY when the list is empty, which is the shipped default", () => {
		// The opposite polarity from every other list in the config, and deliberate:
		// a guild that never configures voice never has a voice farming surface. If
		// this ever inverts to "empty means all", a self bot earns from day one in
		// every guild on the platform.
		expect(settings().voice.approvedChannels).toEqual(["v-approved"]);
	});

	it("pays nothing in a channel that is not on the list", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ approvedChannels: [] }));
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] }]);

		await sweepTwice(client, MINUTE);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("ignores an unapproved channel while paying an approved one", async () => {
		const client = buildClient([
			{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] },
			{ id: "v-other", members: [{ id: "u3" }, { id: "u4" }] },
		]);

		await sweepTwice(client, MINUTE);

		const paid = mocks.awardXp.mock.calls.map((call) => (call[0] as { userId: string }).userId);
		expect(paid.sort()).toEqual(["u1", "u2"]);
	});

	it("ignores a channel that is not a voice channel at all", async () => {
		const client = buildClient([
			{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }], type: ChannelType.GuildText },
		]);
		await sweepTwice(client, MINUTE);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});
});

describe("GATE 2, the minimum headcount", () => {
	it("pays nothing to a member sitting alone", async () => {
		// The simplest farm there is, and the reason a 24/7 self bot works against
		// most competitors.
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }] }]);
		await sweepTwice(client, MINUTE);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("does not count bots toward the headcount", async () => {
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "music-bot", bot: true }] }]);
		await sweepTwice(client, MINUTE);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("starts paying once a second human joins", async () => {
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] }]);
		await sweepTwice(client, MINUTE);
		expect(mocks.awardXp).toHaveBeenCalledTimes(2);
	});
});

describe("GATE 3, actually participating", () => {
	it.each([
		["self muted", { selfMute: true }],
		["self deafened", { selfDeaf: true }],
		["server muted", { serverMute: true }],
		["server deafened", { serverDeaf: true }],
	])("pays nothing to a %s member", async (_label, state) => {
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1", ...state }, { id: "u2" }] }]);
		await sweepTwice(client, MINUTE);

		const paid = mocks.awardXp.mock.calls.map((call) => (call[0] as { userId: string }).userId);
		expect(paid).not.toContain("u1");
		expect(paid).toContain("u2");
	});

	it("pays nothing to a restricted role, in voice as anywhere else", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({}, { restrictedRoles: ["role-muted"] }));
		const client = buildClient([
			{ id: "v-approved", members: [{ id: "u1", roleIds: ["role-muted"] }, { id: "u2" }] },
		]);
		await sweepTwice(client, MINUTE);

		const paid = mocks.awardXp.mock.calls.map((call) => (call[0] as { userId: string }).userId);
		expect(paid).toEqual(["u2"]);
	});
});

describe("GATE 4, the anti idle decay", () => {
	it("pays full rate inside the decay window", async () => {
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] }]);
		await sweepTwice(client, MINUTE);
		expect(amountOf()).toBe(5); // perMinute 5, one minute elapsed
	});

	it("cuts the award once a continuous session runs long", async () => {
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] }]);
		const start = 1_000_000;

		await sweepVoiceXp(client, start); // session opens
		await sweepVoiceXp(client, start + 121 * MINUTE); // past decayAfterMinutes

		// Capped at VOICE_MAX_MINUTES_PER_AWARD (5) then multiplied by decayFactor
		// (0.25): 5 perMinute * 5 minutes * 0.25 = 6.
		expect(amountOf()).toBe(6);
	});

	it("caps a single award so a paused process cannot hand out a lump sum", async () => {
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] }]);
		const start = 1_000_000;

		await sweepVoiceXp(client, start);
		await sweepVoiceXp(client, start + 60 * MINUTE);

		// An hour of wall clock, but only five minutes are payable.
		expect(amountOf()).toBe(25);
		expect((mocks.awardXp.mock.calls[0][0] as { counters: { voiceMinutes: number } }).counters.voiceMinutes).toBe(5);
	});
});

describe("session bookkeeping", () => {
	it("pays nothing on the FIRST sighting, only starting the clock", async () => {
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] }]);
		await sweepVoiceXp(client, 1_000_000);

		expect(mocks.awardXp).not.toHaveBeenCalled();
		expect(_voiceSessionCount()).toBe(2);
	});

	it("pays nothing when less than a full minute has elapsed", async () => {
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] }]);
		await sweepTwice(client, 30_000);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("drops the session of a member who left, so their decay clock restarts", async () => {
		const populated = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] }]);
		await sweepVoiceXp(populated, 1_000_000);
		expect(_voiceSessionCount()).toBe(2);

		const emptied = buildClient([{ id: "v-approved", members: [] }]);
		await sweepVoiceXp(emptied, 1_000_000 + MINUTE);
		expect(_voiceSessionCount()).toBe(0);
	});
});

describe("the enabled gates", () => {
	it("pays nothing when leveling is off", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({}, { enabled: false }));
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] }]);
		await sweepTwice(client, MINUTE);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("pays nothing when voice xp specifically is off", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ enabled: false }));
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] }]);
		await sweepTwice(client, MINUTE);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("keeps sweeping other guilds when one throws", async () => {
		mocks.getLevelingConfig.mockRejectedValue(new Error("mongo is down"));
		const client = buildClient([{ id: "v-approved", members: [{ id: "u1" }, { id: "u2" }] }]);
		await expect(sweepVoiceXp(client, 1_000_000)).resolves.toBeUndefined();
	});
});
