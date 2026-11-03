import { describe, it, expect, vi, beforeEach } from "vitest";
import { ButtonStyle, type ButtonInteraction } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";

// ── arcadeControlCards ──────────────────────────────────────────────────────
// The Dismantle Arcade and Enable Arcade buttons on 🎰arcade-control's steps card
// (2026-11 item 285 Phase 4). Dismantle is turnArcadeOff behind a re-checked gate AND a
// Dismantle or Cancel confirm (owner ruling, so one stray press takes nothing down);
// Enable is a stub that says coming soon as a state notice and changes nothing.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	gateOwnerOrAdmin: vi.fn(),
	turnArcadeOff: vi.fn(),
	askInChannel: vi.fn(),
	awaitPress: vi.fn(),
	edit: vi.fn(),
	showNotice: vi.fn(),
	emitFor: vi.fn(),
	refreshHeadquartersCards: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: mocks.gateOwnerOrAdmin }));
vi.mock("@utils/answerInChannel.js", () => ({ askInChannel: mocks.askInChannel }));
vi.mock("@utils/textModal.js", () => ({ showNotice: mocks.showNotice }));
vi.mock("./arcadeSwitch.js", () => ({ turnArcadeOff: mocks.turnArcadeOff }));
vi.mock("./adminLog.js", () => ({ adminLog: { emitFor: mocks.emitFor } }));
vi.mock("./headquartersCards.js", () => ({ refreshHeadquartersCards: mocks.refreshHeadquartersCards }));

import { arcadeControlActionOf, arcadeControlCustomId, buildButtons, handleDismantle } from "./arcadeControlCards.js";
import { setupCopy } from "./setupCopy.js";

const GUILD = { id: "g1" };
const confirmCopy = setupCopy.headquarters.arcadeControl.dismantleConfirm;
// The en dash and the em dash, built from their code points so this file carries neither.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

function press() {
	const dm = vi.fn();
	const reply = vi.fn().mockResolvedValue(undefined);
	const interaction = { guild: GUILD, user: { id: "u-admin", send: dm }, client: { users: { send: dm } }, reply } as unknown as ButtonInteraction;
	return { interaction, dm, reply };
}

/** The asker's press on one of the confirm prompt's buttons. */
function confirmPress(customId: string) {
	return { customId, update: vi.fn().mockResolvedValue(undefined), deferUpdate: vi.fn().mockResolvedValue(undefined), user: { id: "u-admin" } };
}

const embedOf = (call: unknown[]): { title?: string | null; description?: string | null } => (call[0] as { embeds: Array<{ data: object }> }).embeds[0]!.data;

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue({ guildId: GUILD.id, pluginId: "rok-commander" });
	mocks.gateOwnerOrAdmin.mockReset().mockResolvedValue(true);
	mocks.turnArcadeOff.mockReset().mockResolvedValue("off");
	mocks.awaitPress.mockReset().mockResolvedValue(confirmPress("confirm_dismantle_arcade"));
	mocks.edit.mockReset().mockResolvedValue(undefined);
	mocks.askInChannel.mockReset().mockResolvedValue({ channelId: "c-arcade-control", awaitPress: mocks.awaitPress, edit: mocks.edit });
	mocks.showNotice.mockReset().mockResolvedValue(undefined);
	mocks.emitFor.mockReset();
	mocks.refreshHeadquartersCards.mockReset();
});

describe("the buttons", () => {
	// The coming soon Enable Arcade stub is retired (2026-11 item 285 debug pass, owner
	// ruling): while the arcade is off the card is the enable step itself.
	it("is Dismantle Arcade (danger) alone", () => {
		const buttons = buildButtons().map((button) => button.toJSON() as { custom_id: string; label: string; style: number });
		expect(buttons).toEqual([{ type: 2, custom_id: "hqstep:arcadeControl:dismantle", label: "Dismantle Arcade", style: ButtonStyle.Danger }]);
	});

	it("round trips through its customId tail, and a tail no button carries names nothing", () => {
		expect(arcadeControlActionOf("dismantle")).toBe("dismantle");
		expect(arcadeControlCustomId("dismantle")).toBe("hqstep:arcadeControl:dismantle");
		expect(arcadeControlActionOf("enableStub")).toBeNull();
		expect(arcadeControlActionOf("1")).toBeNull();
		expect(arcadeControlActionOf("toString")).toBeNull();
	});
});

describe("Dismantle Arcade", () => {
	it("tells a presser who is no admin so, and asks and tears down nothing", async () => {
		mocks.gateOwnerOrAdmin.mockResolvedValue(false);
		const { interaction } = press();

		await handleDismantle(interaction);

		expect(mocks.showNotice).toHaveBeenCalledWith(interaction, expect.objectContaining({ sections: [setupCopy.headquarters.arcadeControl.notAdmin] }));
		expect(mocks.askInChannel).not.toHaveBeenCalled();
		expect(mocks.turnArcadeOff).not.toHaveBeenCalled();
	});

	it("posts a Cancel and Dismantle confirm in 🎰arcade-control and tears nothing down until Dismantle is pressed", async () => {
		let pressConfirm: (value: ReturnType<typeof confirmPress>) => void = () => undefined;
		mocks.awaitPress.mockReturnValue(new Promise((resolve) => (pressConfirm = resolve)));
		const { interaction } = press();

		const running = handleDismantle(interaction);
		await vi.waitFor(() => expect(mocks.awaitPress).toHaveBeenCalled());

		const [, audience, prompt] = mocks.askInChannel.mock.calls[0]!;
		expect(audience).toBe("arcade");
		expect(embedOf([prompt])).toMatchObject({ title: confirmCopy.title, description: confirmCopy.body });
		const labels = (prompt.components[0].toJSON().components as Array<{ custom_id: string; label: string }>).map((button) => [button.custom_id, button.label]);
		expect(labels).toEqual([
			["cancel_dismantle_arcade", confirmCopy.cancelButton],
			["confirm_dismantle_arcade", confirmCopy.confirmButton],
		]);
		expect(mocks.turnArcadeOff).not.toHaveBeenCalled();

		pressConfirm(confirmPress("confirm_dismantle_arcade"));
		await running;
		expect(mocks.turnArcadeOff).toHaveBeenCalledTimes(1);
	});

	it("on Dismantle acknowledges the press, calls turnArcadeOff with the guild, rewrites the prompt with the pack's success line, logs the change and redraws the card", async () => {
		const confirm = confirmPress("confirm_dismantle_arcade");
		mocks.awaitPress.mockResolvedValue(confirm);
		const { interaction } = press();

		await handleDismantle(interaction);

		expect(confirm.deferUpdate).toHaveBeenCalled();
		expect(mocks.turnArcadeOff).toHaveBeenCalledWith(GUILD);
		expect(embedOf(mocks.edit.mock.calls[0]!).description).toBe(rokCommanderCopy.responses.dismantleSuccess);
		expect(mocks.edit.mock.calls[0]![0].components).toEqual([]);
		expect(mocks.emitFor).toHaveBeenCalledWith(confirm, GUILD.id, "config.change", {
			subject: setupCopy.adminLog.subjects.arcade,
			detail: setupCopy.arcade.auditOff,
		});
		await vi.waitFor(() => expect(mocks.refreshHeadquartersCards).toHaveBeenCalledWith(GUILD, "arcadeControl"));
	});

	it("answers in the guild's own pack voice", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: GUILD.id, pluginId: "general-events" });

		await handleDismantle(press().interaction);

		expect(embedOf(mocks.edit.mock.calls[0]!).description).toBe(generalEventsCopy.responses.dismantleSuccess);
	});

	it("on Cancel rewrites the prompt as cancelled and tears nothing down", async () => {
		const cancel = confirmPress("cancel_dismantle_arcade");
		mocks.awaitPress.mockResolvedValue(cancel);

		await handleDismantle(press().interaction);

		expect(embedOf(cancel.update.mock.calls[0]!).description).toBe(confirmCopy.cancelled);
		expect(cancel.update.mock.calls[0]![0].components).toEqual([]);
		expect(mocks.turnArcadeOff).not.toHaveBeenCalled();
		expect(mocks.emitFor).not.toHaveBeenCalled();
	});

	it("when nobody answers in time rewrites the prompt so a stale Dismantle cannot be pressed, and tears nothing down", async () => {
		mocks.awaitPress.mockResolvedValue(null);

		await handleDismantle(press().interaction);

		expect(embedOf(mocks.edit.mock.calls[0]!).description).toBe(confirmCopy.timedOut);
		expect(mocks.edit.mock.calls[0]![0].components).toEqual([]);
		expect(mocks.turnArcadeOff).not.toHaveBeenCalled();
	});

	it("posts the already off line for an arcade that is down, and logs and redraws nothing", async () => {
		mocks.turnArcadeOff.mockResolvedValue("already-off");

		await handleDismantle(press().interaction);

		expect(embedOf(mocks.edit.mock.calls[0]!).description).toBe(rokCommanderCopy.responses.dismantleAlreadyOff);
		expect(mocks.emitFor).not.toHaveBeenCalled();
		expect(mocks.refreshHeadquartersCards).not.toHaveBeenCalled();
	});

	it("rewrites the prompt with an error embed, never throwing, when the teardown fails", async () => {
		mocks.turnArcadeOff.mockRejectedValue(new Error("discord refused"));
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(handleDismantle(press().interaction)).resolves.toBeUndefined();

		expect(embedOf(mocks.edit.mock.calls[0]!).description).toBe(setupCopy.arcade.offFailed);
		expect(mocks.emitFor).not.toHaveBeenCalled();
		logged.mockRestore();
	});
});

describe("the copy", () => {
	it("carries no long dash in either pack, the buttons or the confirm", () => {
		const lines = [rokCommanderCopy.responses, generalEventsCopy.responses].flatMap((responses) => [
			responses.dismantleSuccess,
			responses.dismantleAlreadyOff,
		]);
		const { dismantleButton, enableTitle, notAdmin, dismantleConfirm } = setupCopy.headquarters.arcadeControl;
		for (const line of [...lines, dismantleButton, enableTitle, notAdmin, ...Object.values(dismantleConfirm)]) expect(line).not.toMatch(LONG_DASHES);
	});
});
