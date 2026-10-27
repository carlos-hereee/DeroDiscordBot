import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType, type ButtonInteraction, type CategoryChannel, type Guild, type GuildMember, type ModalSubmitInteraction, type StringSelectMenuInteraction } from "discord.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import type { RoomOpenInput, RoomOpenResult } from "@features/game-rooms/RoomProvisioner.js";
import type { VoiceSessionView } from "@features/voice/voiceSessions.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import {
	handleRulesCardButton,
	handleRulesCardModal,
	handleRulesCardSelect,
	presentRulesCardInCall,
	rulesCardFor,
	HOLDEM_CARD_PREFIX,
	type RulesCardDeps,
	type RulesCardPayload,
} from "./holdemRulesCard.js";
import { createHoldemRequest, getHoldemRequest, _clearHoldemRequests } from "./holdemRequests.js";
import { resolveTerms, STANDARD_HOLDEM_TERMS } from "./holdemTerms.js";
import { executeActions } from "./executor.js";
import { deroBrainCopy } from "./deroBrainCopy.js";

// ── holdemRulesCard ───────────────────────────────────────────────────────
// The whole card flow against fakes: the rules it shows (standard or custom),
// Change rules, the invite picker, who may press, expiry, Cancel, every
// provisioner refusal, and both visibilities reaching RoomProvisioner.open with
// the right terms. Nothing here touches Discord or Mongo.

const GUILD_ID = "100000000000000001";
const OWNER_ID = "300000000000000001";
const SPEAKER_ID = "300000000000000002";
const STRANGER_ID = "300000000000000003";
const FRIEND_A = "300000000000000004";
const FRIEND_B = "300000000000000005";
const TASKER_ROLE = "400000000000000001";
const CONTROL_CHANNEL = "200000000000000001";
const ROOM_CHANNEL = "200000000000000009";
const NOW = 1_800_000_000_000;

const OWNER_TERMS = { maxSeats: 6, startingStack: 5000, smallBlind: 100, bigBlind: 200 };
const card = deroBrainCopy.holdem;

const CONFIG = {
	guildId: GUILD_ID,
	enabled: true,
	voiceId: "voice-1",
	allowedRoleIds: [TASKER_ROLE],
	allowedChannelIds: [],
	allowedVoiceChannelIds: [],
} as unknown as IDeroVoiceConfig;

const member = (id: string, roles: string[] = [TASKER_ROLE]) =>
	({ id, displayName: "Host", user: { username: "host" }, guild: { id: GUILD_ID }, roles: { cache: new Set(roles) } }) as unknown as GuildMember;

function fakeGuild() {
	const send = vi.fn(async () => ({ id: "card-message" }));
	const control = { id: CONTROL_CHANNEL, isSendable: () => true, send };
	const guild = { id: GUILD_ID, ownerId: OWNER_ID, channels: { cache: new Map([[CONTROL_CHANNEL, control]]) } } as unknown as Guild;
	return { guild, send };
}

const category = { id: "cat-1", type: ChannelType.GuildCategory } as unknown as CategoryChannel;

function fakeDeps(overrides: Partial<RulesCardDeps> = {}) {
	let now = NOW;
	const speak = vi.fn(() => "queued" as const);
	const call = { guildId: GUILD_ID, channelId: "vc", controlChannelId: CONTROL_CHANNEL, status: "ready", speaker: { speak } } as unknown as VoiceSessionView;
	const opened: RoomOpenResult = {
		ok: true,
		room: { roomId: "room-1" } as never,
		channel: { id: ROOM_CHANNEL, name: "holdem-host" } as never,
	};
	const deps: RulesCardDeps = {
		now: () => now,
		loadConfig: vi.fn(async () => CONFIG),
		fetchMember: vi.fn(async (_guild: Guild, userId: string) => member(userId)),
		resolveArcade: vi.fn(async () => ({ category, adminRoleId: "admin-role" })),
		openRoom: vi.fn(async (_input: RoomOpenInput) => opened),
		inviteOptions: vi.fn(async () => [
			{ label: "Friend A", value: FRIEND_A, description: "@a" },
			{ label: "Friend B", value: FRIEND_B, description: "@b" },
		]),
		refilterInvitees: vi.fn(async (_guild: Guild, values: readonly string[]) => values.filter((id) => id !== SPEAKER_ID)),
		sessionIn: vi.fn(() => null),
		render: vi.fn(async () => ({ status: "ok" as const, pcm48kStereo: Buffer.from([1]), cached: false })),
		registerDealer: vi.fn(),
		audit: vi.fn(),
		...overrides,
	};
	return { deps, call, speak, advance: (ms: number) => (now += ms) };
}

function button(action: string, requestId: string, userId = SPEAKER_ID, guild = fakeGuild().guild) {
	return {
		customId: `${HOLDEM_CARD_PREFIX}:${action}:${requestId}`,
		guild,
		user: { id: userId },
		reply: vi.fn(async () => undefined),
		update: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		showModal: vi.fn(async () => undefined),
	} as unknown as ButtonInteraction & Record<"reply" | "update" | "deferUpdate" | "editReply" | "showModal", ReturnType<typeof vi.fn>>;
}

function picker(requestId: string, values: string[]) {
	return {
		customId: `${HOLDEM_CARD_PREFIX}:invitees:${requestId}`,
		guild: fakeGuild().guild,
		user: { id: SPEAKER_ID },
		values,
		reply: vi.fn(async () => undefined),
		update: vi.fn(async () => undefined),
	} as unknown as StringSelectMenuInteraction & Record<"reply" | "update", ReturnType<typeof vi.fn>>;
}

function modal(requestId: string, fields: Record<string, string>) {
	return {
		customId: `${HOLDEM_CARD_PREFIX}:rules:${requestId}`,
		guild: fakeGuild().guild,
		user: { id: SPEAKER_ID },
		fields: { getTextInputValue: (id: string) => fields[id] ?? "" },
		isFromMessage: () => true,
		reply: vi.fn(async () => undefined),
		update: vi.fn(async () => undefined),
	} as unknown as ModalSubmitInteraction & Record<"reply" | "update", ReturnType<typeof vi.fn>>;
}

const newRequest = (terms = OWNER_TERMS) => createHoldemRequest({ guildId: GUILD_ID, speakerId: SPEAKER_ID, terms, now: NOW });

const description = (payload: { embeds: { data: { description?: string } }[] }): string =>
	payload.embeds.map((embed) => embed.data.description ?? "").join("\n");

// The line a private refusal or a card edit carried.
const replyLine = (mock: ReturnType<typeof vi.fn>): string => description(mock.mock.calls[0][0] as RulesCardPayload as never);

// The text of the notice modal a refused press opens instead of a private reply (2026-10
// item 254 Phase 5b).
const noticeLine = (interaction: { showModal: ReturnType<typeof vi.fn> }): string =>
	(interaction.showModal.mock.calls[0]?.[0] as { toJSON(): { components: { content?: string }[] } }).toJSON().components.map((component) => component.content ?? "").join("\n");

const componentsJson = (payload: RulesCardPayload) => payload.components.map((row) => row.toJSON());

beforeEach(() => _clearHoldemRequests());

describe("the card shows the rules in effect", () => {
	it("says standard for a request with no terms, the doubling blinds and that chips stay at the table", async () => {
		const { deps } = fakeDeps();
		const request = newRequest(STANDARD_HOLDEM_TERMS);
		const payload = (await rulesCardFor(fakeGuild().guild, request.id, deps))!;
		const text = description(payload as never);
		expect(text).toContain("Standard rules: up to 6 players, 1000 chips each, blinds 10 and 20, and the blinds double every 6 hands.");
		expect(text).toContain(card.chipsLine);
	});

	it("lists custom terms: the owner's 6 seats, 5000 chips, blinds 100 and 200", async () => {
		const { deps } = fakeDeps();
		const text = description((await rulesCardFor(fakeGuild().guild, newRequest().id, deps)) as never);
		expect(text).toContain("Custom rules: up to 6 players, 5000 chips each, blinds 100 and 200, and the blinds double every 6 hands.");
	});

	it("offers the picker and four buttons, with Open invite only disabled until somebody is picked", async () => {
		const { deps } = fakeDeps();
		const payload = (await rulesCardFor(fakeGuild().guild, newRequest().id, deps))!;
		const [pickerRow, buttons] = componentsJson(payload) as { components: { custom_id: string; disabled?: boolean; label?: string }[] }[];
		expect(pickerRow.components[0].custom_id).toMatch(/^dero_holdem:invitees:/);
		expect(buttons.components.map((entry) => entry.label)).toEqual([card.openPublicLabel, card.openInviteLabel, card.changeRulesLabel, card.cancelLabel]);
		expect(buttons.components[1].disabled).toBe(true);
		expect(HOLDEM_CARD_PREFIX).not.toContain(":");
	});

	it("is made by the executor from the brain's open_holdem, which opens nothing", async () => {
		const { guild } = fakeGuild();
		const reports = await executeActions({
			guild,
			speakerId: SPEAKER_ID,
			actions: [{ type: "open_holdem" }],
			voiceConfig: CONFIG,
			deps: { fetchMember: async () => member(SPEAKER_ID) },
		});
		expect(reports[0].outcome).toBe("rules_card");
		expect(getHoldemRequest(reports[0].holdemRequestId!)?.terms).toEqual(STANDARD_HOLDEM_TERMS);
	});
});

describe("Change rules", () => {
	it("opens a modal prefilled with the current terms", async () => {
		const { deps } = fakeDeps();
		const request = newRequest(STANDARD_HOLDEM_TERMS);
		const interaction = button("rules", request.id);
		await handleRulesCardButton(interaction, deps);
		const built = interaction.showModal.mock.calls[0][0] as { toJSON(): { custom_id: string; components: { components: { value?: string }[] }[] } };
		const json = built.toJSON();
		expect(json.custom_id).toBe(`dero_holdem:rules:${request.id}`);
		expect(json.components.map((row) => row.components[0].value)).toEqual(["6", "1000", "20"]);
	});

	it("checks the typed terms and redraws the card with them", async () => {
		const { deps } = fakeDeps();
		const request = newRequest(STANDARD_HOLDEM_TERMS);
		const interaction = modal(request.id, { seats: "6", stack: "5000", bigBlind: "200" });
		await handleRulesCardModal(interaction, deps);
		expect(getHoldemRequest(request.id, NOW)?.terms).toEqual(OWNER_TERMS);
		expect(description(interaction.update.mock.calls[0][0] as never)).toContain("Custom rules: up to 6 players, 5000 chips each, blinds 100 and 200");
	});

	it("refuses an out of bounds term privately and keeps the card as it was", async () => {
		const { deps } = fakeDeps();
		const request = newRequest(STANDARD_HOLDEM_TERMS);
		const interaction = modal(request.id, { seats: "7", stack: "1000", bigBlind: "20" });
		await handleRulesCardModal(interaction, deps);
		expect(interaction.update).not.toHaveBeenCalled();
		expect(replyLine(interaction.reply)).toBe("A table seats 2 to 6 players.");
		expect(getHoldemRequest(request.id, NOW)?.terms).toEqual(STANDARD_HOLDEM_TERMS);
	});

	it("reads a blank field as the standard term and letters as not a number", async () => {
		const { deps } = fakeDeps();
		const request = newRequest(STANDARD_HOLDEM_TERMS);
		await handleRulesCardModal(modal(request.id, { seats: "", stack: "5000", bigBlind: "" }), deps);
		expect(getHoldemRequest(request.id, NOW)?.terms).toEqual({ maxSeats: 6, startingStack: 5000, smallBlind: 10, bigBlind: 20 });
		const bad = modal(request.id, { seats: "six", stack: "5000", bigBlind: "200" });
		await handleRulesCardModal(bad, deps);
		expect(replyLine(bad.reply)).toContain("whole number");
	});
});

describe("who may press", () => {
	it("refuses anyone but the member who asked, and opens nothing", async () => {
		const { deps } = fakeDeps();
		const interaction = button("public", newRequest().id, STRANGER_ID);
		await handleRulesCardButton(interaction, deps);
		expect(noticeLine(interaction)).toBe(card.notYours);
		expect(deps.openRoom).not.toHaveBeenCalled();
	});

	it("re-runs the authorizer at press time", async () => {
		const { deps } = fakeDeps({ fetchMember: vi.fn(async () => member(SPEAKER_ID, [])) });
		const interaction = button("public", newRequest().id);
		await handleRulesCardButton(interaction, deps);
		expect(noticeLine(interaction)).toBe(card.notAuthorized);
		expect(deps.openRoom).not.toHaveBeenCalled();
	});

	it("re-checks the kill switch at press time", async () => {
		const { deps } = fakeDeps({ loadConfig: vi.fn(async () => ({ ...CONFIG, enabled: false }) as IDeroVoiceConfig) });
		const interaction = button("public", newRequest().id);
		await handleRulesCardButton(interaction, deps);
		expect(noticeLine(interaction)).toBe(card.switchedOff);
	});

	it("answers an expired card plainly", async () => {
		const { deps, advance } = fakeDeps();
		const request = newRequest();
		advance(BOT_CONSTANTS.DERO_HOLDEM_REQUEST_TTL_MS);
		const interaction = button("public", request.id);
		await handleRulesCardButton(interaction, deps);
		expect(noticeLine(interaction)).toBe(card.expired);
		expect(deps.openRoom).not.toHaveBeenCalled();
	});

	it("answers a replaced card as expired: one pending request per speaker", async () => {
		const { deps } = fakeDeps();
		const first = newRequest();
		newRequest(STANDARD_HOLDEM_TERMS);
		const interaction = button("public", first.id);
		await handleRulesCardButton(interaction, deps);
		expect(noticeLine(interaction)).toBe(card.expired);
	});
});

describe("Cancel", () => {
	it("drops the request and edits the card, opening nothing", async () => {
		const { deps } = fakeDeps();
		const request = newRequest();
		const interaction = button("cancel", request.id);
		await handleRulesCardButton(interaction, deps);
		expect(getHoldemRequest(request.id, NOW)).toBeNull();
		expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
		expect(description(interaction.update.mock.calls[0][0] as never)).toBe(card.cancelled);
		expect(deps.openRoom).not.toHaveBeenCalled();
	});
});

describe("Open", () => {
	it("opens a public table with the speaker as the only member of the pool and the request's terms", async () => {
		const { deps } = fakeDeps();
		const interaction = button("public", newRequest().id);
		await handleRulesCardButton(interaction, deps);
		expect(deps.openRoom).toHaveBeenCalledWith(
			expect.objectContaining({
				category,
				game: "holdem",
				hostId: SPEAKER_ID,
				hostDisplayName: "Host",
				playerIds: [SPEAKER_ID],
				spectatorIds: [],
				visibility: "public",
				adminRoleId: "admin-role",
				holdemTerms: OWNER_TERMS,
			}),
		);
		expect(interaction.deferUpdate).toHaveBeenCalled();
		expect(description(interaction.editReply.mock.calls[0][0] as never)).toBe(card.opened(ROOM_CHANNEL));
		expect(deps.registerDealer).toHaveBeenCalledWith({ roomId: "room-1", guildId: GUILD_ID, channelId: ROOM_CHANNEL, voice: false });
	});

	it("refuses invite only until somebody is picked", async () => {
		const { deps } = fakeDeps();
		const interaction = button("invite", newRequest().id);
		await handleRulesCardButton(interaction, deps);
		expect(noticeLine(interaction)).toBe(card.pickInviteesFirst);
		expect(deps.openRoom).not.toHaveBeenCalled();
	});

	it("opens an invite only table with the picked members, re-filtered on the server", async () => {
		const { deps } = fakeDeps();
		const request = newRequest();
		const pick = picker(request.id, [FRIEND_A, FRIEND_B, SPEAKER_ID]);
		await handleRulesCardSelect(pick, deps);
		expect(getHoldemRequest(request.id, NOW)?.invitedIds).toEqual([FRIEND_A, FRIEND_B]);
		const redrawn = pick.update.mock.calls[0][0] as RulesCardPayload;
		expect(description(redrawn as never)).toContain(`<@${FRIEND_A}>`);
		const buttons = componentsJson(redrawn)[1] as { components: { disabled?: boolean }[] };
		expect(buttons.components[1].disabled).toBe(false);

		await handleRulesCardButton(button("invite", request.id), deps);
		expect(deps.openRoom).toHaveBeenCalledWith(
			expect.objectContaining({ visibility: "invite", playerIds: [SPEAKER_ID, FRIEND_A, FRIEND_B], spectatorIds: [], holdemTerms: OWNER_TERMS }),
		);
	});

	it.each<[string, RoomOpenResult, string]>([
		["alreadyHosting, with a link to the room", { ok: false, reason: "alreadyHosting", existingChannelId: "200000000000000077" }, "<#200000000000000077>"],
		["guildFull", { ok: false, reason: "guildFull" }, "rooms open"],
		["the tier's private limit", { ok: false, reason: "privateQuotaHit", quota: 2, tier: "pro" }, "private room limit (2)"],
		["createFailed", { ok: false, reason: "createFailed" }, "Something went wrong opening that room."],
	])("reports %s plainly on the card", async (_label, result, expected) => {
		const { deps } = fakeDeps({ openRoom: vi.fn(async () => result) });
		const request = newRequest();
		const interaction = button("public", request.id);
		await handleRulesCardButton(interaction, deps);
		const line = description(interaction.editReply.mock.calls[0][0] as never);
		expect(line).toContain(expected);
		expect(line).toContain("No table was opened.");
		expect(deps.registerDealer).not.toHaveBeenCalled();
		expect(getHoldemRequest(request.id, NOW)).toBeNull();
	});

	it("says so when the server has no arcade", async () => {
		const { deps } = fakeDeps({ resolveArcade: vi.fn(async () => null) });
		const interaction = button("public", newRequest().id);
		await handleRulesCardButton(interaction, deps);
		expect(description(interaction.editReply.mock.calls[0][0] as never)).toContain(gameRoomsCopy.errors.noArcadeCategory);
		expect(deps.openRoom).not.toHaveBeenCalled();
	});
});

describe("a card from a voice call", () => {
	it("is posted in the call's text channel mentioning only the speaker", async () => {
		const { deps } = fakeDeps();
		const { guild, send } = fakeGuild();
		const request = newRequest();
		expect(await presentRulesCardInCall({ guild, requestId: request.id, controlChannelId: CONTROL_CHANNEL }, deps)).toBe(true);
		const sent = send.mock.calls[0][0] as { content: string; allowedMentions: unknown };
		expect(sent.content).toBe(card.forSpeaker(SPEAKER_ID));
		expect(sent.allowedMentions).toEqual({ parse: [], roles: [], users: [SPEAKER_ID], repliedUser: false });
		expect(getHoldemRequest(request.id, NOW)).toMatchObject({ source: "voice", controlChannelId: CONTROL_CHANNEL });
	});

	it("makes Dero the voiced dealer on Open and says the table is open aloud", async () => {
		const { deps, call, speak } = fakeDeps();
		deps.sessionIn = vi.fn(() => call);
		const { guild } = fakeGuild();
		const request = newRequest();
		await presentRulesCardInCall({ guild, requestId: request.id, controlChannelId: CONTROL_CHANNEL }, deps);
		await handleRulesCardButton(button("public", request.id, SPEAKER_ID, guild), deps);
		expect(deps.registerDealer).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room-1", voice: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(deps.render).toHaveBeenCalledWith(expect.objectContaining({ text: card.openedSpoken("holdem-host") }));
		expect(speak).toHaveBeenCalledWith(expect.any(Buffer), "brain");
	});

	it("deals by text only when the call ended before Open", async () => {
		const { deps } = fakeDeps();
		const { guild } = fakeGuild();
		const request = newRequest();
		await presentRulesCardInCall({ guild, requestId: request.id, controlChannelId: CONTROL_CHANNEL }, deps);
		await handleRulesCardButton(button("public", request.id, SPEAKER_ID, guild), deps);
		expect(deps.registerDealer).toHaveBeenCalledWith(expect.objectContaining({ voice: false }));
		expect(deps.render).not.toHaveBeenCalled();
	});
});

describe("terms from the brain", () => {
	it("are the same terms the card shows", () => {
		expect(resolveTerms({ maxSeats: 6, startingStack: 5000, bigBlind: 200 })).toEqual({ ok: true, terms: OWNER_TERMS });
	});
});
