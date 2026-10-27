import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client, TextChannel } from "discord.js";

// ── roomMonopolyRefereeNotice ────────────────────────────────────────
// A referee that cannot speak posts ONE notice per match saying why, with the button
// that fixes it, or none when no press can (2026-10 item 254, Arcade 7), on Monopoly and
// Hold'em alike (2026-10 item 257 Phase 4b). Each button runs the handler that already does
// the job; the only join a match makes by itself is roomReferee's, at the start.

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { claimRefereeNotice: vi.fn() } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn(async () => ({ adminRoleId: "admins" })) } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: vi.fn() }));
vi.mock("@utils/textModal.js", () => ({ showNotice: vi.fn() }));
vi.mock("@features/early-access/earlyAccess.js", () => ({ checkEarlyAccess: vi.fn(async () => ({ allowed: true })), earlyAccessEmbed: vi.fn() }));
vi.mock("@commands/admin/dero-config.js", () => ({ data: { name: "dero-config" }, run: vi.fn() }));
vi.mock("@commands/utility/dero.js", () => ({ bringDeroIntoCall: vi.fn() }));
// The board move, with a channel that records what posted above the board.
const posted = vi.hoisted(() => ({ messages: [] as unknown[] }));
vi.mock("./roomMonopolyBoard.js", () => ({
	moveMonopolyBoardToBottom: vi.fn(async (_client: unknown, _room: unknown, above?: (channel: TextChannel) => Promise<unknown>) => {
		await above?.({ send: async (payload: unknown) => posted.messages.push(payload) } as unknown as TextChannel);
	}),
}));

// A Hold'em room's channel, which a notice posts straight into.
vi.mock("./roomTrail.js", () => ({
	resolveRoomChannel: vi.fn(async () => ({ send: async (payload: unknown) => posted.messages.push(payload) })),
}));

import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { showNotice } from "@utils/textModal.js";
import * as deroConfigCommand from "@commands/admin/dero-config.js";
import { bringDeroIntoCall } from "@commands/utility/dero.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { FormOptionReader } from "@features/command-buttons/formOptionReader.js";
import { moveMonopolyBoardToBottom } from "./roomMonopolyBoard.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { RefereeSilence } from "./roomMonopolyReferee.js";
import { handleBringIntoCall, handleEnableVoice, postRefereeNotice } from "./roomMonopolyRefereeNotice.js";

const claimMock = gameRoomStore.claimRefereeNotice as unknown as ReturnType<typeof vi.fn>;
const gateMock = gateOwnerOrAdmin as unknown as ReturnType<typeof vi.fn>;
const runMock = deroConfigCommand.run as unknown as ReturnType<typeof vi.fn>;
const room = { roomId: "room-1", guildId: "guild-1", channelId: "ch-1", game: "monopoly", referee: true } as unknown as IGameRoom;
const holdemRoom = { ...room, game: "holdem" } as unknown as IGameRoom;
const client = {} as Client;

type PostedNotice = { embeds: { data: { description?: string } }[]; components: { toJSON(): { components: { custom_id: string }[] } }[]; allowedMentions: unknown };
const noticeButtons = (notice: PostedNotice): string[] => notice.components.flatMap((rowOf) => rowOf.toJSON().components.map((button) => button.custom_id));

beforeEach(() => {
	vi.clearAllMocks();
	posted.messages = [];
	claimMock.mockResolvedValue(room);
});

describe("postRefereeNotice", () => {
	const expected: [RefereeSilence, string[]][] = [
		["voiceOff", ["gameroom:mrefvoice:room-1"]],
		["noCall", ["gameroom:mrefcall:room-1"]],
		["noPlayerInCall", []],
		["budgetSpent", []],
	];
	for (const [reason, buttons] of expected) {
		it(`posts one notice for ${reason}, saying why, with ${buttons.length === 0 ? "no button" : "its fix button"}`, async () => {
			await postRefereeNotice(client, room, reason);
			expect(posted.messages).toHaveLength(1);
			const notice = posted.messages[0] as PostedNotice;
			expect(notice.embeds[0].data.description).toBe(gameRoomsCopy.monopoly.refereeSilent[reason]);
			expect(noticeButtons(notice)).toEqual(buttons);
			// It pings nobody, and it posts above the board, which then moves below it.
			expect(notice.allowedMentions).toEqual({ parse: [] });
			expect(moveMonopolyBoardToBottom).toHaveBeenCalledOnce();
		});
	}

	it("posts nothing for a second silence in the same match, whatever its reason", async () => {
		claimMock.mockResolvedValueOnce(room).mockResolvedValueOnce(null);
		await postRefereeNotice(client, room, "noCall");
		await postRefereeNotice(client, room, "voiceOff");
		expect(posted.messages).toHaveLength(1);
		expect(moveMonopolyBoardToBottom).toHaveBeenCalledOnce();
	});

	it("posts a Hold'em table's notice straight into its room, with no board to move", async () => {
		claimMock.mockResolvedValue(holdemRoom);
		await postRefereeNotice(client, holdemRoom, "noCall");
		expect(posted.messages).toHaveLength(1);
		expect(noticeButtons(posted.messages[0] as PostedNotice)).toEqual(["gameroom:mrefcall:room-1"]);
		expect(moveMonopolyBoardToBottom).not.toHaveBeenCalled();
	});

	it("never throws when the claim fails, since it runs off the referee's own chain", async () => {
		claimMock.mockRejectedValueOnce(new Error("Atlas hiccup"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await expect(postRefereeNotice(client, room, "noCall")).resolves.toBeUndefined();
		expect(posted.messages).toEqual([]);
	});
});

describe("the fix buttons", () => {
	const press = (): ButtonInteraction => ({ guildId: "guild-1", user: { id: "member-1" }, client }) as unknown as ButtonInteraction;

	it("Enable Dero's voice runs the /dero-config enable leaf for an admin", async () => {
		gateMock.mockResolvedValue(true);
		const interaction = press();
		await handleEnableVoice(interaction);
		expect(runMock).toHaveBeenCalledOnce();
		const [ranWith, reader] = runMock.mock.calls[0] as [ButtonInteraction, FormOptionReader];
		expect(ranWith).toBe(interaction);
		expect(reader).toBeInstanceOf(FormOptionReader);
		expect(reader.getSubcommand(true)).toBe("enable");
		expect(reader.getSubcommandGroup(false)).toBeNull();
	});

	it("Enable Dero's voice refuses anyone else privately, and switches nothing", async () => {
		gateMock.mockResolvedValue(false);
		await handleEnableVoice(press());
		expect(runMock).not.toHaveBeenCalled();
		expect(showNotice).toHaveBeenCalledOnce();
		const [, content] = (showNotice as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, { sections: string[] }];
		expect(content.sections).toEqual([gameRoomsCopy.monopoly.enableVoiceAdminOnly]);
	});

	it("Bring Dero into the call runs bringDeroIntoCall, then moves the board back below its join notice", async () => {
		const interaction = press();
		await handleBringIntoCall(interaction, room);
		expect(bringDeroIntoCall).toHaveBeenCalledExactlyOnceWith(interaction);
		const moveMock = moveMonopolyBoardToBottom as unknown as ReturnType<typeof vi.fn>;
		expect(moveMock).toHaveBeenCalledWith(client, room);
		expect(moveMock.mock.invocationCallOrder[0]).toBeGreaterThan((bringDeroIntoCall as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
	});

	it("Bring Dero into the call on a Hold'em table moves no board, since the table reposts at its next reveal", async () => {
		const interaction = press();
		await handleBringIntoCall(interaction, holdemRoom);
		expect(bringDeroIntoCall).toHaveBeenCalledExactlyOnceWith(interaction);
		expect(moveMonopolyBoardToBottom).not.toHaveBeenCalled();
	});
});
