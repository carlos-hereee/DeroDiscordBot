import { describe, it, expect, vi } from "vitest";
import { ChannelType, type Guild, type GuildMember } from "discord.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import type { VoiceSessionView } from "@features/voice/voiceSessions.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { executeActions, neutralizeMassMentions, SAFE_MENTIONS, type ExecutorDeps, type ExecutorVoiceDeps } from "./executor.js";
import { parseBrainResult } from "./parseBrainResult.js";
import { deroBrainCopy } from "./deroBrainCopy.js";
import type { BrainAction } from "./brainTypes.js";
import { getHoldemRequest } from "./holdemRequests.js";

// ── executor ───────────────────────────────────────────────────────────────
// Two halves. The matrix: every reason a post_message is refused, the honest
// stubs, and the one way a post goes out (no pings). The injection set: hostile
// brain outputs run through the real pipeline (parse, then execute) against a
// fake guild that counts its Discord API calls, and every one ends with ZERO.
//
// What counts as an API call: fetching a member and sending a message. Reading
// the guild's channel cache is local memory, not a call.

const GUILD_ID = "100000000000000001";
const OTHER_GUILD_ID = "100000000000000002";
const OWNER_ID = "300000000000000001";
const SPEAKER_ID = "300000000000000002";
const BOT_ID = "300000000000000009";
const TASKER_ROLE = "400000000000000001";

const GENERAL = "200000000000000001";
const NOT_LISTED = "200000000000000002";
const FOREIGN = "200000000000000003";
const NO_SEND = "200000000000000004";
const HIDDEN = "200000000000000005";
const VOICE = "200000000000000006";
const JOB_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

interface FakeChannelSpec {
	id: string;
	name: string;
	guildId?: string;
	type?: ChannelType;
	botCanSend?: boolean;
	speakerCanView?: boolean;
}

function fakeChannel({ id, name, guildId = GUILD_ID, type = ChannelType.GuildText, botCanSend = true, speakerCanView = true }: FakeChannelSpec) {
	return {
		id,
		name,
		guildId,
		type,
		send: vi.fn(async () => ({ id: "message-1" })),
		permissionsFor: (who: { id: string }) => ({ has: () => (who.id === BOT_ID ? botCanSend : speakerCanView) }),
	};
}

function fakeMember(id: string, roleIds: string[]) {
	return { id, displayName: "Member", guild: { id: GUILD_ID }, roles: { cache: new Set(roleIds) } };
}

function fakeWorld(speakerRoles: string[] = [TASKER_ROLE]) {
	const channels = [
		fakeChannel({ id: GENERAL, name: "general" }),
		fakeChannel({ id: NOT_LISTED, name: "secret-plans" }),
		fakeChannel({ id: FOREIGN, name: "elsewhere", guildId: OTHER_GUILD_ID }),
		fakeChannel({ id: NO_SEND, name: "read-only", botCanSend: false }),
		fakeChannel({ id: HIDDEN, name: "staff", speakerCanView: false }),
		fakeChannel({ id: VOICE, name: "lounge", type: ChannelType.GuildVoice }),
	];
	const cache = new Map(channels.map((channel) => [channel.id, channel]));
	const guild = { id: GUILD_ID, ownerId: OWNER_ID, name: "Guild", channels: { cache }, members: { me: { id: BOT_ID } } };
	const speaker = fakeMember(SPEAKER_ID, speakerRoles);
	const fetchMember = vi.fn(async () => speaker as unknown as GuildMember);
	const deps: ExecutorDeps = { fetchMember };
	const sends = () => channels.reduce((total, channel) => total + channel.send.mock.calls.length, 0);
	const apiCalls = () => fetchMember.mock.calls.length + sends();
	return { guild: guild as unknown as Guild, channels: cache, fetchMember, deps, apiCalls, sends };
}

const CONFIG: IDeroVoiceConfig = {
	guildId: GUILD_ID,
	enabled: true,
	voiceId: "voice1234567890",
	listenEnabled: true,
	allowedRoleIds: [TASKER_ROLE],
	allowedChannelIds: [GENERAL, FOREIGN, NO_SEND, HIDDEN, VOICE],
	allowedVoiceChannelIds: [],
	monthlyCapUsd: 25,
};

const post = (channelId: string, text = "hello world 👋"): BrainAction => ({ type: "post_message", channelId, text });

async function run(actions: BrainAction[], world = fakeWorld(), voiceConfig: IDeroVoiceConfig | null = CONFIG) {
	const reports = await executeActions({ guild: world.guild, speakerId: SPEAKER_ID, actions, voiceConfig, deps: world.deps });
	return { reports, world };
}

describe("executeActions: post_message", () => {
	it("posts in an allowlisted channel with every ping disabled", async () => {
		const { reports, world } = await run([post(GENERAL)]);
		expect(reports).toEqual([{ type: "post_message", outcome: "posted", line: `Posted in <#${GENERAL}>.` }]);
		expect(world.channels.get(GENERAL)?.send).toHaveBeenCalledWith({ content: "hello world 👋", allowedMentions: SAFE_MENTIONS });
		expect(SAFE_MENTIONS).toEqual({ parse: [], users: [], roles: [], repliedUser: false });
	});

	it("defuses @everyone and @here in anything that reaches a send", async () => {
		const { world } = await run([post(GENERAL, "hi @everyone and @here")]);
		expect(world.channels.get(GENERAL)?.send).toHaveBeenCalledWith({
			content: "hi @​everyone and @​here",
			allowedMentions: SAFE_MENTIONS,
		});
	});

	it("refuses a channel that is not allowlisted with zero API calls", async () => {
		const { reports, world } = await run([post(NOT_LISTED)]);
		expect(reports[0].outcome).toBe("channel_not_allowed");
		expect(world.apiCalls()).toBe(0);
	});

	it("never resolves a channel by name", async () => {
		const { reports, world } = await run([post("general")]);
		expect(reports[0].outcome).toBe("channel_not_allowed");
		expect(world.apiCalls()).toBe(0);
	});

	it("refuses a channel from another guild even when its id is allowlisted", async () => {
		const { reports, world } = await run([post(FOREIGN)]);
		expect(reports[0].outcome).toBe("channel_unavailable");
		expect(world.sends()).toBe(0);
	});

	it("refuses an allowlisted id that no longer resolves", async () => {
		const world = fakeWorld();
		world.channels.delete(GENERAL);
		const { reports } = await run([post(GENERAL)], world);
		expect(reports[0].outcome).toBe("channel_unavailable");
		expect(world.sends()).toBe(0);
	});

	it("refuses a voice channel", async () => {
		const { reports, world } = await run([post(VOICE)]);
		expect(reports[0].outcome).toBe("channel_unavailable");
		expect(world.sends()).toBe(0);
	});

	it("refuses when the bot lacks permission to send", async () => {
		const { reports, world } = await run([post(NO_SEND)]);
		expect(reports[0].outcome).toBe("bot_lacks_permission");
		expect(world.sends()).toBe(0);
	});

	it("refuses a channel the speaker cannot see", async () => {
		const { reports, world } = await run([post(HIDDEN)]);
		expect(reports[0].outcome).toBe("channel_not_visible");
		expect(world.sends()).toBe(0);
	});

	it("re-fetches the speaker and refuses when they lost the role after the job was made", async () => {
		const world = fakeWorld([]);
		const { reports } = await run([post(GENERAL)], world);
		expect(world.fetchMember).toHaveBeenCalledWith(world.guild, SPEAKER_ID);
		expect(reports[0].outcome).toBe("not_authorized");
		expect(world.sends()).toBe(0);
	});

	it("refuses when the speaker left the guild", async () => {
		const world = fakeWorld();
		world.fetchMember.mockResolvedValueOnce(null as unknown as GuildMember);
		const { reports } = await run([post(GENERAL)], world);
		expect(reports[0].outcome).toBe("not_authorized");
		expect(world.sends()).toBe(0);
	});

	it("reports a failed send without throwing and without the text in the log", async () => {
		const world = fakeWorld();
		world.channels.get(GENERAL)?.send.mockRejectedValueOnce(Object.assign(new Error("Missing Access"), { code: 50001 }));
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { reports } = await run([post(GENERAL, "a private plan")], world);
		expect(reports[0].outcome).toBe("send_failed");
		expect(errorLog.mock.calls.flat().join(" ")).not.toContain("a private plan");
		errorLog.mockRestore();
	});
});

describe("executeActions: the rest", () => {
	// Replaced in Phase 4 (owner approved): open_holdem is no longer a stub. It
	// makes a pending rules card request and opens nothing; the card's buttons are
	// the only way a table opens.
	it("turns open_holdem into a rules card request, opens nothing and sends nothing", async () => {
		const { reports, world } = await run([{ type: "open_holdem", maxSeats: 6, startingStack: 5000, bigBlind: 200 }]);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({ type: "open_holdem", outcome: "rules_card" });
		expect(reports[0].line).toContain("Custom rules: up to 6 players, 5000 chips each, blinds 100 and 200, and the blinds double every 6 hands.");
		expect(getHoldemRequest(reports[0].holdemRequestId ?? "")).toMatchObject({
			guildId: GUILD_ID,
			speakerId: SPEAKER_ID,
			visibility: "public",
			terms: { maxSeats: 6, startingStack: 5000, smallBlind: 100, bigBlind: 200 },
		});
		expect(world.sends()).toBe(0);
		expect(world.fetchMember).toHaveBeenCalledTimes(1);
	});

	it("refuses open_holdem from a member off the task list and makes no request", async () => {
		const { reports } = await run([{ type: "open_holdem" }], fakeWorld([]));
		expect(reports).toEqual([{ type: "open_holdem", outcome: "not_authorized", line: deroBrainCopy.result.notAuthorized }]);
	});

	it("answers say and leave_voice with no call open plainly, with zero API calls", async () => {
		const world = fakeWorld();
		world.deps.voice = fakeVoice(null).voice;
		const { reports } = await run([{ type: "say", text: "hi" }, { type: "leave_voice" }], world);
		expect(reports).toEqual([
			{ type: "say", outcome: "no_call", line: deroBrainCopy.result.sayNoCall },
			{ type: "leave_voice", outcome: "no_call", line: deroBrainCopy.result.leaveNoCall },
		]);
		expect(world.apiCalls()).toBe(0);
	});

	it("does nothing when voice was switched off before execution", async () => {
		const { reports, world } = await run([post(GENERAL)], fakeWorld(), { ...CONFIG, enabled: false });
		expect(reports[0].outcome).toBe("switched_off");
		expect(world.apiCalls()).toBe(0);
	});

	it("does nothing with a missing config or one for another guild", async () => {
		expect((await run([post(GENERAL)], fakeWorld(), null)).reports[0].outcome).toBe("switched_off");
		const foreign = await run([post(GENERAL)], fakeWorld(), { ...CONFIG, guildId: OTHER_GUILD_ID });
		expect(foreign.reports[0].outcome).toBe("switched_off");
		expect(foreign.world.apiCalls()).toBe(0);
	});

	it("lets the guild owner post without an allowlisted role", async () => {
		const world = fakeWorld([]);
		world.fetchMember.mockResolvedValueOnce({ ...fakeMember(OWNER_ID, []) } as unknown as GuildMember);
		const reports = await executeActions({ guild: world.guild, speakerId: OWNER_ID, actions: [post(GENERAL)], voiceConfig: CONFIG, deps: world.deps });
		expect(reports[0].outcome).toBe("posted");
	});
});

// ── say and leave_voice, against a fake open call ──

const VOICE_CHANNEL = "200000000000000007";
const PCM = Buffer.from([1, 2, 3, 4]);

function fakeVoice(session: VoiceSessionView | null) {
	const sessionIn = vi.fn((_guildId: string) => session);
	const leave = vi.fn((_guildId: string) => session !== null);
	const render = vi.fn(async () => ({ status: "ok" as const, pcm48kStereo: PCM, cached: false }));
	const voice: ExecutorVoiceDeps = { sessionIn, leave, render };
	return { voice, sessionIn, leave, render };
}

function openCall(speakResult = "playing") {
	const speak = vi.fn(() => speakResult);
	const session = { guildId: GUILD_ID, channelId: VOICE_CHANNEL, controlChannelId: GENERAL, status: "ready", speaker: { speak } };
	return { session: session as unknown as VoiceSessionView, speak };
}

function worldWithCall(speakerRoles: string[] = [TASKER_ROLE], speakResult = "playing") {
	const world = fakeWorld(speakerRoles);
	const call = openCall(speakResult);
	const fake = fakeVoice(call.session);
	world.deps.voice = fake.voice;
	return { world, ...fake, speak: call.speak };
}

describe("executeActions: say", () => {
	it("renders the line in the guild's voice and queues it at brain priority", async () => {
		const { world, render, speak } = worldWithCall();
		const { reports } = await run([{ type: "say", text: "hello world" }], world);

		expect(reports).toEqual([{ type: "say", outcome: "spoke", line: deroBrainCopy.result.spoke }]);
		expect(render).toHaveBeenCalledWith({ guildId: GUILD_ID, voiceId: CONFIG.voiceId, text: "hello world" });
		expect(speak).toHaveBeenCalledWith(PCM, "brain");
		expect(world.fetchMember).toHaveBeenCalledTimes(1);
		expect(world.sends()).toBe(0);
	});

	it("re-authorizes the speaker and renders nothing for one who lost the role", async () => {
		const { world, render, speak } = worldWithCall([]);
		const { reports } = await run([{ type: "say", text: "hello" }], world);
		expect(reports[0].outcome).toBe("not_authorized");
		expect(render).not.toHaveBeenCalled();
		expect(speak).not.toHaveBeenCalled();
	});

	it.each([
		["at the monthly cap", { status: "capReached" }, "cap_reached", deroBrainCopy.result.sayCapReached],
		["when the provider fails", { status: "failed", kind: "providerDown" }, "voice_failed", deroBrainCopy.result.sayFailed],
	])("stays quiet %s and says why", async (_label, result, outcome, line) => {
		const { world, render, speak } = worldWithCall();
		render.mockResolvedValueOnce(result as never);
		const { reports } = await run([{ type: "say", text: "hello" }], world);
		expect(reports[0]).toEqual({ type: "say", outcome, line });
		expect(speak).not.toHaveBeenCalled();
	});

	it("says nothing without a voice id, with no render", async () => {
		const { world, render } = worldWithCall();
		const { reports } = await run([{ type: "say", text: "hello" }], world, { ...CONFIG, voiceId: null });
		expect(reports[0].outcome).toBe("not_set_up");
		expect(render).not.toHaveBeenCalled();
	});

	it("drops a line whose call ended while it rendered", async () => {
		const { world, sessionIn, render, speak } = worldWithCall();
		const live = sessionIn.getMockImplementation() as (guildId: string) => VoiceSessionView | null;
		let ended = false;
		sessionIn.mockImplementation((guildId: string) => (ended ? null : live(guildId)));
		render.mockImplementationOnce(async () => {
			ended = true;
			return { status: "ok", pcm48kStereo: PCM, cached: false };
		});
		const { reports } = await run([{ type: "say", text: "hello" }], world);
		expect(reports[0].outcome).toBe("no_call");
		expect(speak).not.toHaveBeenCalled();
	});

	it("reports a full speaker queue", async () => {
		const { world } = worldWithCall([TASKER_ROLE], "dropped");
		const { reports } = await run([{ type: "say", text: "hello" }], world);
		expect(reports[0]).toEqual({ type: "say", outcome: "queue_full", line: deroBrainCopy.result.sayQueueFull });
	});

	it("does nothing when voice was switched off before execution", async () => {
		const { world, render } = worldWithCall();
		const { reports } = await run([{ type: "say", text: "hello" }], world, { ...CONFIG, enabled: false });
		expect(reports[0].outcome).toBe("switched_off");
		expect(render).not.toHaveBeenCalled();
		expect(world.apiCalls()).toBe(0);
	});
});

describe("executeActions: leave_voice", () => {
	it("ends the guild's call for an authorized speaker and names the channel", async () => {
		const { world, leave } = worldWithCall();
		const { reports } = await run([{ type: "leave_voice" }], world);
		expect(leave).toHaveBeenCalledWith(GUILD_ID);
		expect(reports).toEqual([{ type: "leave_voice", outcome: "left_call", line: voiceCopy.call.left(VOICE_CHANNEL) }]);
	});

	it("refuses a speaker who is not authorized and leaves the call alone", async () => {
		const { world, leave } = worldWithCall([]);
		const { reports } = await run([{ type: "leave_voice" }], world);
		expect(reports[0].outcome).toBe("not_authorized");
		expect(leave).not.toHaveBeenCalled();
	});
});

describe("neutralizeMassMentions", () => {
	it("breaks every casing of @everyone and @here and leaves other text alone", () => {
		expect(neutralizeMassMentions("@everyone @Here @HERE")).toBe("@​everyone @​Here @​HERE");
		expect(neutralizeMassMentions("mail me at dero@company")).toBe("mail me at dero@company");
	});
});

// ── injection set ──────────────────────────────────────────────────────────
// Each body below is what a steered or broken brain might send. The pipeline is
// the real one: parseBrainResult, and only if it passes, executeActions. Every
// case must end with nothing posted and no Discord API call made.

const wrap = (actions: unknown[], extra: Record<string, unknown> = {}) => ({ jobId: JOB_ID, status: "ok", actions, ...extra });

const HOSTILE: Array<[string, unknown]> = [
	["a post to a channel id not on the allowlist", wrap([post(NOT_LISTED)])],
	["a post naming a channel instead of an id", wrap([{ type: "post_message", channel: "general", text: "hi" }])],
	["a post with a channel name in the id field", wrap([post("general")])],
	["@everyone text", wrap([post(GENERAL, "@everyone the raid is now")])],
	["@here text", wrap([post(GENERAL, "@here come look")])],
	["role mention text", wrap([post(GENERAL, `<@&${TASKER_ROLE}> wake up`)])],
	["user mention text", wrap([post(GENERAL, `<@${OWNER_ID}> hi boss`)])],
	["a four action result", wrap([post(GENERAL), { type: "say", text: "a" }, { type: "leave_voice" }, { type: "open_holdem" }])],
	["two posts", wrap([post(GENERAL, "one"), post(GENERAL, "two")])],
	["an unknown action type", wrap([{ type: "ban_member", userId: OWNER_ID }])],
	["an extra key on an action", wrap([{ ...post(GENERAL), allowedMentions: { parse: ["everyone"] } }])],
	["an extra key choosing a guild", wrap([post(GENERAL)], { guildId: OTHER_GUILD_ID })],
	["a __proto__ key", JSON.parse(`{"jobId":"${JOB_ID}","status":"ok","actions":[],"__proto__":{"isAdmin":true}}`)],
	["a constructor key inside an action", wrap([{ type: "leave_voice", constructor: { prototype: {} } }])],
	["string numbers", wrap([{ type: "open_holdem", maxSeats: "6", startingStack: "5000" }])],
	["text of 5000 characters", wrap([post(GENERAL, "a".repeat(5000))])],
	["an open_holdem with an absurd stack", wrap([{ type: "open_holdem", startingStack: 1_000_000_000_000 }])],
	["negative numbers", wrap([{ type: "open_holdem", maxSeats: -6, bigBlind: -200 }])],
	["nested JSON as the text", wrap([{ type: "post_message", channelId: GENERAL, text: { type: "post_message", channelId: NOT_LISTED } }])],
	["a JSON action list inside the text", wrap([post(GENERAL, `[{"type":"post_message","channelId":"${NOT_LISTED}","text":"x"}]`)])],
	["actions riding a busy status", { jobId: JOB_ID, status: "busy", actions: [post(GENERAL)] }],
];

describe("injection set", () => {
	it("holds at least twelve hostile outputs", () => {
		expect(HOSTILE.length).toBeGreaterThanOrEqual(12);
	});

	it.each(HOSTILE)("rejects %s with zero Discord API calls", async (_label, body) => {
		const world = fakeWorld();
		const parsed = parseBrainResult(body);
		if (parsed.ok) {
			const reports = await executeActions({
				guild: world.guild,
				speakerId: SPEAKER_ID,
				actions: parsed.value.actions,
				voiceConfig: CONFIG,
				deps: world.deps,
			});
			expect(reports.every((entry) => entry.outcome !== "posted")).toBe(true);
		}
		expect(world.apiCalls()).toBe(0);
	});
});

// ── injection set, Phase 5 additions ───────────────────────────────────────
// The set above re-runs as written against the final executor. These are the
// cases Phase 5 adds: hold em terms the brain made up, a channel the brain tried
// to choose for a table, an extra key, a say carrying a mention or 5000
// characters, and a speaker whose role was removed after the job was made.
// A body the parser refuses makes ZERO Discord API calls. A body it accepts may
// make exactly one, the fresh read of the speaker that IS the re-check, and
// never a send, a render or a table.

const PARSER_REFUSES: Array<[string, unknown]> = [
	["an open_holdem with absurd terms", wrap([{ type: "open_holdem", maxSeats: 99, startingStack: 5, bigBlind: 10_000 }])],
	["an open_holdem whose big blind outweighs its stack", wrap([{ type: "open_holdem", startingStack: 1000, bigBlind: 900 }])],
	["an open_holdem carrying a channel name instead of an id", wrap([{ type: "open_holdem", channelId: "general" }])],
	["an open_holdem with an extra key choosing a guild", wrap([{ type: "open_holdem", maxSeats: 6, guildId: OTHER_GUILD_ID }])],
	["an open_holdem with an extra key choosing who is invited", wrap([{ type: "open_holdem", invitedIds: [OWNER_ID] }])],
	["a say with a role mention", wrap([{ type: "say", text: `<@&${TASKER_ROLE}> everybody listen` }])],
	["a say with a user mention", wrap([{ type: "say", text: `<@${OWNER_ID}> come here` }])],
	["a say with @everyone", wrap([{ type: "say", text: "@everyone listen up" }])],
	["a say of 5000 characters", wrap([{ type: "say", text: "a".repeat(5000) }])],
];

describe("injection set, Phase 5 additions", () => {
	it.each(PARSER_REFUSES)("refuses %s at the parser, with zero Discord API calls", async (_label, body) => {
		const { world, render, speak } = worldWithCall();
		const parsed = parseBrainResult(body);
		expect(parsed.ok).toBe(false);
		expect(world.apiCalls()).toBe(0);
		expect(render).not.toHaveBeenCalled();
		expect(speak).not.toHaveBeenCalled();
	});

	it.each([
		["not on the allowlist", NOT_LISTED],
		["in another guild", FOREIGN],
	])("ignores a channel id %s on open_holdem: a card request only, nothing sent anywhere", async (_label, channelId) => {
		const world = fakeWorld();
		const parsed = parseBrainResult(wrap([{ type: "open_holdem", channelId }]));
		if (!parsed.ok) throw new Error(`parser refused: ${parsed.reason}`);
		const reports = await executeActions({ guild: world.guild, speakerId: SPEAKER_ID, actions: parsed.value.actions, voiceConfig: CONFIG, deps: world.deps });

		expect(reports[0]).toMatchObject({ outcome: "rules_card" });
		// The card is the member's to answer; the brain's channel is not on it.
		expect(getHoldemRequest(reports[0].holdemRequestId ?? "")).toMatchObject({ controlChannelId: null, speakerId: SPEAKER_ID });
		expect(world.sends()).toBe(0);
		expect(world.fetchMember).toHaveBeenCalledTimes(1);
	});

	it("stops every action of a speaker whose role was removed after the job was made", async () => {
		// The job was made while the speaker held the role; the fresh read shows it gone.
		const { world, render, speak } = worldWithCall([]);
		const parsed = parseBrainResult(wrap([post(GENERAL), { type: "say", text: "hello" }, { type: "open_holdem" }]));
		if (!parsed.ok) throw new Error(`parser refused: ${parsed.reason}`);
		const reports = await executeActions({ guild: world.guild, speakerId: SPEAKER_ID, actions: parsed.value.actions, voiceConfig: CONFIG, deps: world.deps });

		expect(reports.map((entry) => entry.outcome)).toEqual(["not_authorized", "not_authorized", "not_authorized"]);
		expect(reports.every((entry) => entry.holdemRequestId === undefined)).toBe(true);
		expect(world.sends()).toBe(0);
		expect(world.fetchMember).toHaveBeenCalledTimes(1);
		expect(render).not.toHaveBeenCalled();
		expect(speak).not.toHaveBeenCalled();
	});
});
