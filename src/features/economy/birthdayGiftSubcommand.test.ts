import { beforeEach, describe, expect, it, vi } from "vitest";
import { SlashCommandSubcommandBuilder, type ChatInputCommandInteraction } from "discord.js";

// ── /platform birthday-gift ─────────────────────────────────────────────────
// Pins the owner gate, as the other /platform doors do: these chips come from nowhere, so only
// CREATOR_DISCORD_ID may set a gift, and an unset id refuses everyone.

const owner = vi.hoisted(() => ({ id: "900000000000000001" }));
vi.mock("@utils/config.js", () => ({
	get creatorId() {
		return owner.id;
	},
}));
vi.mock("./chipGift.js", () => ({ grantChipGift: vi.fn(async () => undefined) }));

import { grantChipGift } from "./chipGift.js";
import { addBirthdayGiftSubcommand, runBirthdayGiftSubcommand } from "./birthdayGiftSubcommand.js";

const grantMock = vi.mocked(grantChipGift);

function fakeInteraction(userId: string, member: { id: string; bot: boolean } = { id: "member-1", bot: false }) {
	const reply = vi.fn(async () => undefined);
	const interaction = {
		user: { id: userId },
		reply,
		options: { getUser: () => member, getInteger: () => 100_000 },
	} as unknown as ChatInputCommandInteraction;
	return { interaction, reply };
}

const firstText = (reply: ReturnType<typeof vi.fn>): string => (reply.mock.calls[0] as unknown as [{ content: string }])[0].content;

beforeEach(() => {
	owner.id = "900000000000000001";
	grantMock.mockClear();
});

describe("/platform birthday-gift", () => {
	it("saves the gift against the picked member's id and tells the owner the code", async () => {
		const { interaction, reply } = fakeInteraction(owner.id);

		await runBirthdayGiftSubcommand(interaction);

		expect(grantMock).toHaveBeenCalledWith("member-1", 100_000, owner.id);
		expect(firstText(reply)).toContain("100,000 chips");
		expect(firstText(reply)).toContain("UP DOWN UP DOWN LEFT LEFT UP RIGHT A B SELECT START");
	});

	it("refuses anyone but the platform owner, saving nothing", async () => {
		const { interaction, reply } = fakeInteraction("123");

		await runBirthdayGiftSubcommand(interaction);

		expect(grantMock).not.toHaveBeenCalled();
		expect(firstText(reply)).toContain("Only the platform owner");
	});

	it("refuses everyone when CREATOR_DISCORD_ID is unset, even an empty user id", async () => {
		owner.id = "";
		const { interaction } = fakeInteraction("");

		await runBirthdayGiftSubcommand(interaction);

		expect(grantMock).not.toHaveBeenCalled();
	});

	it("refuses a bot, which has no wallet to collect with", async () => {
		const { interaction } = fakeInteraction(owner.id, { id: "bot-1", bot: true });

		await runBirthdayGiftSubcommand(interaction);

		expect(grantMock).not.toHaveBeenCalled();
	});

	it("keeps the amount a whole number inside the typo guard", () => {
		const json = addBirthdayGiftSubcommand(new SlashCommandSubcommandBuilder()).toJSON();
		const chipsOption = json.options?.find((option) => option.name === "chips") as { min_value?: number; max_value?: number; required?: boolean };

		expect(chipsOption).toMatchObject({ min_value: 1, max_value: 1_000_000, required: true });
	});
});
