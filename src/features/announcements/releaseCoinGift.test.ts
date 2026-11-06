import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";

// ── the release Claim button ────────────────────────────────────────────────
// The money rule lives in deroCoins.test.ts; this pins the button's id and the words each
// outcome reaches, every one of them private to the member who pressed.

const mocks = vi.hoisted(() => ({ award: vi.fn() }));
vi.mock("@features/economy/deroCoins.js", () => ({ awardReleaseGift: mocks.award }));

import { economyCopy } from "@features/economy/economyCopy.js";
import { buildReleaseGiftButton, handleReleaseGiftClaim } from "./releaseCoinGift.js";

const words = economyCopy.releaseGift;

function press() {
	const reply = vi.fn(async () => undefined);
	const interaction = { customId: "relgift:age-limit-apology", guildId: "guild-1", user: { id: "member-1" }, reply } as unknown as ButtonInteraction;
	return { interaction, reply };
}

const text = (reply: ReturnType<typeof vi.fn>): string => (reply.mock.calls[0] as unknown as [{ content: string }])[0].content;

beforeEach(() => mocks.award.mockReset());

describe("the release Claim button", () => {
	it("is labeled Claim and carries its gift", () => {
		expect(buildReleaseGiftButton("age-limit-apology")?.toJSON()).toMatchObject({ label: "Claim", custom_id: "relgift:age-limit-apology" });
	});

	it("is left off a release with no gift", () => {
		expect(buildReleaseGiftButton(null)).toBeNull();
	});

	it.each([
		[{ status: "paid", amount: 5 }, words.paid(5)],
		[{ status: "already" }, words.already],
		[{ status: "unknown" }, words.closed],
		[{ status: "failed" }, words.failed],
	])("answers %o with its own line", async (outcome, line) => {
		mocks.award.mockResolvedValue(outcome);
		const { interaction, reply } = press();

		await handleReleaseGiftClaim(interaction);

		expect(mocks.award).toHaveBeenCalledWith(expect.objectContaining({ guildId: "guild-1", userId: "member-1", giftKey: "age-limit-apology" }));
		expect(text(reply)).toBe(line);
	});
});
