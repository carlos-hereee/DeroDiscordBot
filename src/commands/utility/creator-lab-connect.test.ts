import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

// ── /creator-lab-connect (Dero: Creator Lab, 2026-11 item 283 Phase 4) ──
// Dark behind its flag, and private from the first byte when lit.

const state = vi.hoisted(() => ({ dmEnabled: true }));

vi.mock("@utils/config.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		get creatorLabDmEnabled() {
			return state.dmEnabled;
		},
	};
});
vi.mock("@db/stores/creatorLabLinkStore.js", () => ({
	creatorLabLinkStore: { issue: vi.fn(), redeem: vi.fn() },
	CREATOR_LAB_LINK_CODE_TTL_MS: 900_000,
}));
vi.mock("@utils/textModal.js", () => ({ showNotice: vi.fn() }));

import { execute, data } from "./creator-lab-connect.js";
import { creatorLabLinkStore } from "@db/stores/creatorLabLinkStore.js";
import { showNotice } from "@utils/textModal.js";

const issueMock = creatorLabLinkStore.issue as unknown as ReturnType<typeof vi.fn>;

const makeInteraction = () => {
	const interaction = {
		user: { id: "123456789012345678", username: "streamer" },
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	};
	return interaction as typeof interaction & ChatInputCommandInteraction;
};

describe("/creator-lab-connect", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.dmEnabled = true;
	});

	it("registers under its name with no default permission, so every member sees it", () => {
		const json = data.toJSON();
		expect(json.name).toBe("creator-lab-connect");
		expect(json.default_member_permissions ?? null).toBeNull();
	});

	it("only says it is not on yet while the flag is off, and issues nothing", async () => {
		state.dmEnabled = false;
		const interaction = makeInteraction();
		await execute(interaction);
		expect(showNotice).toHaveBeenCalledTimes(1);
		expect(issueMock).not.toHaveBeenCalled();
		expect(interaction.deferReply).not.toHaveBeenCalled();
	});

	it("defers privately, issues a code for this Discord user, and shows it", async () => {
		issueMock.mockResolvedValue("ABC234");
		const interaction = makeInteraction();
		await execute(interaction);
		expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
		expect(issueMock).toHaveBeenCalledWith("123456789012345678", "streamer");
		const reply = interaction.editReply.mock.calls[0]?.[0] as unknown as { embeds: Array<{ data: { description?: string } }> };
		expect(reply.embeds[0]?.data.description).toContain("ABC234");
		expect(reply.embeds[0]?.data.description).toContain("15 minutes");
	});

	it("answers a failed issue with a private error, never a thrown one", async () => {
		issueMock.mockRejectedValue(new Error("mongo blip"));
		const interaction = makeInteraction();
		await expect(execute(interaction)).resolves.toBeUndefined();
		expect(interaction.editReply).toHaveBeenCalledTimes(1);
	});
});
