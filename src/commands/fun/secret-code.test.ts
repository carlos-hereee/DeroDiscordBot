import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

// ── /secret-code ────────────────────────────────────────────────────────────
// Which words each outcome reaches. A member with no gift must read exactly what any wrong
// phrase reads, so the birthday code gives nothing away; the payment itself is chipGift.test.ts.

const mocks = vi.hoisted(() => ({ redeemGift: vi.fn(), redeemLuck: vi.fn(), findConfig: vi.fn() }));

vi.mock("@features/economy/chipGift.js", () => ({ redeemChipGift: mocks.redeemGift }));
vi.mock("@features/fortune/secretCodes.js", () => ({ redeemCode: mocks.redeemLuck }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));

import { execute } from "./secret-code.js";

function fakeInteraction(guildId: string | null = "guild-1") {
	const reply = vi.fn(async () => undefined);
	const interaction = { user: { id: "member-1" }, guildId, reply, options: { getString: () => "the phrase" } } as unknown as ChatInputCommandInteraction;
	return { interaction, reply };
}

const text = (reply: ReturnType<typeof vi.fn>): string => (reply.mock.calls[0] as unknown as [{ content: string }])[0].content;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findConfig.mockResolvedValue({ pluginId: "rok-commander" });
	mocks.redeemLuck.mockResolvedValue({ status: "invalid" });
});

describe("/secret-code", () => {
	it("wishes a happy birthday with the amount paid, and tries no luck code", async () => {
		mocks.redeemGift.mockResolvedValue({ status: "paid", amount: 100_000 });
		const { interaction, reply } = fakeInteraction();

		await execute(interaction);

		expect(text(reply)).toBe(rokCommanderCopy.birthdayGift.paid("100,000 chips"));
		expect(text(reply)).toContain("Happy birthday");
		expect(text(reply)).toContain("The creator has awarded you");
		expect(text(reply)).toContain("Congratulations");
		expect(mocks.redeemLuck).not.toHaveBeenCalled();
	});

	it("words the same message with whatever amount the gift holds", async () => {
		mocks.redeemGift.mockResolvedValue({ status: "paid", amount: 2_500 });
		const { interaction, reply } = fakeInteraction();

		await execute(interaction);

		expect(text(reply)).toBe(rokCommanderCopy.birthdayGift.paid("2,500 chips"));
	});

	it("speaks in the server's own pack", async () => {
		mocks.redeemGift.mockResolvedValue({ status: "paid", amount: 100_000 });
		mocks.findConfig.mockResolvedValue({ pluginId: "general-events" });
		const { interaction, reply } = fakeInteraction();

		await execute(interaction);

		expect(text(reply)).toBe(generalEventsCopy.birthdayGift.paid("100,000 chips"));
	});

	it("still wishes a happy birthday when the pack read fails after the payment", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.redeemGift.mockResolvedValue({ status: "paid", amount: 100_000 });
		mocks.findConfig.mockRejectedValue(new Error("the network dropped"));
		const { interaction, reply } = fakeInteraction();

		await execute(interaction);

		expect(text(reply)).toBe(rokCommanderCopy.birthdayGift.paid("100,000 chips"));
	});

	it("says a collected gift was collected", async () => {
		mocks.redeemGift.mockResolvedValue({ status: "collected" });
		const { interaction, reply } = fakeInteraction(null);

		await execute(interaction);

		expect(text(reply)).toBe(rokCommanderCopy.birthdayGift.collected);
	});

	it("answers a member with no gift exactly as it answers a wrong phrase", async () => {
		const { secretCodeCopy } = await import("@features/fortune/fortuneCopy.js");
		mocks.redeemGift.mockResolvedValue({ status: "none" });
		const { interaction, reply } = fakeInteraction();

		await execute(interaction);

		expect(text(reply)).toBe(secretCodeCopy.invalid);
	});
});
