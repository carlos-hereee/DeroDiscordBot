import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, RepliableInteraction } from "discord.js";

// ── the age gate's answers (2026-11 item 302) ────────────────────────────────
// A decline takes two presses and then stays: no prompt left open, no other server and no
// admin role reaches it, because the row is keyed by the Discord user alone.

const mocks = vi.hoisted(() => ({
	findByUserId: vi.fn(),
	accept: vi.fn(),
	decline: vi.fn(),
	buttons: new Map<string, (interaction: ButtonInteraction) => Promise<void>>(),
}));

vi.mock("@db/stores/ageConfirmationStore.js", () => ({
	ageConfirmationStore: { findByUserId: mocks.findByUserId, accept: mocks.accept, decline: mocks.decline },
}));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: ButtonInteraction) => Promise<void>) => mocks.buttons.set(prefix, handler),
}));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { AGE_GATE_PREFIX, hasConfirmedAge, isAgeConfirmed, registerAgeGateHandlers, replyWithAgeGate } from "./ageGateRules.js";

const words = rokCommanderCopy.ageGate;
const VERSION = BOT_CONSTANTS.AGE_GATE.CONFIRMATION_VERSION;
const MEMBER = "member-1";

const press = (arg: string, extra: Record<string, unknown> = {}) => {
	const update = vi.fn();
	return { update, interaction: { customId: `${AGE_GATE_PREFIX}:${arg}`, user: { id: MEMBER }, update, ...extra } as unknown as ButtonInteraction };
};
const run = async (arg: string, extra?: Record<string, unknown>) => {
	const { update, interaction } = press(arg, extra);
	await mocks.buttons.get(AGE_GATE_PREFIX)?.(interaction);
	return update;
};
const buttonIdsOf = (update: ReturnType<typeof vi.fn>): string[] => {
	const payload = update.mock.calls[0]?.[0] as { components: { components: { data: { custom_id: string } }[] }[] };
	return payload.components.flatMap((row) => row.components.map((button) => button.data.custom_id));
};
const blockedPayload = { content: words.blocked, embeds: [], components: [] };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByUserId.mockResolvedValue(null);
	mocks.accept.mockResolvedValue(true);
	mocks.decline.mockResolvedValue(undefined);
	registerAgeGateHandlers();
});

describe("isAgeConfirmed", () => {
	it("reads no row, a stale confirmation and any decline as not confirmed", () => {
		expect(isAgeConfirmed(null)).toBe(false);
		expect(isAgeConfirmed({ status: "confirmed", termsVersion: VERSION - 1 })).toBe(false);
		expect(isAgeConfirmed({ status: "declined", termsVersion: VERSION + 100 })).toBe(false);
		expect(isAgeConfirmed({ status: "confirmed", termsVersion: VERSION })).toBe(true);
	});
});

describe("a decline takes a second press", () => {
	it("saves nothing on I'm under 18 and shows the confirm step", async () => {
		const update = await run("no");
		expect(mocks.decline).not.toHaveBeenCalled();
		expect(buttonIdsOf(update)).toEqual([`${AGE_GATE_PREFIX}:noConfirm`, `${AGE_GATE_PREFIX}:back`]);
	});

	it("goes back to the prompt without saving", async () => {
		const update = await run("back");
		expect(mocks.decline).not.toHaveBeenCalled();
		expect(mocks.accept).not.toHaveBeenCalled();
		expect(buttonIdsOf(update)).toEqual([`${AGE_GATE_PREFIX}:yes`, `${AGE_GATE_PREFIX}:no`]);
	});

	it("saves the decline on the confirm and shows the block with who to contact", async () => {
		const update = await run("noConfirm");
		expect(mocks.decline).toHaveBeenCalledWith(MEMBER, VERSION, expect.any(Date));
		expect(update).toHaveBeenCalledWith(blockedPayload);
		expect(words.blocked).toContain("support@companyuno.com");
	});
});

describe("a decline stays locked", () => {
	it("answers a yes the store refused with the block, never the confirmed line", async () => {
		mocks.accept.mockResolvedValue(false);
		const update = await run("yes");
		expect(update).toHaveBeenCalledWith(blockedPayload);
	});

	it.each(["no", "back"])("shows a declined member the block on a stale %s press", async (arg) => {
		mocks.findByUserId.mockResolvedValue({ status: "declined", termsVersion: VERSION });
		const update = await run(arg);
		expect(update).toHaveBeenCalledWith(blockedPayload);
	});

	it("follows the member to a server they own, as an admin, keyed by their user id alone", async () => {
		mocks.findByUserId.mockResolvedValue({ status: "declined", termsVersion: VERSION });
		const reply = vi.fn();
		const interaction = { user: { id: MEMBER }, guildId: "their-own-server", memberPermissions: { has: () => true }, deferred: false, replied: false, reply };
		await replyWithAgeGate(interaction as unknown as RepliableInteraction);
		expect(await hasConfirmedAge(MEMBER)).toBe(false);
		expect(mocks.findByUserId).toHaveBeenCalledWith(MEMBER);
		expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: words.blocked }));
		expect(reply.mock.calls[0]?.[0]).not.toHaveProperty("embeds.0");
	});
});

describe("a yes", () => {
	it("confirms and asks the member to run the command again", async () => {
		const update = await run("yes");
		expect(update).toHaveBeenCalledWith({ content: words.confirmedPressAgain, embeds: [], components: [] });
	});
});
