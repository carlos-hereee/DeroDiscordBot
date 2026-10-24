import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type ButtonInteraction } from "discord.js";

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: vi.fn() }));
vi.mock("@features/games/hangmanHandler.js", () => ({ startHangmanRound: vi.fn() }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emit: vi.fn(), emitFor: vi.fn() } }));
const registry = vi.hoisted(() => ({ buttons: new Map<string, (interaction: ButtonInteraction) => Promise<void>>() }));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: ButtonInteraction) => Promise<void>) => registry.buttons.set(prefix, handler),
	registerModal: vi.fn(),
}));

import { buildPartyGamesRow, registerPartyGameHandlers } from "./partyGames.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { startHangmanRound } from "@features/games/hangmanHandler.js";
import { adminLog } from "@features/setup/adminLog.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── partyGames (post-launch plan item 3) ─────────────────────────────
// The 🎉party-games card's two admin buttons. The buttons are public, so the gate is
// the handler's, and Host hangman opens the round in the party channel, never in the
// channel the press came from.

const words = gameRoomsCopy.partyGames;
const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const gateMock = gateOwnerOrAdmin as unknown as ReturnType<typeof vi.fn>;
const hangmanMock = startHangmanRound as unknown as ReturnType<typeof vi.fn>;
const logMock = adminLog as unknown as { emitFor: ReturnType<typeof vi.fn> };

const partyChannel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, { id: "ch-party" });

function press(customId: string): ButtonInteraction {
	return {
		customId,
		guildId: "guild-1",
		guild: { id: "guild-1" },
		user: { id: "admin-1" },
		client: { channels: { fetch: vi.fn(async (id: string) => (id === "ch-party" ? partyChannel : null)) } },
		reply: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
		showModal: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

registerPartyGameHandlers();
const handle = (interaction: ButtonInteraction) => registry.buttons.get("party_games")!(interaction);

beforeEach(() => {
	vi.clearAllMocks();
	gateMock.mockResolvedValue(true);
	configMock.findByGuildId.mockResolvedValue({ partyGamesChannelId: "ch-party" });
	hangmanMock.mockResolvedValue("started");
});

describe("buildPartyGamesRow", () => {
	it("carries Host hangman and Schedule a party game", () => {
		const ids = buildPartyGamesRow()
			.toJSON()
			.components.map((button) => ("custom_id" in button ? button.custom_id : ""));
		expect(ids).toEqual(["party_games:host:hangman", "party_games:schedule"]);
	});
});

describe("the party games buttons", () => {
	it("refuses a member who is neither the owner nor an admin, and does nothing else", async () => {
		gateMock.mockResolvedValue(false);
		const interaction = press("party_games:host:hangman");

		await handle(interaction);

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: words.adminsOnly }));
		expect(hangmanMock).not.toHaveBeenCalled();
		expect(interaction.showModal).not.toHaveBeenCalled();
	});

	it("opens a hangman round in 🎉party-games for an admin and logs it", async () => {
		const interaction = press("party_games:host:hangman");

		await handle(interaction);

		expect(hangmanMock).toHaveBeenCalledWith(partyChannel, "admin-1");
		expect(logMock.emitFor).toHaveBeenCalledWith(interaction, "guild-1", "powerup.toggle", expect.anything());
		expect(interaction.editReply).toHaveBeenCalledWith({ content: words.hostStarted("ch-party") });
	});

	it("says so when the party channel is not built yet", async () => {
		configMock.findByGuildId.mockResolvedValue({ partyGamesChannelId: null });
		const interaction = press("party_games:host:hangman");

		await handle(interaction);

		expect(hangmanMock).not.toHaveBeenCalled();
		expect(logMock.emitFor).not.toHaveBeenCalled();
	});

	it("opens the schedule modal for an admin", async () => {
		const interaction = press("party_games:schedule");

		await handle(interaction);

		const modal = (interaction.showModal as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { toJSON(): { custom_id: string } };
		expect(modal.toJSON().custom_id).toBe("party_games:schedule");
	});
});
