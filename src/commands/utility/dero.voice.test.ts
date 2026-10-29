import { describe, it, expect, vi, beforeEach } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
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
	postNotice: vi.fn(async () => undefined),
}));

// The admin role read is a GuildConfig lookup; null keeps these suites on the allowlist only rule.
vi.mock("@features/dero-brain/speakerAdminRole.js", () => ({ readSpeakerAdminRoleId: vi.fn(async () => null) }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@features/voice/voiceSessions.js", () => ({
	voiceSessions: { get: mocks.sessionGet, join: mocks.sessionJoin, leave: mocks.sessionLeave },
}));
vi.mock("@features/voice/joinNotice.js", () => ({ announceJoin: mocks.announceJoin, postVoiceNotice: mocks.postNotice }));
// The queue reads the Meeting Hall and Arcade Lounge ids from GuildConfig.
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: { findByGuildId: vi.fn(async () => ({ meetingVoiceChannelId: "vc-meeting", arcadeVoiceChannelId: "vc-lounge" })) },
}));

import { checkJoin, execute, runQueuedJoin, type JoinGateInput } from "./dero.js";
import { voiceQueue, type VoiceQueueRequest } from "@features/voice/voiceQueue.js";
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
		adminRoleId: null,
		botMember: BOT,
		config: configFor("g1") as unknown as JoinGateInput["config"],
		sessionChannelId: null,
		...overrides,
	};
}

const configWith = (overrides: Record<string, unknown>) => configFor("g1", overrides) as unknown as JoinGateInput["config"];

describe("checkJoin, the /dero join gates", () => {
	it.each([
		["with no config", { config: null }, voiceCopy.listen.notSetUp, "notSetUp"],
		["when the kill switch is off", { config: configWith({ enabled: false }) }, deroBrainCopy.tell.switchedOff, "switchedOff"],
		["for a member who is not authorized", { speaker: memberFor("g1", { roles: [], channel: voiceChannel(VC).channel }) }, deroBrainCopy.tell.notAuthorized, "notAuthorized"],
		["for a member who is not in a voice channel", { speaker: memberFor("g1") }, call.notInVoice, "notInVoice"],
		["when Dero is already in this channel", { sessionChannelId: VC }, call.alreadyHere(VC), "alreadyHere"],
		["for a channel that is not allowlisted", { speaker: memberFor("g1", { channel: voiceChannel("vc-unlisted").channel }) }, call.channelNotAllowed, "channelNotAllowed"],
		["when the bot lacks permission", { speaker: memberFor("g1", { channel: voiceChannel(VC, false).channel }) }, call.botLacksPermission, "botLacksPermission"],
		["when the bot's own member is not cached", { botMember: null }, call.botLacksPermission, "botLacksPermission"],
	])("refuses %s", (_label, overrides, line, reason) => {
		expect(checkJoin(gateInput(overrides as Partial<JoinGateInput>))).toEqual({ ok: false, line, reason });
	});

	// The voice queue (2026-10 item 257, owner item 22): a request that passes every
	// gate while Dero is in another call waits rather than being refused.
	it("queues, never refuses, a join that passes every gate while Dero is in another channel", () => {
		const { channel } = voiceChannel(VC);
		expect(checkJoin(gateInput({ speaker: memberFor("g1", { channel }), sessionChannelId: "vc-other" }))).toEqual({
			ok: false,
			queue: true,
			channel,
			sessionChannelId: "vc-other",
		});
	});

	it("refuses rather than queues a join that would fail a gate even once Dero is free", () => {
		const gate = checkJoin(gateInput({ speaker: memberFor("g1", { channel: voiceChannel("vc-unlisted").channel }), sessionChannelId: "vc-other" }));
		expect(gate).toEqual({ ok: false, line: call.channelNotAllowed, reason: "channelNotAllowed" });
	});

	it("lets the guild owner through without a role", () => {
		const gate = checkJoin(gateInput({ speaker: memberFor("g1", { id: OWNER_ID, roles: [], channel: voiceChannel(VC).channel }) }));
		expect(gate.ok).toBe(true);
	});

	// Rows saved before the default voice existed store null, which must not refuse.
	it("joins with Dero's default voice when the row stored no voice id", () => {
		const { channel } = voiceChannel(VC);
		const gate = checkJoin(gateInput({ speaker: memberFor("g1", { channel }), config: configWith({ voiceId: null }) }));
		expect(gate).toEqual({ ok: true, channel, voiceId: BOT_CONSTANTS.DERO_DEFAULT_VOICE_ID });
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

function interactionFor(sub: "join" | "leave" | "status", options: { roles?: string[]; inVoice?: boolean; guildId?: string } = {}) {
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
	// A state's private fallback is its plain text since Phase 1c (owner rule 1); an answer is an embed.
	const call0 = mock.mock.calls[0] as unknown as [{ embeds?: EmbedBuilder[]; content?: string }];
	if (call0[0].content) return call0[0].content;
	const embed = call0[0].embeds![0];
	return `${embed.data.title ?? ""}\n${embed.data.description ?? ""}`;
}

const SPEAKER = { speak: vi.fn() };

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockImplementation(async (guildId: string) => configFor(guildId));
	mocks.sessionGet.mockReset().mockReturnValue(null);
	mocks.sessionJoin.mockReset().mockResolvedValue({ status: "joined", session: { channelId: VC, speaker: SPEAKER }, readyMs: 900 });
	mocks.sessionLeave.mockReset().mockReturnValue(true);
	mocks.announceJoin.mockReset().mockResolvedValue("greeted");
	mocks.postNotice.mockClear();
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
		const showModal = vi.fn(async (_modal: { toJSON(): { title: string; components: Array<{ content?: string }> } }) => undefined);
		Object.assign(second.interaction, { showModal });
		await execute(second.interaction);
		// A cooldown is a state: Dero's own title, never the error title (2026-10 item 263 R3-12).
		const notice = showModal.mock.calls[0]![0].toJSON();
		expect(notice.title).toBe(deroBrainCopy.noticeTitle);
		expect(notice.components.map((component) => component.content).join("\n")).toContain("Try /dero join again in");
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

describe("/dero status", () => {
	it("says where Dero is in a call, to any member", async () => {
		mocks.sessionGet.mockReturnValue({ channelId: VC });
		const { interaction, reply } = interactionFor("status", { roles: [] });
		await execute(interaction);
		expect(textOf(reply)).toContain(call.statusInCall(VC));
	});

	it("says Dero is not in a call when there is none", async () => {
		const { interaction, reply } = interactionFor("status");
		await execute(interaction);
		expect(textOf(reply)).toContain(call.notInCall);
	});
});

// ── the voice queue (2026-10 item 257 Phase 2b, owner item 22) ──

describe("/dero join while Dero is in another call", () => {
	it("queues the request with its place, joins nothing, and /dero status lists it", async () => {
		mocks.sessionGet.mockReturnValue({ channelId: "vc-busy" });
		const first = interactionFor("join");
		await execute(first.interaction);
		expect(mocks.sessionJoin).not.toHaveBeenCalled();
		expect(first.deferReply).not.toHaveBeenCalled();
		expect(textOf(first.reply)).toContain(call.queued(1, 1, "vc-busy"));

		const second = interactionFor("join", { guildId: first.guildId });
		const secondChannel = voiceChannel(VC).channel;
		(second.interaction as unknown as { member: GuildMember }).member = memberFor(first.guildId, { id: "member-2", channel: secondChannel });
		await execute(second.interaction);
		expect(textOf(second.reply)).toContain(call.queued(2, 2, "vc-busy"));

		const status = interactionFor("status", { guildId: first.guildId });
		await execute(status.interaction);
		expect(textOf(status.reply)).toContain(call.queueTitle);
		expect(textOf(status.reply)).toContain(call.queueLine(1, "member", VC, "other"));
	});
});

describe("runQueuedJoin, the queue's runner", () => {
	function requestFor(options: { inChannel?: string | null } = {}): VoiceQueueRequest {
		const { channel } = voiceChannel(VC);
		const member = { ...memberFor("g-run", { channel }), voice: { channel, channelId: options.inChannel === undefined ? VC : options.inChannel } };
		const guild = {
			id: "g-run",
			ownerId: OWNER_ID,
			members: { me: BOT, cache: new Map([["member", member]]), fetch: vi.fn(async () => null) },
		};
		return { guild, requesterId: "member", channelId: VC, controlChannelId: "text-9", category: "other", requestedAt: 0 } as unknown as VoiceQueueRequest;
	}

	it("joins the requester's channel and posts the join notice where the request came from", async () => {
		await expect(runQueuedJoin(requestFor())).resolves.toBe("joined");
		expect(mocks.sessionJoin).toHaveBeenCalledWith(expect.objectContaining({ controlChannelId: "text-9" }));
		expect(mocks.announceJoin).toHaveBeenCalledWith(expect.objectContaining({ controlChannelId: "text-9", voiceChannelId: VC }));
	});

	it("skips a request whose member is no longer in that voice channel", async () => {
		await expect(runQueuedJoin(requestFor({ inChannel: "vc-elsewhere" }))).resolves.toBe("skipped");
		expect(mocks.sessionJoin).not.toHaveBeenCalled();
	});

	it("skips a request once voice is switched off", async () => {
		mocks.findByGuildId.mockImplementation(async (guildId: string) => configFor(guildId, { enabled: false }));
		await expect(runQueuedJoin(requestFor())).resolves.toBe("skipped");
	});

	it("keeps the request's place when Dero is in a call again", async () => {
		mocks.sessionGet.mockReturnValue({ channelId: "vc-busy" });
		await expect(runQueuedJoin(requestFor())).resolves.toBe("busy");
		expect(mocks.sessionJoin).not.toHaveBeenCalled();
	});

	// ── a game's request (2026-10 item 267, decision 11) ──
	// A challenge card or a room's referee: no task speaker list, the host need not be in the
	// Lounge, but the switch and the allow list still hold, and a refused join says why.
	function gameRequestFor(options: { target?: string; followsHost?: boolean; hostIn?: string | null } = {}): VoiceQueueRequest {
		const target = options.target ?? VC;
		const { channel } = voiceChannel(target);
		const host = { ...memberFor("g-game", { id: "host", roles: [] }), voice: { channelId: options.hostIn ?? null } };
		const guild = {
			id: "g-game",
			ownerId: OWNER_ID,
			members: { me: BOT, cache: new Map([["host", host]]), fetch: vi.fn(async () => null) },
			channels: { cache: new Map([[target, { ...channel, isVoiceBased: () => true }]]) },
		};
		return {
			guild,
			requesterId: "host",
			channelId: target,
			controlChannelId: "card-ch",
			category: "casual-match",
			requestedAt: 0,
			gameVoice: { roomId: "room-1", followsHost: options.followsHost ?? false, subject: "card" },
		} as unknown as VoiceQueueRequest;
	}

	it("joins for a host on no task list, into the Lounge, and keeps the card as the call's starter", async () => {
		await expect(runQueuedJoin(gameRequestFor())).resolves.toBe("joined");
		expect(mocks.sessionJoin).toHaveBeenCalledWith(expect.objectContaining({ controlChannelId: "card-ch", startedByRoomId: "room-1" }));
		expect(mocks.postNotice).not.toHaveBeenCalled();
	});

	it("joins nothing for a channel off the allow list, and says why on the card's channel", async () => {
		await expect(runQueuedJoin(gameRequestFor({ target: "vc-unlisted" }))).resolves.toBe("skipped");
		expect(mocks.sessionJoin).not.toHaveBeenCalled();
		expect(mocks.postNotice).toHaveBeenCalledWith(expect.anything(), "card-ch", voiceCopy.gameVoice.couldNotJoin("vc-unlisted", "channelNotAllowed"));
	});

	it("still honours the voice switch for a game, and says so", async () => {
		mocks.findByGuildId.mockImplementation(async (guildId: string) => configFor(guildId, { enabled: false }));
		await expect(runQueuedJoin(gameRequestFor())).resolves.toBe("skipped");
		expect(mocks.postNotice).toHaveBeenCalledWith(expect.anything(), "card-ch", voiceCopy.gameVoice.couldNotJoin(VC, "switchedOff"));
	});

	it("skips a host call request once the host left that call, and says so", async () => {
		await expect(runQueuedJoin(gameRequestFor({ followsHost: true, hostIn: "vc-other" }))).resolves.toBe("skipped");
		expect(mocks.postNotice).toHaveBeenCalledWith(expect.anything(), "card-ch", voiceCopy.gameVoice.couldNotJoin(VC, "hostLeft"));
	});

	it("is what the queue singleton runs", () => {
		expect(typeof voiceQueue.useRunner).toBe("function");
	});
});
