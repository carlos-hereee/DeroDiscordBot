import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { ButtonInteraction, GuildMember } from "discord.js";

// ── the voice rooms' Join, Leave and Status ─────────────────────────────────
// The three buttons run /dero's own join, leave and status handlers, so they are
// gated exactly as /dero is: the task list check in authorizer.isAuthorizedSpeaker.
// The handlers here are the REAL ones from commands/utility/dero.ts; only the
// stores, the call sessions and the join notice are mocked, as dero.voice.test.ts
// mocks them, so a refusal below is the command's own refusal.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	sessionGet: vi.fn(),
	sessionJoin: vi.fn(),
	sessionLeave: vi.fn(),
	announceJoin: vi.fn(),
	buttons: new Map<string, (interaction: unknown) => Promise<void>>(),
}));

// The admin role read is a GuildConfig lookup; null keeps these suites on the allowlist only rule.
vi.mock("@features/dero-brain/speakerAdminRole.js", () => ({ readSpeakerAdminRoleId: vi.fn(async () => null) }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@features/voice/voiceSessions.js", () => ({
	voiceSessions: { get: mocks.sessionGet, join: mocks.sessionJoin, leave: mocks.sessionLeave },
}));
vi.mock("@features/voice/joinNotice.js", () => ({ announceJoin: mocks.announceJoin }));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: unknown) => Promise<void>) => mocks.buttons.set(prefix, handler),
}));

import { registerVoiceRoomControlHandlers } from "./voiceRoomControlHandlers.js";
import { buildVoiceRoomControlRow, voiceRoomActionOf } from "./voiceRoomControls.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { commandButtonsCopy } from "@features/command-buttons/commandButtonsCopy.js";

const GUILD_ID = "g1";
const OWNER_ID = "owner";
const TASK_ROLE = "role-taskers";
const VOICE_CHANNEL = "vc-hall";

interface Replied {
	embeds?: Array<{ data: { description?: string; title?: string } }>;
	content?: string;
}

function memberWith(roles: string[]): GuildMember {
	return {
		id: "member",
		guild: { id: GUILD_ID },
		roles: { cache: new Set(roles) },
		voice: { channel: { id: VOICE_CHANNEL, permissionsFor: () => ({ has: () => true }) } },
	} as unknown as GuildMember;
}

function press(action: string, member: GuildMember) {
	const reply = vi.fn(async (_payload: Replied) => undefined);
	const interaction = {
		customId: `dero_call:${action}`,
		guildId: GUILD_ID,
		channelId: VOICE_CHANNEL,
		guild: { id: GUILD_ID, ownerId: OWNER_ID, members: { me: { id: "bot" } }, channels: { cache: new Map() } },
		member,
		user: { id: member.id },
		inCachedGuild: () => true,
		replied: false,
		deferred: false,
		reply,
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	};
	return { interaction: interaction as unknown as ButtonInteraction, reply };
}

const firstReply = (reply: ReturnType<typeof vi.fn>): Replied => reply.mock.calls[0]?.[0] as Replied;

beforeAll(() => {
	registerVoiceRoomControlHandlers();
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId.mockResolvedValue({
		guildId: GUILD_ID,
		enabled: true,
		voiceId: null,
		allowedRoleIds: [TASK_ROLE],
		allowedChannelIds: [],
		allowedVoiceChannelIds: [VOICE_CHANNEL],
	});
	mocks.sessionGet.mockReturnValue(undefined);
});

describe("the voice room row", () => {
	it("is Join, Leave and Status on the dero_call prefix", () => {
		const row = buildVoiceRoomControlRow({ joinLabel: "Join", leaveLabel: "Leave", statusLabel: "Status" }).toJSON();
		expect((row.components as Array<{ custom_id: string }>).map((button) => button.custom_id)).toEqual([
			"dero_call:join",
			"dero_call:leave",
			"dero_call:status",
		]);
	});

	it("reads only the actions it knows", () => {
		expect(voiceRoomActionOf("dero_call:join")).toBe("join");
		expect(voiceRoomActionOf("dero_call:dance")).toBeNull();
	});
});

describe("gated as /dero is, by the task list", () => {
	it("refuses Join from a member who is not on the task list, and joins nothing", async () => {
		const { interaction, reply } = press("join", memberWith([]));
		await mocks.buttons.get("dero_call")!(interaction);
		expect(firstReply(reply).embeds?.[0]?.data.description).toBe(deroBrainCopy.tell.notAuthorized);
		expect(mocks.sessionJoin).not.toHaveBeenCalled();
	});

	it("refuses Leave from a member who is not on the task list, and leaves nothing", async () => {
		mocks.sessionGet.mockReturnValue({ channelId: VOICE_CHANNEL });
		const { interaction, reply } = press("leave", memberWith([]));
		await mocks.buttons.get("dero_call")!(interaction);
		expect(firstReply(reply).embeds?.[0]?.data.description).toBe(deroBrainCopy.tell.notAuthorized);
		expect(mocks.sessionLeave).not.toHaveBeenCalled();
	});

	it("lets a member on the task list send Dero away", async () => {
		mocks.sessionGet.mockReturnValue({ channelId: VOICE_CHANNEL });
		const { interaction } = press("leave", memberWith([TASK_ROLE]));
		await mocks.buttons.get("dero_call")!(interaction);
		expect(mocks.sessionLeave).toHaveBeenCalledWith(GUILD_ID);
	});

	it("answers Status for anyone, privately", async () => {
		const { interaction, reply } = press("status", memberWith([]));
		await mocks.buttons.get("dero_call")!(interaction);
		expect(firstReply(reply).embeds?.[0]?.data.title).toBe(deroBrainCopy.status.title);
	});

	it("answers a button from an older layout quietly", async () => {
		const { interaction, reply } = press("dance", memberWith([TASK_ROLE]));
		await mocks.buttons.get("dero_call")!(interaction);
		expect(firstReply(reply).content).toBe(commandButtonsCopy.launcher.staleButton);
	});
});
