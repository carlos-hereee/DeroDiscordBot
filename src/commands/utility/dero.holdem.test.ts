import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";

// ── /dero tell: a table request ────────────────────────────────────────────
// When the brain answers with open_holdem, the private reply of /dero tell IS
// the rules card (its buttons are how the member answers), and any other
// action's line rides in a second embed below it. A request that is already gone
// falls back to the ordinary list of lines.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	log: vi.fn(),
	enqueue: vi.fn(),
	isBrainOnline: vi.fn(),
	executeActions: vi.fn(),
	buildJobInput: vi.fn(),
	rulesCardFor: vi.fn(),
}));

// The admin role read is a GuildConfig lookup; null keeps these suites on the allowlist only rule.
vi.mock("@features/dero-brain/speakerAdminRole.js", () => ({ readSpeakerAdminRoleId: vi.fn(async () => null) }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log } }));
vi.mock("@features/dero-brain/brainQueue.js", () => ({ brainQueue: { enqueue: mocks.enqueue, isBrainOnline: mocks.isBrainOnline } }));
vi.mock("@features/dero-brain/executor.js", () => ({ executeActions: mocks.executeActions }));
vi.mock("@features/dero-brain/brainJob.js", () => ({ buildJobInput: mocks.buildJobInput }));
vi.mock("@features/dero-brain/holdemRulesCard.js", () => ({ rulesCardFor: mocks.rulesCardFor }));

import { execute } from "./dero.js";

const GUILD_ID = "g1";
const ROLE = "role-taskers";
const CONFIG = { guildId: GUILD_ID, enabled: true, allowedRoleIds: [ROLE], allowedChannelIds: ["c1"] };
const CARD_EMBED = new EmbedBuilder().setTitle("🃏 A Texas Hold'em table").setDescription("Custom rules");
const CARD = { embeds: [CARD_EMBED], components: [{ kind: "buttons" }] };
const TABLE_REPORT = { type: "open_holdem", outcome: "rules_card", line: "rules question", holdemRequestId: "req-1" };

let userCounter = 0;

function interactionFor() {
	const editReply = vi.fn(async () => undefined);
	const interaction = {
		guildId: GUILD_ID,
		inCachedGuild: () => true,
		guild: { id: GUILD_ID, ownerId: "owner", name: "Guild" },
		member: { id: `user-${++userCounter}`, displayName: "Member", guild: { id: GUILD_ID }, roles: { cache: new Set([ROLE]) } },
		options: { getSubcommand: () => "tell", getString: () => "create a Texas Hold'em table, max 6 players, 5000 chips, big blind 200" },
		replied: false,
		deferred: false,
		reply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply,
	} as unknown as ChatInputCommandInteraction;
	return { interaction, editReply };
}

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue(CONFIG);
	mocks.log.mockReset().mockResolvedValue(undefined);
	mocks.isBrainOnline.mockReset().mockReturnValue(true);
	mocks.buildJobInput.mockReset().mockReturnValue({ text: "x", channels: [] });
	mocks.enqueue.mockReset().mockReturnValue({
		jobId: "job-1",
		outcome: Promise.resolve({ kind: "result", result: { jobId: "job-1", status: "ok", actions: [{ type: "open_holdem" }] } }),
	});
	mocks.rulesCardFor.mockReset().mockResolvedValue(CARD);
});

describe("/dero tell with a table request", () => {
	it("replaces the reply with the rules card", async () => {
		mocks.executeActions.mockResolvedValue([TABLE_REPORT]);
		const { interaction, editReply } = interactionFor();
		await execute(interaction);
		expect(mocks.rulesCardFor).toHaveBeenCalledWith(interaction.guild, "req-1");
		expect(editReply).toHaveBeenCalledWith({ embeds: [CARD_EMBED], components: CARD.components });
	});

	it("keeps any other action's line in a second embed below the card", async () => {
		mocks.executeActions.mockResolvedValue([TABLE_REPORT, { type: "post_message", outcome: "posted", line: "Posted in <#c1>." }]);
		const { interaction, editReply } = interactionFor();
		await execute(interaction);
		const payload = editReply.mock.calls[0][0] as unknown as { embeds: EmbedBuilder[]; components: unknown[] };
		expect(payload.embeds[0]).toBe(CARD_EMBED);
		expect(payload.embeds[1].data.description).toBe("Posted in <#c1>.");
		expect(payload.components).toBe(CARD.components);
	});

	it("falls back to the plain lines when the request is already gone", async () => {
		mocks.executeActions.mockResolvedValue([TABLE_REPORT]);
		mocks.rulesCardFor.mockResolvedValue(null);
		const { interaction, editReply } = interactionFor();
		await execute(interaction);
		const payload = editReply.mock.calls[0][0] as unknown as { embeds: EmbedBuilder[]; components?: unknown[] };
		expect(payload.embeds[0].data.description).toBe("rules question");
		expect(payload.components).toBeUndefined();
	});
});
