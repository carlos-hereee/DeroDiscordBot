import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type CategoryChannel,
	type EmbedBuilder,
	type Guild,
	type GuildMember,
	type MessageActionRowComponentBuilder,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { resolveDeroVoiceId } from "@features/voice/deroVoiceId.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton, registerModal, registerSelectMenu } from "@handlers/interactionRegistry.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { RoomProvisioner, describeRoomOpenFailure, type RoomOpenInput, type RoomOpenResult } from "@features/game-rooms/RoomProvisioner.js";
import { buildInviteOptions, refilterInvitees, type InviteOption } from "@features/game-rooms/invitePicker.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { renderCallSpeech, type CallSpeechInput, type CallSpeechResult } from "@features/voice/callSpeech.js";
import { voiceSessions, type VoiceSessionView } from "@features/voice/voiceSessions.js";
import { isAuthorizedSpeaker } from "./authorizer.js";
import { readSpeakerAdminRoleId } from "./speakerAdminRole.js";
import { registerDealerTable, type RegisterDealerInput } from "./dealerNarration.js";
import { deroBrainCopy } from "./deroBrainCopy.js";
import { describeTerms, describeTermsRefusal, resolveTerms, type HoldemTermsRequest } from "./holdemTerms.js";
import { dropHoldemRequest, getHoldemRequest, type HoldemRequest, type HoldemVisibilityChoice } from "./holdemRequests.js";
import { showErrorNotice } from "@utils/textModal.js";

// ── holdemRulesCard ───────────────────────────────────────────────────────
// What:  the card that stands between "Dero, open a Hold'em table" and a real
//        room: it shows the rules in effect, lets the host change them, pick who
//        to invite, choose public or invite only, or cancel, and then opens the
//        room through RoomProvisioner.
// Who:   presented by /dero tell (as its private reply) and by the voice turn
//        loop (posted in the call's text channel); pressed only by the member
//        who asked. Registered once from main.ts.
// When:  between the brain's open_holdem and the host's press, two minutes at
//        most (holdemRequests).
// Where: the buttons ARE the confirmation; nothing opens without one, and no
//        spoken or typed "yes" stands in for it. The room comes from the
//        provisioner and the guild's arcade category, never from the request.
//        The provisioner runs the game room entitlement check and the one open
//        room per host rule, so this file reports its refusals and runs no
//        check of its own.
// How:   every press runs the same gate first: ① the request is live (not
//        expired, not replaced); ② the presser is the member who asked;
//        ③ the kill switch and the authorizer, re-run now, because a role can be
//        removed while the card sits there. Then the press: Open public, Open
//        invite only (needs at least one invitee), Change rules (a modal checked
//        by resolveTerms), the invite picker, or Cancel.
//
// ⚠️ An invite only room admits only the members named when it opens (the
// permission matrix denies everyone else and nothing adds a member later), so
// the card carries the invite picker, and Open invite only stays disabled until
// somebody is picked. A host alone in an invite only room could never deal.

// Colon free on purpose: the interaction registry routes on the text before the
// first colon, so "dero:holdem" would land on a "dero" prefix (plan decision of
// Session 1, which renamed this from the spell's dero:holdem).
export const HOLDEM_CARD_PREFIX = "dero_holdem";

type CardAction = "public" | "invite" | "rules" | "cancel";
const CARD_ACTIONS: readonly CardAction[] = ["public", "invite", "rules", "cancel"];
const PICKER_ACTION = "invitees";

const MODAL_FIELD = { seats: "seats", stack: "stack", bigBlind: "bigBlind" } as const;
// Long enough for the largest stack (1000000), short enough to stop a paste.
const MODAL_FIELD_MAX_LENGTH = 7;
const MS_PER_SECOND = 1000;

const cardCopy = deroBrainCopy.holdem;

// ── deps ──

/** Everything a press touches outside this file, injected so tests use fakes. */
export interface RulesCardDeps {
	now(): number;
	loadConfig(guildId: string): Promise<IDeroVoiceConfig | null>;
	/** A fresh read of the member, bypassing the cache, or null when they left. */
	fetchMember(guild: Guild, userId: string): Promise<GuildMember | null>;
	/**
	 * GuildConfig.adminRoleId, which authorizes by itself (post-launch plan item 12).
	 * Optional so a test rig that never builds it keeps the allowlist only rule; the
	 * default deps always wire it to readSpeakerAdminRoleId.
	 */
	loadAdminRoleId?(guildId: string): Promise<string | null>;
	/** The guild's arcade category and admin role, or null when the arcade was never built. */
	resolveArcade(guild: Guild): Promise<{ category: CategoryChannel; adminRoleId: string | null } | null>;
	openRoom(input: RoomOpenInput): Promise<RoomOpenResult>;
	inviteOptions(guild: Guild, hostId: string): Promise<InviteOption[]>;
	refilterInvitees(guild: Guild, values: readonly string[], hostId: string): Promise<string[]>;
	sessionIn(guildId: string): VoiceSessionView | null;
	render(input: CallSpeechInput): Promise<CallSpeechResult>;
	registerDealer(input: RegisterDealerInput): void;
	audit(guildId: string, metadata: Record<string, unknown>): void;
}

async function resolveArcade(guild: Guild): Promise<{ category: CategoryChannel; adminRoleId: string | null } | null> {
	// The same read the challenge board makes: the games category and admin role
	// live on the guild config, written by /setup.
	const stored = await guildConfigStore.findByGuildId(guild.id);
	const config = stored as unknown as { gamesCategoryId?: string | null; adminRoleId?: string | null } | null;
	const categoryId = config?.gamesCategoryId;
	const category = categoryId ? await guild.channels.fetch(categoryId).catch(() => null) : null;
	if (!category || category.type !== ChannelType.GuildCategory) return null;
	return { category, adminRoleId: config?.adminRoleId ?? null };
}

export const defaultRulesCardDeps: RulesCardDeps = {
	now: () => Date.now(),
	loadConfig: (guildId) => deroVoiceConfigStore.findByGuildId(guildId),
	// force: true for the same reason as the executor: the cached member is the
	// stale copy a press time re-check exists to get past.
	fetchMember: (guild, userId) => guild.members.fetch({ user: userId, force: true }).catch(() => null),
	loadAdminRoleId: readSpeakerAdminRoleId,
	resolveArcade,
	openRoom: (input) => RoomProvisioner.open(input),
	inviteOptions: buildInviteOptions,
	refilterInvitees,
	sessionIn: (guildId) => voiceSessions.get(guildId),
	render: renderCallSpeech,
	registerDealer: registerDealerTable,
	// Fire and forget (house rule 7): ids and counts only.
	audit: (guildId, metadata) => {
		botLogStore.log(guildId, BOT_LOG_EVENTS.DERO_BRAIN_ACTION, metadata).catch((error) => {
			console.error(`[dero-brain] holdem card audit write failed guild=${guildId}`, error);
		});
	},
};

// ── the card ──

const customId = (action: string, requestId: string): string => `${HOLDEM_CARD_PREFIX}:${action}:${requestId}`;

/** What a rules card message carries: one embed, the picker row when anyone can be invited, and the buttons. */
export interface RulesCardPayload {
	embeds: EmbedBuilder[];
	components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

function cardEmbed(request: HoldemRequest): EmbedBuilder {
	const invited = request.invitedIds.length > 0 ? cardCopy.invited(request.invitedIds) : cardCopy.nobodyInvited;
	const expiresAt = Math.floor(request.expiresAt / MS_PER_SECOND);
	const body = [describeTerms(request.terms), cardCopy.chipsLine, "", invited, cardCopy.pickLine, "", cardCopy.expires(expiresAt)];
	return infoEmbed(cardCopy.cardTitle, body.join("\n"));
}

function pickerRow(request: HoldemRequest, options: InviteOption[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
	const select = new StringSelectMenuBuilder()
		.setCustomId(customId(PICKER_ACTION, request.id))
		.setPlaceholder(cardCopy.pickerPlaceholder)
		// Zero so a host can clear a pick, and the whole list at most.
		.setMinValues(0)
		.setMaxValues(options.length)
		.addOptions(options.map((option) => ({ ...option, default: request.invitedIds.includes(option.value) })));
	return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);
}

function buttonRow(request: HoldemRequest): ActionRowBuilder<MessageActionRowComponentBuilder> {
	return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
		new ButtonBuilder().setCustomId(customId("public", request.id)).setLabel(cardCopy.openPublicLabel).setStyle(ButtonStyle.Success),
		new ButtonBuilder()
			.setCustomId(customId("invite", request.id))
			.setLabel(cardCopy.openInviteLabel)
			.setStyle(ButtonStyle.Primary)
			.setDisabled(request.invitedIds.length === 0),
		new ButtonBuilder().setCustomId(customId("rules", request.id)).setLabel(cardCopy.changeRulesLabel).setStyle(ButtonStyle.Secondary),
		new ButtonBuilder().setCustomId(customId("cancel", request.id)).setLabel(cardCopy.cancelLabel).setStyle(ButtonStyle.Danger),
	);
}

/** Draw the card for a request. */
export async function buildRulesCard(guild: Guild, request: HoldemRequest, deps: RulesCardDeps = defaultRulesCardDeps): Promise<RulesCardPayload> {
	const options = await deps.inviteOptions(guild, request.speakerId);
	const rows = options.length > 0 ? [pickerRow(request, options), buttonRow(request)] : [buttonRow(request)];
	return { embeds: [cardEmbed(request)], components: rows };
}

/** The card for /dero tell's private reply, or null when the request is already gone. */
export async function rulesCardFor(guild: Guild, requestId: string, deps: RulesCardDeps = defaultRulesCardDeps): Promise<RulesCardPayload | null> {
	const request = getHoldemRequest(requestId, deps.now());
	if (!request || request.guildId !== guild.id) return null;
	return buildRulesCard(guild, request, deps);
}

export interface PresentInCallInput {
	guild: Guild;
	requestId: string;
	controlChannelId: string;
}

/**
 * Post a voice ask's card in the call's text channel, mentioning the speaker and
 * nobody else, and mark the request as voice so Open makes Dero the voiced
 * dealer. Called by the voice turn loop after the brain answered. Never throws.
 */
export async function presentRulesCardInCall({ guild, requestId, controlChannelId }: PresentInCallInput, deps: RulesCardDeps = defaultRulesCardDeps): Promise<boolean> {
	try {
		const request = getHoldemRequest(requestId, deps.now());
		if (!request || request.guildId !== guild.id) return false;
		request.source = "voice";
		request.controlChannelId = controlChannelId;

		const channel = guild.channels.cache.get(controlChannelId);
		if (!channel || !channel.isSendable()) {
			console.warn(`[dero-brain] holdem card skipped guild=${guild.id} channel=${controlChannelId} reason=unavailable`);
			return false;
		}
		const card = await buildRulesCard(guild, request, deps);
		await channel.send({
			content: cardCopy.forSpeaker(request.speakerId),
			...card,
			// The one deliberate mention on the brain path: the member who asked.
			allowedMentions: { parse: [], roles: [], users: [request.speakerId], repliedUser: false },
		});
		return true;
	}
	catch (error) {
		const code = (error as { code?: unknown } | null)?.code ?? "unknown";
		console.error(`[dero-brain] holdem card post failed guild=${guild.id} channel=${controlChannelId} code=${String(code)}`);
		return false;
	}
}

// ── the press gate ──

type AnyCardInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

interface PassedGate {
	guild: Guild;
	request: HoldemRequest;
	member: GuildMember;
	config: IDeroVoiceConfig;
}

async function replyPrivately(interaction: AnyCardInteraction, line: string): Promise<void> {
	await showErrorNotice(interaction, line);
}

function parseCustomId(raw: string): { action: string; requestId: string } | null {
	const [prefix, action, requestId] = raw.split(":");
	if (prefix !== HOLDEM_CARD_PREFIX || !action || !requestId) return null;
	return { action, requestId };
}

// ① ② ③ Every refusal is a private line; nothing on the card changes.
async function passGate(interaction: AnyCardInteraction, requestId: string, deps: RulesCardDeps): Promise<PassedGate | null> {
	const guild = interaction.guild;
	const request = getHoldemRequest(requestId, deps.now());
	// A request from another guild reads as expired, never as "not yours": it
	// should not even confirm that the id exists.
	if (!guild || !request || request.guildId !== guild.id) {
		await replyPrivately(interaction, cardCopy.expired);
		return null;
	}
	if (interaction.user.id !== request.speakerId) {
		await replyPrivately(interaction, cardCopy.notYours);
		return null;
	}
	const config = await deps.loadConfig(guild.id);
	if (!config || !config.enabled || config.guildId !== guild.id) {
		await replyPrivately(interaction, cardCopy.switchedOff);
		return null;
	}
	const member = await deps.fetchMember(guild, interaction.user.id);
	const adminRoleId = deps.loadAdminRoleId ? await deps.loadAdminRoleId(guild.id) : null;
	if (!member || !isAuthorizedSpeaker({ member, guildOwnerId: guild.ownerId, adminRoleId, voiceConfig: config })) {
		await replyPrivately(interaction, cardCopy.notAuthorized);
		return null;
	}
	return { guild, request, member, config };
}

// ── Open ──

function playersFor(request: HoldemRequest, visibility: HoldemVisibilityChoice): string[] {
	// Hold em seats the whole pool (the board's "cooperative" sense): the host plus
	// every invitee may see the room and buy in. A public room needs nobody named,
	// because its one @everyone overwrite already lets the whole server in.
	return visibility === "invite" ? [request.speakerId, ...request.invitedIds] : [request.speakerId];
}

// Spoken after a voice ask's table opens. Fire and forget: the card already says it.
function speakOpened(gate: PassedGate, channelName: string, deps: RulesCardDeps): void {
	const call = deps.sessionIn(gate.guild.id);
	if (!call) return;
	deps
		.render({ guildId: gate.guild.id, voiceId: resolveDeroVoiceId(gate.config), text: cardCopy.openedSpoken(channelName) })
		.then((speech) => {
			if (speech.status === "ok" && deps.sessionIn(gate.guild.id) === call) call.speaker.speak(speech.pcm48kStereo, "brain");
		})
		.catch((error) => console.error(`[dero-brain] holdem open line failed guild=${gate.guild.id}`, error));
}

async function openTable(interaction: ButtonInteraction, gate: PassedGate, visibility: HoldemVisibilityChoice, deps: RulesCardDeps): Promise<void> {
	const { guild, request, member } = gate;
	if (visibility === "invite" && request.invitedIds.length === 0) {
		await replyPrivately(interaction, cardCopy.pickInviteesFirst);
		return;
	}

	// Opening builds a channel, which can take longer than Discord's 3 seconds.
	await interaction.deferUpdate();
	// Dropped before the open, so a second press while this one runs is "expired"
	// rather than a second room (the provisioner's in flight map covers the rest).
	dropHoldemRequest(request.id);
	request.visibility = visibility;

	try {
		await openDeferred(interaction, gate, visibility, deps);
	}
	catch (error) {
		// The press was deferred, so without this the card would sit on "thinking".
		console.error(`[dero-brain] holdem open failed guild=${guild.id} user=${member.id}`, error);
		await interaction
			.editReply({ embeds: [errorEmbed(cardCopy.openFailed(gameRoomsCopy.errors.createFailed))], components: [] })
			.catch(() => undefined);
	}
}

async function openDeferred(interaction: ButtonInteraction, gate: PassedGate, visibility: HoldemVisibilityChoice, deps: RulesCardDeps): Promise<void> {
	const { guild, request, member } = gate;
	const arcade = await deps.resolveArcade(guild);
	if (!arcade) {
		await interaction.editReply({ embeds: [errorEmbed(cardCopy.openFailed(gameRoomsCopy.errors.noArcadeCategory))], components: [] });
		return;
	}

	const result = await deps.openRoom({
		guild,
		category: arcade.category,
		game: "holdem",
		hostId: request.speakerId,
		hostDisplayName: member.displayName || member.user.username,
		playerIds: playersFor(request, visibility),
		spectatorIds: [],
		visibility,
		adminRoleId: arcade.adminRoleId,
		holdemTerms: request.terms,
	});
	deps.audit(guild.id, {
		kind: "holdem_open",
		speakerId: request.speakerId,
		source: request.source,
		visibility,
		invited: request.invitedIds.length,
		outcome: result.ok ? "opened" : result.reason,
		roomId: result.ok ? result.room.roomId : null,
	});

	if (!result.ok) {
		await interaction.editReply({ embeds: [errorEmbed(cardCopy.openFailed(describeRoomOpenFailure(result)))], components: [] });
		return;
	}

	// A voice ask with the call still open makes Dero the voiced dealer; every
	// other Dero table gets the dealer's text lines only.
	const voice = request.source === "voice" && deps.sessionIn(guild.id) !== null;
	deps.registerDealer({ roomId: result.room.roomId, guildId: guild.id, channelId: result.channel.id, voice });
	await interaction.editReply({ embeds: [infoEmbed(cardCopy.cardTitle, cardCopy.opened(result.channel.id))], components: [] });
	if (voice) speakOpened(gate, result.channel.name, deps);
}

// ── Change rules ──

function rulesModal(request: HoldemRequest): ModalBuilder {
	const field = (id: string, label: string, value: number) =>
		new ActionRowBuilder<TextInputBuilder>().addComponents(
			new TextInputBuilder()
				.setCustomId(id)
				.setLabel(label)
				.setStyle(TextInputStyle.Short)
				// Blank means "standard" for that term, so none is required.
				.setRequired(false)
				.setMaxLength(MODAL_FIELD_MAX_LENGTH)
				.setValue(String(value)),
		);
	return new ModalBuilder()
		.setCustomId(customId("rules", request.id))
		.setTitle(cardCopy.modalTitle)
		.addComponents(
			field(MODAL_FIELD.seats, cardCopy.seatsLabel(BOT_CONSTANTS.HOLDEM_MIN_SEATS, BOT_CONSTANTS.HOLDEM_MAX_SEATS), request.terms.maxSeats),
			field(MODAL_FIELD.stack, cardCopy.stackLabel(BOT_CONSTANTS.HOLDEM_TERMS_MIN_STACK, BOT_CONSTANTS.HOLDEM_TERMS_MAX_STACK), request.terms.startingStack),
			field(MODAL_FIELD.bigBlind, cardCopy.bigBlindLabel(BOT_CONSTANTS.HOLDEM_TERMS_MIN_BIG_BLIND), request.terms.bigBlind),
		);
}

// Blank is absent (the standard term); anything but digits becomes NaN, which
// resolveTerms refuses as not a whole number.
function readTerm(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** The three typed terms from a Change rules submit. */
export function readModalTerms(interaction: Pick<ModalSubmitInteraction, "fields">): HoldemTermsRequest {
	return {
		maxSeats: readTerm(interaction.fields.getTextInputValue(MODAL_FIELD.seats)),
		startingStack: readTerm(interaction.fields.getTextInputValue(MODAL_FIELD.stack)),
		bigBlind: readTerm(interaction.fields.getTextInputValue(MODAL_FIELD.bigBlind)),
	};
}

// ── handlers ──

/** A button on the card: Open public, Open invite only, Change rules or Cancel. */
export async function handleRulesCardButton(interaction: ButtonInteraction, deps: RulesCardDeps = defaultRulesCardDeps): Promise<void> {
	const parsed = parseCustomId(interaction.customId);
	if (!parsed || !CARD_ACTIONS.includes(parsed.action as CardAction)) {
		await replyPrivately(interaction, cardCopy.expired);
		return;
	}
	const gate = await passGate(interaction, parsed.requestId, deps);
	if (!gate) return;

	const action = parsed.action as CardAction;
	if (action === "rules") {
		await interaction.showModal(rulesModal(gate.request));
		return;
	}
	if (action === "cancel") {
		dropHoldemRequest(gate.request.id);
		deps.audit(gate.guild.id, { kind: "holdem_cancel", speakerId: gate.request.speakerId, source: gate.request.source });
		await interaction.update({ embeds: [infoEmbed(cardCopy.cardTitle, cardCopy.cancelled)], components: [] });
		return;
	}
	await openTable(interaction, gate, action, deps);
}

/** The invite picker on the card. */
export async function handleRulesCardSelect(interaction: StringSelectMenuInteraction, deps: RulesCardDeps = defaultRulesCardDeps): Promise<void> {
	const parsed = parseCustomId(interaction.customId);
	if (!parsed || parsed.action !== PICKER_ACTION) {
		await replyPrivately(interaction, cardCopy.expired);
		return;
	}
	const gate = await passGate(interaction, parsed.requestId, deps);
	if (!gate) return;

	gate.request.invitedIds = await deps.refilterInvitees(gate.guild, interaction.values, gate.request.speakerId);
	await interaction.update(await buildRulesCard(gate.guild, gate.request, deps));
}

/** The Change rules modal: check the typed terms, then redraw the card with them. */
export async function handleRulesCardModal(interaction: ModalSubmitInteraction, deps: RulesCardDeps = defaultRulesCardDeps): Promise<void> {
	const parsed = parseCustomId(interaction.customId);
	if (!parsed || parsed.action !== "rules") {
		await replyPrivately(interaction, cardCopy.expired);
		return;
	}
	const gate = await passGate(interaction, parsed.requestId, deps);
	if (!gate) return;

	const resolved = resolveTerms(readModalTerms(interaction));
	if (!resolved.ok) {
		await replyPrivately(interaction, describeTermsRefusal(resolved.reason));
		return;
	}
	gate.request.terms = resolved.terms;
	const card = await buildRulesCard(gate.guild, gate.request, deps);
	// The modal was opened from the card's own button, so it edits the card in
	// place; a submit Discord did not tie to it posts the card in 💬dero-commands
	// (2026-10 item 257 Phase 5), where passGate still holds it to its requester.
	if (interaction.isFromMessage()) await interaction.update(card);
	else await answerInChannel(interaction, "member", card);
}

/** Register the card's buttons, picker and modal. Called once at boot from main.ts. */
export function registerHoldemRulesCardHandlers(): void {
	registerButton(HOLDEM_CARD_PREFIX, (interaction) => handleRulesCardButton(interaction));
	registerSelectMenu(HOLDEM_CARD_PREFIX, (interaction) => handleRulesCardSelect(interaction));
	registerModal(HOLDEM_CARD_PREFIX, (interaction) => handleRulesCardModal(interaction));
}
