import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

// ── the Enter a code door ───────────────────────────────────────────────────
// The button on #command-center must reach the same redeem as /secret-code, so a code never
// works through one door and not the other. Which words each outcome reaches is
// commands/fun/secret-code.test.ts.

const mocks = vi.hoisted(() => ({ redeemGift: vi.fn(), redeemLuck: vi.fn(), handlers: new Map<string, (interaction: never) => Promise<void>>() }));

vi.mock("@features/economy/chipGift.js", () => ({ redeemChipGift: mocks.redeemGift }));
vi.mock("@features/fortune/secretCodes.js", () => ({ redeemCode: mocks.redeemLuck }));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: never) => Promise<void>) => mocks.handlers.set(prefix, handler),
	registerModal: (prefix: string, handler: (interaction: never) => Promise<void>) => mocks.handlers.set(prefix, handler),
}));

import { buildEnterCodeButton, registerSecretCodeHandlers } from "./secretCodeEntry.js";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.redeemGift.mockResolvedValue({ status: "none" });
	mocks.redeemLuck.mockResolvedValue({ status: "invalid" });
	registerSecretCodeHandlers();
});

describe("the Enter a code button", () => {
	it("opens a modal asking for the code", async () => {
		const showModal = vi.fn(async () => undefined);
		const customId = buildEnterCodeButton().toJSON() as { custom_id: string };
		await mocks.handlers.get(customId.custom_id.split(":")[0])?.({ showModal } as unknown as ButtonInteraction as never);

		expect(showModal).toHaveBeenCalledOnce();
	});

	it("redeems what the modal holds through the same path as /secret-code", async () => {
		const reply = vi.fn(async () => undefined);
		const submit = { user: { id: "member-1" }, guildId: "guild-1", reply, fields: { getTextInputValue: () => "the code" } } as unknown as ModalSubmitInteraction;
		await mocks.handlers.get("secretcodemodal")?.(submit as never);

		expect(mocks.redeemGift).toHaveBeenCalledWith("member-1", "the code");
		expect(mocks.redeemLuck).toHaveBeenCalledWith("member-1", "the code");
		expect(reply).toHaveBeenCalledOnce();
	});
});
