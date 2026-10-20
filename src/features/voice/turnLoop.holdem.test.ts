import { describe, it, expect, vi } from "vitest";
import type { Guild, GuildMember } from "discord.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import type { BrainTurnResult } from "@features/dero-brain/brainTurn.js";
import type { ActionReport } from "@features/dero-brain/executor.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { createLatencyLog } from "./turnLatency.js";
import { createTurnLoop, type TurnLoopDeps, type TurnTarget } from "./turnLoop.js";

// ── turn loop: a table asked for by voice ─────────────────────────────────
// When the brain answers a spoken "open a Hold'em table" with open_holdem, the
// loop posts the rules card in the call's text channel BEFORE Dero speaks, so
// the card is there when Dero asks "these rules or custom ones, public or invite
// only?", and the question itself is the executor's line, spoken as usual.

const GUILD_ID = "g1";
const SPEAKER_ID = "member-1";
const CONFIG = { guildId: GUILD_ID, enabled: true, voiceId: "voice-123", allowedRoleIds: ["taskers"], allowedChannelIds: [] } as unknown as IDeroVoiceConfig;
const RULES_LINE =
	"Custom rules: up to 6 players, 5000 chips each, blinds 100 and 200, and the blinds double every 6 hands. Do you want these rules or custom ones, and a public table or an invite only one? Choose on the rules card.";

function rig(reports: ActionReport[]) {
	const order: string[] = [];
	const speak = vi.fn(() => {
		order.push("spoke");
		return "playing" as const;
	});
	const presentHoldemCard = vi.fn(async () => {
		order.push("card");
		return true;
	});
	const audit = vi.fn();
	const guild = { id: GUILD_ID, ownerId: "owner", channels: { cache: new Map() } } as unknown as Guild;
	const deps: TurnLoopDeps = {
		now: () => 10_000,
		loadConfig: vi.fn(async () => CONFIG),
		findMember: vi.fn(async () => ({ id: SPEAKER_ID, guild: { id: GUILD_ID }, roles: { cache: new Set(["taskers"]) } }) as unknown as GuildMember),
		reserve: vi.fn(async () => ({ status: "ok" as const, reservation: { guildId: GUILD_ID, month: "2026-10", cents: 1, ttsChars: 0, sttSeconds: 2 } })),
		refund: vi.fn(async () => undefined),
		stt: { modelId: "scribe_v2", transcribe: vi.fn(async () => ({ text: "Dero, create a Texas Hold'em table, max 6 players, 5000 chips, big blind 200" })) },
		runTurn: vi.fn(async (): Promise<BrainTurnResult> => ({ status: "answered", jobId: "job-1", offeredChannels: 0, actions: [], reports, resultAt: 10_000 })),
		render: vi.fn(async ({ text }: { text: string }) => ({ status: "ok" as const, pcm48kStereo: Buffer.from(text), cached: false })),
		postNotice: vi.fn(async () => undefined),
		audit,
		latency: createLatencyLog(),
		troubleCooldown: new CooldownManager(30_000),
		presentHoldemCard,
	};
	const target: TurnTarget = {
		guild,
		channelId: "vc-1",
		controlChannelId: "text-1",
		speaker: { speak, lastOwnLineEndedAt: null } as unknown as TurnTarget["speaker"],
	};
	return { deps, target, speak, presentHoldemCard, audit, order, guild };
}

const utterance = () => ({ speakerId: SPEAKER_ID, pcm48kStereo: Buffer.alloc(2000 * 192), durationMs: 2000, speechEndedAt: 10_000 });

describe("a voice ask for a hold em table", () => {
	it("posts the rules card in the call's text channel, then speaks the rules and the question", async () => {
		const setup = rig([{ type: "open_holdem", outcome: "rules_card", line: RULES_LINE, holdemRequestId: "req-1" }]);
		createTurnLoop(setup.target, setup.deps).submit(utterance());
		await vi.waitFor(() => expect(setup.audit).toHaveBeenCalledTimes(1));

		expect(setup.presentHoldemCard).toHaveBeenCalledWith({ guild: setup.guild, requestId: "req-1", controlChannelId: "text-1" });
		expect(setup.order).toEqual(["card", "spoke"]);
		expect(String((setup.speak.mock.calls[0] as unknown[])[0])).toBe(RULES_LINE);
	});

	it("posts no card for an answer that asked for no table", async () => {
		const setup = rig([{ type: "post_message", outcome: "posted", line: "Posted in general." }]);
		createTurnLoop(setup.target, setup.deps).submit(utterance());
		await vi.waitFor(() => expect(setup.audit).toHaveBeenCalledTimes(1));
		expect(setup.presentHoldemCard).not.toHaveBeenCalled();
	});
});
