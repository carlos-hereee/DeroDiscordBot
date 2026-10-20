import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits, type ChatInputCommandInteraction, type EmbedBuilder, type GuildMember } from "discord.js";

// ── /dero join and /dero leave ─────────────────────────────────────────────
// The voice half of /dero, split from dero.test.ts by concern like
// ChannelContent.arcade.test.ts. The join gate matrix runs against the pure
// checkJoin; the command cases prove a refused join touches no session and
// burns no cooldown, a successful one posts the notice and greets, a silent
// greeting still reports a join, and leave needs an authorized member but not
// the kill switch.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	sessionGet: vi.fn(),
	sessionJoin: vi.fn(),
	sessionLeave: vi.fn(),
	announceJoin: vi.fn(),
}));

vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@features/voice/voiceSessions.js", () => ({
	voiceSessions: { get: mocks.sessionGet, join: mocks.sessionJoin, leave: mocks.sessionLeave },
}));
vi.mock("@features/voice/joinNotice.js", () => ({ announceJoin: mocks.announceJoin }));

import { checkJoin, execute, type JoinGateInput } from "./dero.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";

const OWNER_ID = "owner";
const ROLE = "role-taskers";
const VOICE_ID = "abcDEF1234567890wxyz";
const VC = "vc-allowed";
const call = voiceCopy.call;

function configFor(guildId: string, overrides: Record<string, unknown> = {}) {
	return {
		guildId,
		enabled: true,
		voiceId: VOICE_ID,
		allowedRoleIds: [ROLE],
		allowedVoiceChannelIds: [VC],
		...overrides,
	};
}

function voiceChannel(id: string, botMayUse = true) {
	const has = vi.fn(() => botMayUse);
	return { channel: { id, permissionsFor: vi.fn(() => ({ has })) }, has };
}

function memberFor(guildId: string, options: { id?: string; roles?: string[]; channel?: unknown } = {}) {
	return {
		id: options.id ?? "member",
		displayName: "Member",
		guild: { id: guildId },
		roles: { cache: new Set(options.roles ?? [ROLE]) },
		voice: { channel: options.channel ?? null },
	} as unknown as GuildMember;
}

const BOT = { id: "bot" } as unknown as GuildMember;

// ── the gate matrix ──

function gateInput(overrides: Partial<JoinGateInput> = {}): JoinGateInput {
	return {
		speaker: memberFor("g1", { channel: voiceChannel(VC).channel }),
		guildOwnerId: OWNER_ID,
		botMember: BOT,
		config: configFor("g1") as unknown as JoinGateInput["config"],
		sessionChannelId: null,
		...overrides,
	};
}

const configWith = (overrides: Record<string, unknown>) => configFor("g1", overrides) as unknown as JoinGateInput["config"];

describe("checkJoin, the /dero join gates", () => {
	it.each([
		["with no config", { config: null }, voiceCopy.listen.notSetUp],
		["when the kill switch is off", { config: configWith({ enabled: false }) }, deroBrainCopy.tell.switchedOff],
		["with no voice id", { config: configWith({ voiceId: null }) }, voiceCopy.listen.notSetUp],
		["for a member who is not authorized", { speaker: memberFor("g1", { roles: [], channel: voiceChannel(VC).channel }) }, deroBrainCopy.tell.notAuthorized],
		["for a member who is not in a voice channel", { speaker: memberFor("g1") }, call.notInVoice],
		["when Dero is already in another channel", { sessionChannelId: "vc-other" }, call.alreadyElsewhere("vc-other")],
		["when Dero is already in this channel", { sessionChannelId: VC }, call.alreadyHere(VC)],
		["for a channel that is not allowlisted", { speaker: memberFor("g1", { channel: voiceChannel("vc-unlisted").channel }) }, call.channelNotAllowed],
		["when the bot lacks permission", { speaker: memberFor("g1", { channel: voiceChannel(VC, false).channel }) }, call.botLacksPermission],
		["when the bot's own member is not cached", { botMember: null }, call.botLacksPermission],
	])("refuses %s", (_label, overrides, line) => {
		expect(checkJoin(gateInput(overrides as Partial<JoinGateInput>))).toEqual({ ok: false, line });
	});

	it("lets the guild owner through without a role", () => {
		const gate = checkJoin(gateInput({ speaker: memberFor("g1", { id: OWNER_ID, roles: [], channel: voiceChannel(VC).channel }) }));
		expect(gate.ok).toBe(true);
	});

	it("passes the speaker's own channel and checks view, connect and speak for the bot", () => {
		const { channel, has } = voiceChannel(VC);
		const gate = checkJoin(gateInput({ speaker: memberFor("g1", { channel }) }));
		expect(gate).toEqual({ ok: true, channel, voiceId: VOICE_ID });
		expect(channel.permissionsFor).toHaveBeenCalledWith(BOT);
		expect(has).toHaveBeenCalledWith([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]);
	});
});

// ── the command ──

let guildCounter = 0;

function interactionFor(sub: "join" | "leave", options: { roles?: string[]; inVoice?: boolean; guildId?: string } = {}) {
	// A fresh guild per call unless a test pins one, so the module level join
	// cooldown (keyed by guild) never leaks from one test into the next.
	const guildId = options.guildId ?? `guild-${++guildCounter}`;
	const reply = vi.fn(async () => undefined);
	const deferReply = vi.fn(async () => undefined);
	const editReply = vi.fn(async () => undefined);
	const { channel } = voiceChannel(VC);
	const guild = { id: guildId, ownerId: OWNER_ID, members: { me: BOT } };
	const interaction = {
		guildId,
		channelId: "text-1",
		inCachedGuild: () => true,
		guild,
		member: memberFor(guildId, { roles: options.roles, channel: options.inVoice === false ? null : channel }),
		options: { getSubcommand: () => sub },
		replied: false,
		deferred: false,
		reply,
		deferReply,
		editReply,
	} as unknown as ChatInputCommandInteraction;
	return { interaction, reply, deferReply, editReply, guild, channel, guildId };
}

function textOf(mock: ReturnType<typeof vi.fn>): string {
	const call0 = mock.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[] }];
	const embed = call0[0].embeds[0];
	return `${embed.data.title ?? ""}\n${embed.data.description ?? ""}`;
}

const SPEAKER = { speak: vi.fn() };

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockImplementation(async (guildId: string) => configFor(guildId));
	mocks.sessionGet.mockReset().mockReturnValue(null);
	mocks.sessionJoin.mockReset().mockResolvedValue({ status: "joined", session: { channelId: VC, speaker: SPEAKER }, readyMs: 900 });
	mocks.sessionLeave.mockReset().mockReturnValue(true);
	mocks.announceJoin.mockReset().mockResolvedValue("greeted");
});

describe("/dero join", () => {
	it("joins the speaker's channel, posts the notice in the command's channel and greets", async () => {
		const { interaction, deferReply, editReply, guild, channel } = interactionFor("join");
		await execute(interaction);

		expect(deferReply).toHaveBeenCalledTimes(1);
		expect(mocks.sessionJoin).toHaveBeenCalledWith({ guild, channel, controlChannelId: "text-1" });
		expect(mocks.announceJoin).toHaveBeenCalledWith({
			guild,
			controlChannelId: "text-1",
			voiceChannelId: VC,
			voiceId: VOICE_ID,
			speaker: SPEAKER,
		});
		expect(textOf(editReply)).toContain(call.joined.greeted(VC));
	});

	it("still reports the join when the greeting was refused, and says why it is silent", async () => {
		mocks.announceJoin.mockResolvedValue("capReached");
		const { interaction, editReply } = interactionFor("join");
		await execute(interaction);
		expect(textOf(editReply)).toContain(call.joined.capReached(VC));
	});

	it("refuses through the gates with no session touched and no cooldown burned", async () => {
		const { interaction, reply, deferReply, guildId } = interactionFor("join", { roles: [] });
		await execute(interaction);
		expect(textOf(reply)).toContain(deroBrainCopy.tell.notAuthorized);
		expect(deferReply).not.toHaveBeenCalled();
		expect(mocks.sessionJoin).not.toHaveBeenCalled();

		const retry = interactionFor("join", { guildId });
		await execute(retry.interaction);
		expect(mocks.sessionJoin).toHaveBeenCalledTimes(1);
	});

	it("names the channel when the connection never came up, and does not greet", async () => {
		mocks.sessionJoin.mockResolvedValue({ status: "failed", reason: "ready_timeout" });
		const { interaction, editReply } = interactionFor("join");
		await execute(interaction);
		expect(textOf(editReply)).toContain(call.connectFailed(VC));
		expect(mocks.announceJoin).not.toHaveBeenCalled();
	});

	it("allows one join attempt per guild in the cooldown window, failed or not", async () => {
		mocks.sessionJoin.mockResolvedValue({ status: "failed", reason: "ready_timeout" });
		const first = interactionFor("join");
		await execute(first.interaction);

		const second = interactionFor("join", { guildId: first.guildId });
		await execute(second.interaction);
		expect(textOf(second.reply)).toContain("Try /dero join again in");
		expect(mocks.sessionJoin).toHaveBeenCalledTimes(1);
	});
});

describe("/dero leave", () => {
	it("ends the guild's call and names the channel it left", async () => {
		mocks.sessionGet.mockReturnValue({ channelId: VC });
		const { interaction, reply, guildId } = interactionFor("leave");
		await execute(interaction);
		expect(mocks.sessionLeave).toHaveBeenCalledWith(guildId);
		expect(textOf(reply)).toContain(call.left(VC));
	});

	it("works with the kill switch off, because leaving is always safe", async () => {
		mocks.findByGuildId.mockImplementation(async (guildId: string) => configFor(guildId, { enabled: false }));
		mocks.sessionGet.mockReturnValue({ channelId: VC });
		const { interaction } = interactionFor("leave");
		await execute(interaction);
		expect(mocks.sessionLeave).toHaveBeenCalledTimes(1);
	});

	it("refuses a member who is not authorized and leaves the call alone", async () => {
		mocks.sessionGet.mockReturnValue({ channelId: VC });
		const { interaction, reply } = interactionFor("leave", { roles: [] });
		await execute(interaction);
		expect(textOf(reply)).toContain(deroBrainCopy.tell.notAuthorized);
		expect(mocks.sessionLeave).not.toHaveBeenCalled();
	});

	it("says so when Dero is not in a call", async () => {
		const { interaction, reply } = interactionFor("leave");
		await execute(interaction);
		expect(textOf(reply)).toContain(call.notInCall);
		expect(mocks.sessionLeave).not.toHaveBeenCalled();
	});
});
