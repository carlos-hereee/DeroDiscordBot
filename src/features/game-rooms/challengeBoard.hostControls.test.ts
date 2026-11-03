import { describe, it, expect, vi, beforeEach } from "vitest";
// Dero's variant lines always pick the first, so these tests read exact words.
vi.mock("@utils/pickLine.js", () => ({ pickLine: <Line>(lines: readonly Line[]): Line => lines[0] as Line }));
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(),
		update: vi.fn(),
		addPoolMember: vi.fn(),
		addPendingJoin: vi.fn(),
	},
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/playerRatingStore.js", () => ({ playerRatingStore: { findForPlayers: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({ readPrivateQuotaStatus: vi.fn().mockResolvedValue(null), describeSoloOpenFailure: () => "nope" }));
vi.mock("./challengeCardRenderer.js", () => ({ renderChallengeCard: vi.fn().mockResolvedValue(null), challengeCardView: vi.fn().mockResolvedValue({}) }));
// Dero's voice (2026-10 item 267, decision 14): which call he is in, and what he would say there.
vi.mock("@features/voice/voiceSessions.js", () => ({ voiceSessions: { get: vi.fn(() => null) } }));
vi.mock("@features/voice/callAnnouncer.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("@features/voice/callAnnouncer.js")>()), speakInCall: vi.fn(async () => "spoken") }));

import { chooseVisibility, handleInviteSelect, handleOpponentSelect, joinChallenge, openInvitePicker } from "./challengeBoard.js";
import { buildSettingsModal, defaultSettings, type SettingsGame } from "./challengeSettings.js";
import type { ChallengeReach } from "./roomTypes.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { playerRatingStore } from "@db/stores/playerRatingStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { speakInCall } from "@features/voice/callAnnouncer.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";

// ── the challenge card under the host controls (2026-10 item 244 Phase 4) ──
// What:  the server's reach caps the visibility a host is offered AND may choose; the
//        card's Join reads the join gate (removed, band, approval); and a member the
//        host removed cannot come back through the invite picker or the opponent select.

const words = rokCommanderCopy.arcadeHostControls;
type Mock = ReturnType<typeof vi.fn>;
const storeMock = gameRoomStore as unknown as Record<"findByRoomId" | "update" | "addPoolMember" | "addPendingJoin", Mock>;
const configMock = guildConfigStore.findByGuildId as unknown as Mock;
const ratingsMock = playerRatingStore.findForPlayers as unknown as Mock;

const HOST = "host-1";
const JOINER = "joiner-1";
const SETTLED = BOT_CONSTANTS.RATINGS.PROVISIONAL_GAMES;

const makeRoom = (overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: "guild-1",
		game: "holdem",
		hostId: HOST,
		playerIds: [HOST],
		spectatorIds: [],
		pendingJoinIds: [],
		kickedIds: [],
		ratingBand: "any",
		requireApproval: false,
		visibility: "public",
		status: "draft",
		channelId: null,
		boardMessageId: null,
		...overrides,
	}) as unknown as IGameRoom;

const members = new Map(
	[HOST, JOINER, "kicked-1", "member-2"].map((id) => [id, { id, displayName: id, user: { bot: false, username: id } }])
);
const memberCache = {
	size: members.size,
	get: (id: string) => members.get(id),
	filter(predicate: (member: { id: string; user: { bot: boolean } }) => boolean) {
		const kept = [...members.values()].filter(predicate);
		return { map: <T>(fn: (member: (typeof kept)[number]) => T) => kept.map(fn) };
	},
};
const guild = { id: "guild-1", members: { cache: memberCache, fetch: vi.fn(async (id?: string) => (id ? members.get(id) ?? null : memberCache)) } };

function makeButton(userId: string): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild,
		user: { id: userId },
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

function makeSelect(action: string, values: string[]): StringSelectMenuInteraction {
	return {
		customId: `gameroomSelect:${action}:room-1`,
		guildId: "guild-1",
		guild,
		user: { id: HOST },
		values,
		isModalSubmit: () => false,
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
	} as unknown as StringSelectMenuInteraction;
}

const replyText = (interaction: { reply: unknown }): string =>
	(((interaction.reply as Mock).mock.calls[0]?.[0] ?? {}) as { content?: string }).content ?? "";

const rated = (userId: string, displayRating: number, ratedGames = SETTLED) => ({ userId, game: "holdem", mu: 25, sigma: 1, displayRating, ratedGames, lastRatedAt: new Date() });

beforeEach(() => {
	vi.clearAllMocks();
	configMock.mockResolvedValue(null);
	ratingsMock.mockResolvedValue([]);
	storeMock.update.mockImplementation(async (_guildId: string, _roomId: string, patch: Partial<IGameRoom>) => makeRoom(patch));
	storeMock.addPoolMember.mockResolvedValue(makeRoom({ spectatorIds: [JOINER] }));
	storeMock.addPendingJoin.mockResolvedValue(makeRoom({ pendingJoinIds: [JOINER] }));
	storeMock.findByRoomId.mockResolvedValue(makeRoom());
});

describe("the server's challenge reach", () => {
	// The creation modal's Who can join options (2026-10 item 263 Phase 2a), the card's old first step.
	const joinValues = (reach: ChallengeReach, game: SettingsGame = "holdem"): string[] => {
		const context = { game, reach, botsAllowed: true, hasRatedChannel: true };
		const { modal } = buildSettingsModal(context, { customId: "gameroom:newok:holdem", mode: { kind: "create" }, values: defaultSettings(context) });
		const field = (modal.toJSON().components as Array<{ component?: { custom_id?: string; options?: Array<{ value: string }> } }>).find((entry) => entry.component?.custom_id === "join");
		return field?.component?.options?.map((option) => option.value) ?? [];
	};

	it("offers Invite only and Open to all, approving or not, at Server reach", () => {
		expect(joinValues("server")).toEqual(["invite", "public", "approve"]);
		expect(joinValues("network", "monopoly")).toEqual(["invite", "public", "approve"]);
	});

	it("offers Invite only alone at Invite only reach", () => {
		expect(joinValues("invite-only")).toEqual(["invite"]);
	});

	it("refuses Open to all server side at Invite only reach, writing nothing, even from a stale card", async () => {
		configMock.mockResolvedValue({ challengeReach: "invite-only" });
		const interaction = makeButton(HOST);

		await chooseVisibility(interaction, makeRoom({ visibility: "invite" }), "public");

		expect(replyText(interaction)).toBe(words.reach.publicRefused);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("still lets an invite only server choose Invite only, and a Server reach choose Open to all", async () => {
		configMock.mockResolvedValue({ challengeReach: "invite-only" });
		await chooseVisibility(makeButton(HOST), makeRoom(), "invite");
		configMock.mockResolvedValue({ challengeReach: "server" });
		await chooseVisibility(makeButton(HOST), makeRoom(), "public");

		expect(storeMock.update.mock.calls.map((call) => call[2])).toEqual([{ visibility: "invite" }, { visibility: "public" }]);
	});
});

describe("Join on an open challenge", () => {
	it("refuses a member the host removed", async () => {
		const interaction = makeButton("kicked-1");
		await joinChallenge(interaction, makeRoom({ kickedIds: ["kicked-1"] }));

		expect(replyText(interaction)).toBe(words.kick.refusedRejoin);
		expect(storeMock.addPoolMember).not.toHaveBeenCalled();
		expect(storeMock.addPendingJoin).not.toHaveBeenCalled();
	});

	it("refuses a settled rating outside the host's band", async () => {
		ratingsMock.mockResolvedValue([rated(HOST, 1300), rated(JOINER, 1000)]);
		const interaction = makeButton(JOINER);

		await joinChallenge(interaction, makeRoom({ ratingBand: "close" }));

		expect(replyText(interaction)).toBe(words.band.refused(gameRoomsCopy.gameLabel("holdem")));
		expect(storeMock.addPoolMember).not.toHaveBeenCalled();
	});

	it("lets a provisional joiner past the band", async () => {
		ratingsMock.mockResolvedValue([rated(HOST, 1300), rated(JOINER, 1000, SETTLED - 1)]);
		await joinChallenge(makeButton(JOINER), makeRoom({ ratingBand: "tight" }));

		expect(storeMock.addPoolMember).toHaveBeenCalledWith("guild-1", "room-1", JOINER);
	});

	it("turns the join into a request when the host approves each joiner", async () => {
		const interaction = makeButton(JOINER);
		await joinChallenge(interaction, makeRoom({ requireApproval: true }));

		expect(storeMock.addPendingJoin).toHaveBeenCalledWith("guild-1", "room-1", JOINER);
		expect(storeMock.addPoolMember).not.toHaveBeenCalled();
		expect(replyText(interaction)).toBe(words.approval.asked);
	});

	it("refuses a removal that landed between the gate and the write", async () => {
		storeMock.addPoolMember.mockResolvedValue(null);
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ kickedIds: [JOINER] }));
		const interaction = makeButton(JOINER);

		await joinChallenge(interaction, makeRoom());

		expect(replyText(interaction)).toBe(words.kick.refusedRejoin);
	});
});

describe("a removed member cannot come back by a select", () => {
	it("is never offered by the invite picker", async () => {
		const interaction = makeButton(HOST);
		await openInvitePicker(interaction, makeRoom({ visibility: "invite", kickedIds: ["kicked-1"] }));

		const payload = (interaction.reply as Mock).mock.calls[0][0] as { components: { toJSON(): { components: { options?: { value: string }[] }[] } }[] };
		const offered = payload.components[0].toJSON().components[0].options?.map((option) => option.value) ?? [];
		expect(offered).toContain("member-2");
		expect(offered).not.toContain("kicked-1");
	});

	it("is filtered out of an invite submission that names them anyway", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ visibility: "invite", kickedIds: ["kicked-1"] }));

		await handleInviteSelect(makeSelect("invite", ["kicked-1", "member-2"]));

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { spectatorIds: ["member-2"] });
	});

	it("is refused by the opponent select", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ game: "rps", spectatorIds: ["kicked-1"], kickedIds: ["kicked-1"] }));
		const interaction = makeSelect("opponent", ["kicked-1"]);

		await handleOpponentSelect(interaction);

		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(replyText(interaction)).toBe(gameRoomsCopy.board.poolEmpty);
	});
});

// ── new challengers at the door (2026-10 item 267, owner decision 14) ──
// A member joining a card's pool, or asking to under approval, makes Dero say so in the card's
// call, and only when the host turned Dero voice on and Dero is in that call. Never a text line.
describe("Dero greets new challengers", () => {
	const sessionMock = voiceSessions.get as unknown as Mock;
	const speakMock = speakInCall as unknown as Mock;
	const settle = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};

	beforeEach(() => {
		// Dero is in the call this card's own request started.
		sessionMock.mockReturnValue({ channelId: "vc-1", startedByRoomId: "room-1" });
	});

	it("says the challenger line in the card's call when a member joins with Dero voice on", async () => {
		storeMock.addPoolMember.mockResolvedValue(makeRoom({ game: "rps", deroVoice: true, spectatorIds: [JOINER] }));
		await joinChallenge(makeButton(JOINER), makeRoom({ game: "rps", deroVoice: true }));

		await vi.waitFor(() => expect(speakMock).toHaveBeenCalledWith("guild-1", deroBrainCopy.dealer.challengers[0]));
		expect(speakMock).toHaveBeenCalledOnce();
	});

	it("says nothing when a member joins with Dero voice off", async () => {
		storeMock.addPoolMember.mockResolvedValue(makeRoom({ game: "rps", deroVoice: false, spectatorIds: [JOINER] }));
		await joinChallenge(makeButton(JOINER), makeRoom({ game: "rps", deroVoice: false }));
		await settle();

		expect(speakMock).not.toHaveBeenCalled();
	});

	it("tells the host to check Requests when a member asks to join with Dero voice on", async () => {
		storeMock.addPendingJoin.mockResolvedValue(makeRoom({ game: "rps", deroVoice: true, requireApproval: true, pendingJoinIds: [JOINER] }));
		await joinChallenge(makeButton(JOINER), makeRoom({ game: "rps", deroVoice: true, requireApproval: true }));

		await vi.waitFor(() => expect(speakMock).toHaveBeenCalledWith("guild-1", deroBrainCopy.dealer.challengersAsking[0]));
		expect(speakMock).toHaveBeenCalledOnce();
	});

	it("says nothing when a member asks to join with Dero voice off", async () => {
		storeMock.addPendingJoin.mockResolvedValue(makeRoom({ game: "rps", deroVoice: false, requireApproval: true, pendingJoinIds: [JOINER] }));
		await joinChallenge(makeButton(JOINER), makeRoom({ game: "rps", deroVoice: false, requireApproval: true }));
		await settle();

		expect(speakMock).not.toHaveBeenCalled();
	});

	it("says nothing while Dero is in another match's call", async () => {
		sessionMock.mockReturnValue({ channelId: "vc-2", startedByRoomId: "room-9" });
		storeMock.addPoolMember.mockResolvedValue(makeRoom({ game: "rps", deroVoice: true, spectatorIds: [JOINER] }));
		await joinChallenge(makeButton(JOINER), makeRoom({ game: "rps", deroVoice: true }));
		await settle();

		expect(speakMock).not.toHaveBeenCalled();
	});
});
