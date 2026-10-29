import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";

// ── /dero plan (2026-10 item 262) ──────────────────────────────────────────
// The promises: only the guild owner gets a code; every owner gets one, covered servers too
// (it is also the way to a fresh code for the dashboard's pairing panel); the reply is private;
// only an uncovered server is pitched the plan; the code is logged as a pairing code sent.

const mocks = vi.hoisted(() => ({
	issue: vi.fn(),
	isServerCovered: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@db/stores/pendingPairingStore.js", () => ({ pendingPairingStore: { issue: mocks.issue }, PAIRING_CODE_TTL_MS: 15 * 60 * 1000 }));
vi.mock("@features/entitlements/serverPlanAccess.js", () => ({ isServerCovered: mocks.isServerCovered }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log } }));
vi.mock("@features/dero-brain/speakerAdminRole.js", () => ({ readSpeakerAdminRoleId: vi.fn(async () => null) }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: vi.fn(async () => null) } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn(async () => null) } }));

import { MessageFlags } from "discord.js";
import { execute } from "./dero.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { serverPlanCommandCopy } from "@features/entitlements/serverPlanCopy.js";

const GUILD_ID = "g1";
const OWNER_ID = "owner";
const CODE = "ABC234";

function interactionFor(userId: string, cached = true) {
	const reply = vi.fn(async () => undefined);
	const deferReply = vi.fn(async () => undefined);
	const editReply = vi.fn(async () => undefined);
	const interaction = {
		guildId: cached ? GUILD_ID : null,
		inCachedGuild: () => cached,
		guild: { id: GUILD_ID, ownerId: OWNER_ID, name: "Guild" },
		user: { id: userId },
		member: { id: userId },
		options: { getSubcommand: () => "plan" },
		replied: false,
		deferred: false,
		reply,
		deferReply,
		editReply,
	} as unknown as ChatInputCommandInteraction;
	return { interaction, reply, deferReply, editReply };
}

function embedText(mock: ReturnType<typeof vi.fn>): string {
	const call = mock.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[] }];
	const embed = call[0].embeds[0];
	return `${embed.data.title ?? ""}\n${embed.data.description ?? ""}`;
}

function replyText(mock: ReturnType<typeof vi.fn>): string {
	return (mock.mock.calls[0] as unknown as [{ content: string }])[0].content;
}

beforeEach(() => {
	mocks.issue.mockReset().mockResolvedValue(CODE);
	mocks.isServerCovered.mockReset().mockResolvedValue(false);
	mocks.log.mockReset().mockResolvedValue(undefined);
});

describe("/dero plan", () => {
	it("refuses a member who is not the guild owner, and issues nothing", async () => {
		const { interaction, reply, deferReply } = interactionFor("someone-else");
		await execute(interaction);

		expect(replyText(reply)).toContain(serverPlanCommandCopy.ownerOnly);
		expect(deferReply).not.toHaveBeenCalled();
		expect(mocks.issue).not.toHaveBeenCalled();
		expect(mocks.log).not.toHaveBeenCalled();
	});

	it("refuses outside a server", async () => {
		const { interaction, reply } = interactionFor(OWNER_ID, false);
		await execute(interaction);
		expect(replyText(reply)).toContain(serverPlanCommandCopy.notInGuild);
		expect(mocks.issue).not.toHaveBeenCalled();
	});

	it("gives the owner of an uncovered server a private code and the plan link", async () => {
		const { interaction, deferReply, editReply } = interactionFor(OWNER_ID);
		await execute(interaction);

		expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		expect(mocks.issue).toHaveBeenCalledWith(GUILD_ID, OWNER_ID);
		const text = embedText(editReply);
		expect(text).toContain(CODE);
		expect(text).toContain("15 minutes");
		expect(text).toContain("replaces any older code");
		expect(text).toContain("Connect your Discord server");
		expect(text).toContain(BOT_CONSTANTS.DERO_SERVER_PLAN_URL);
		expect(mocks.log).toHaveBeenCalledWith(GUILD_ID, BOT_LOG_EVENTS.PAIRING_CODE_SENT, { ownerId: OWNER_ID, source: "dero_plan" });
	});

	it("still issues a code for a covered server, with no buy pitch", async () => {
		mocks.isServerCovered.mockResolvedValue(true);
		const { interaction, editReply } = interactionFor(OWNER_ID);
		await execute(interaction);

		expect(mocks.issue).toHaveBeenCalledWith(GUILD_ID, OWNER_ID);
		const text = embedText(editReply);
		expect(text).toContain(CODE);
		expect(text).toContain(serverPlanCommandCopy.covered);
		expect(text).not.toContain(BOT_CONSTANTS.DERO_SERVER_PLAN_URL);
	});

	it("says so privately when the code cannot be made, and logs nothing", async () => {
		mocks.issue.mockRejectedValue(new Error("mongo down"));
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { interaction, editReply } = interactionFor(OWNER_ID);
		await execute(interaction);

		expect(embedText(editReply)).toContain(serverPlanCommandCopy.failed);
		expect(mocks.log).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("keeps the code even when the audit write fails", async () => {
		mocks.log.mockRejectedValue(new Error("log down"));
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { interaction, editReply } = interactionFor(OWNER_ID);
		await execute(interaction);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(editReply).toHaveBeenCalledTimes(1);
		expect(embedText(editReply)).toContain(CODE);
		error.mockRestore();
	});
});
