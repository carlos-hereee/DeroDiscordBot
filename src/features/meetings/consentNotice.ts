import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction, type Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy, type ICopyConfig, type IPluginCopy } from "@base/copy/index.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { postInChannel, type CardPayload } from "@utils/cardMessage.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { mentionBatches } from "@utils/mentions.js";
import { showNotice } from "@utils/textModal.js";
import { agreeToRecording, revokeMeetingConsent, type AgreeOutcome, type WithdrawalOutcome } from "./meetingConsent.js";
import { allowSpeakerEverywhere, dropSpeakerEverywhere } from "./meetingRecorder.js";

// ── consentNotice ───────────────────────────────────────────────────────────
// What:  the notice that asks members in 🏛️ Meeting Hall whether Dero may record them
//        (2026-11 item 388, owner decision D6), posted in 📝meeting-notes when a recording
//        starts and for each member who joins the hall during it, and its three buttons
//        (prefix mcon): I agree, No thanks and Stop recording me. Either of the last two is a
//        full withdrawal (2026-11 item 420): a member who agreed at an earlier meeting and
//        presses No thanks at this one has said no.
// Who:   meetingLifecycle (the start), meetingPresence (a member joining mid meeting),
//        main.ts (registerConsentButtons, with the lifecycle's room check as the hook).
// Does NOT: subscribe anyone. The recorder asks meetingConsent on every speaking start, so a
//        press here changes who is heard from that member's next word.
//
// The notice pings exactly the members it names: allowedMentions lists those ids and nothing
// else, so @everyone or a role in a meeting title can never ping.

/** Every consent customId: `mcon:<action>:<meetingId>`. */
export const CONSENT_PREFIX = "mcon";
const ACTIONS = { agree: "agree", decline: "decline", revoke: "revoke" } as const;

const consentCustomId = (action: string, meetingId: string): string => `${CONSENT_PREFIX}:${action}:${meetingId}`;

/** Told after a member agrees or revokes, so the lifecycle can recount who in the hall agreed. */
export type ConsentChangeHook = (client: Client, guildId: string, userId: string) => Promise<void>;

/** The consent notice for these members. Exported for the tests. */
export function buildConsentNotice(copy: IPluginCopy, input: { meetingId: string; title: string; hostId: string; memberIds: readonly string[] }): CardPayload {
	const words = copy.meetingRecording.consent;
	const mentions = input.memberIds.map((id) => `<@${id}>`).join(" ");
	const ttlDays = BOT_CONSTANTS.MEETINGS.TRANSCRIPT_TTL_DAYS;
	return {
		embeds: [infoEmbed(words.title, words.body(mentions, input.hostId, input.title, ttlDays))],
		components: [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(consentCustomId(ACTIONS.agree, input.meetingId)).setLabel(words.agree).setStyle(ButtonStyle.Success),
				new ButtonBuilder().setCustomId(consentCustomId(ACTIONS.decline, input.meetingId)).setLabel(words.decline).setStyle(ButtonStyle.Secondary),
				new ButtonBuilder().setCustomId(consentCustomId(ACTIONS.revoke, input.meetingId)).setLabel(words.revoke).setStyle(ButtonStyle.Danger)
			),
		],
		content: mentions.length > 0 ? mentions : undefined,
		allowedMentions: { parse: [], roles: [], users: [...input.memberIds] },
	};
}

/**
 * Post the notice in 📝meeting-notes, one message per batch of members, each naming and pinging
 * exactly its own (a full hall passes what one message may hold). Answers which members Discord
 * accepted a notice for: only they may be heard (2026-11 item 420). Never throws.
 */
export async function postConsentNotice(
	client: Client,
	channelId: string,
	copy: IPluginCopy,
	input: { meetingId: string; title: string; hostId: string; memberIds: readonly string[] }
): Promise<string[]> {
	const asked: string[] = [];
	// The content is the mentions and nothing else, so nothing is reserved.
	for (const memberIds of mentionBatches(input.memberIds, 0)) {
		const accepted = await postInChannel(client, channelId, buildConsentNotice(copy, { ...input, memberIds })).catch(() => false);
		if (accepted) asked.push(...memberIds);
	}
	return asked;
}

// ── the buttons ─────────────────────────────────────────────────────────────

/** What a withdrawal press is told: what it came to, or that its write failed. */
export type WithdrawalAnswer = WithdrawalOutcome | "failed";

/**
 * A withdrawal, No thanks and Stop recording me alike, in the order that keeps every promise:
 * ① the member's live buffer is dropped and their place in the consent queue is taken, both
 * before any await, so no further chunk of theirs flushes and no later press overtakes this one,
 * ② the row says revoked, ③ `answer` tells the member, inside Discord's three second window,
 * ④ their words leave every meeting not yet summarized, once any chunk already at the provider
 * (up to MEETINGS.STT_TIMEOUT_MS) has settled, so no write lands after the delete.
 * ③ never holds up ④: an answer Discord refuses, or one waiting on a slow read, is logged and
 * the removal runs anyway.
 */
export async function stopRecordingMember(guildId: string, userId: string, answer: (outcome: WithdrawalAnswer) => Promise<void>): Promise<void> {
	const dropped = dropSpeakerEverywhere(guildId, userId);
	const withdrawal = revokeMeetingConsent(guildId, userId);
	const outcome = await withdrawal.outcome.catch((error: unknown): WithdrawalAnswer => {
		console.error(`[meetings] withdrawal not written, kept for the repair pass guild=${guildId} member=${userId}`, error instanceof Error ? error.name : "unknown");
		return "failed";
	});
	const answered = answer(outcome).catch((error: unknown) =>
		console.warn(`[meetings] a withdrawal was not answered guild=${guildId}`, error instanceof Error ? error.name : "unknown")
	);
	await dropped;
	await withdrawal.finish();
	await answered;
}

// The same withdrawal reads differently by button only where the member never agreed, since each
// button said something else to them.
function withdrawalLine(outcome: WithdrawalAnswer, action: string, words: IPluginCopy["meetingRecording"]["consent"]): string {
	switch (outcome) {
		case "withdrawn":
			return words.revoked;
		case "alreadyWithdrawn":
			return words.alreadyWithdrawn;
		case "neverAgreed":
			return action === ACTIONS.decline ? words.declined : words.notAgreed;
		case "failed":
			return words.withdrawFailed;
	}
}

// An accept that threw is answered like a removal that failed: press again. The line claims
// nothing about the row, because a write that failed on the way back may have landed.
async function agreeAndHear(guildId: string, userId: string): Promise<AgreeOutcome> {
	const outcome = await agreeToRecording(guildId, userId).catch((error: unknown): AgreeOutcome => {
		console.error(`[meetings] an agree was not written guild=${guildId} member=${userId}`, error instanceof Error ? error.name : "unknown");
		return "removalFailed";
	});
	if (outcome === "agreed") allowSpeakerEverywhere(guildId, userId);
	return outcome;
}

function agreeLine(outcome: AgreeOutcome, words: IPluginCopy["meetingRecording"]["consent"]): string {
	if (outcome === "agreed") return words.agreed;
	return outcome === "overtaken" ? words.alreadyWithdrawn : words.agreeFailed;
}

async function handleConsentButton(interaction: ButtonInteraction, onChange: ConsentChangeHook): Promise<void> {
	const [, action] = interaction.customId.split(":");
	const guildId = interaction.guildId;
	if (!guildId) return;
	const userId = interaction.user.id;
	// The config only picks the voice of the answer, so a withdrawal is under way before it is
	// read, and a failed read answers in the default voice.
	const say = async (line: (words: IPluginCopy["meetingRecording"]["consent"]) => string): Promise<void> => {
		const config = await guildConfigStore.findByGuildId(guildId).catch(() => null);
		const copy = getPluginCopy(config as unknown as ICopyConfig | null);
		await showNotice(interaction, { title: copy.meetingRecording.noticeTitle, sections: [line(copy.meetingRecording.consent)] });
	};

	if (action === ACTIONS.agree) {
		const outcome = await agreeAndHear(guildId, userId);
		await say((words) => agreeLine(outcome, words));
	}
	else if (action === ACTIONS.decline || action === ACTIONS.revoke) {
		await stopRecordingMember(guildId, userId, (outcome) => say((words) => withdrawalLine(outcome, action, words)));
	}
	else return;
	await onChange(interaction.client, guildId, userId).catch((error: unknown) =>
		console.warn(`[meetings] consent change follow up failed guild=${guildId}`, error instanceof Error ? error.name : "unknown")
	);
}

/** Register the mcon buttons. Called once at boot from main.ts with the lifecycle's room check. */
export function registerConsentButtons(onChange: ConsentChangeHook): void {
	registerButton(CONSENT_PREFIX, (interaction) => handleConsentButton(interaction, onChange));
}
