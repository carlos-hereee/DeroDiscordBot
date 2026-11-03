import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";

// ── renameInfoStep ──────────────────────────────────────────────────────────
// 🛠️server-config's 8th step (2026-11 item 285 Phase 4): an explainer for admins, posted
// in 🛠️server-config as an answer (never a private reply), that changes no state.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	gateOwnerOrAdmin: vi.fn(),
	showNotice: vi.fn(),
	answerInChannel: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: mocks.gateOwnerOrAdmin }));
vi.mock("@utils/textModal.js", () => ({ showNotice: mocks.showNotice }));
vi.mock("@utils/answerInChannel.js", () => ({ answerInChannel: mocks.answerInChannel }));

import { handleOpen } from "./renameInfoStep.js";
import { setupCopy } from "./setupCopy.js";

// The en dash and the em dash, built from their code points so this file carries neither.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const CONFIG = { guildId: "g1", pluginId: "rok-commander" };

function press() {
	const reply = vi.fn().mockResolvedValue(undefined);
	return { interaction: { guild: { id: "g1" }, user: { id: "u-admin" }, reply } as unknown as ButtonInteraction, reply };
}

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue(CONFIG);
	mocks.update.mockReset();
	mocks.gateOwnerOrAdmin.mockReset().mockResolvedValue(true);
	mocks.showNotice.mockReset().mockResolvedValue(undefined);
	mocks.answerInChannel.mockReset().mockResolvedValue({ channelId: "c-server-config" });
});

describe("the rename info step", () => {
	it("tells a presser who is no admin so, and posts no explainer", async () => {
		mocks.gateOwnerOrAdmin.mockResolvedValue(false);
		const { interaction } = press();

		await handleOpen(interaction);

		expect(mocks.showNotice).toHaveBeenCalledWith(interaction, expect.objectContaining({ sections: [setupCopy.headquarters.serverConfig.rename.notAdmin] }));
		expect(mocks.answerInChannel).not.toHaveBeenCalled();
	});

	it("posts an embed that teaches the command and the auto heal rule in 🛠️server-config, replies privately with nothing, and writes nothing", async () => {
		const { interaction, reply } = press();

		await handleOpen(interaction);

		const [passedInteraction, audience, answer, options] = mocks.answerInChannel.mock.calls[0]!;
		expect(passedInteraction).toBe(interaction);
		expect(audience).toBe("serverConfig");
		expect(options).toEqual({ config: CONFIG });
		const embed = answer.embeds[0].data;
		expect(embed.title).toBe(rokCommanderCopy.responses.renameInfoTitle);
		expect(embed.description).toBe(rokCommanderCopy.responses.renameInfoBody);
		expect(embed.description).toContain("/server channels rename");
		expect(embed.description).toContain("auto heal");
		expect(reply).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("speaks in the guild's own pack voice", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: "g1", pluginId: "general-events" });

		await handleOpen(press().interaction);

		expect(mocks.answerInChannel.mock.calls[0]![2].embeds[0].data.description).toBe(generalEventsCopy.responses.renameInfoBody);
	});

	it("carries no long dash in either pack's copy", () => {
		for (const responses of [rokCommanderCopy.responses, generalEventsCopy.responses]) {
			expect(responses.renameInfoTitle).not.toMatch(LONG_DASHES);
			expect(responses.renameInfoBody).not.toMatch(LONG_DASHES);
		}
	});
});
