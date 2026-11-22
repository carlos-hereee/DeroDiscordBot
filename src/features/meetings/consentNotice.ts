import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction, type Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy, type ICopyConfig, type IPluginCopy } from "@base/copy/index.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { postInChannel, type CardPayload } from "@utils/cardMessage.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { showNotice } from "@utils/textModal.js";
import { agreeToRecording, removeWordsFromOpenMeetings, revokeMeetingConsent } from "./meetingConsent.js";
import { allowSpeakerEverywhere, dropSpeakerEverywhere } from "./meetingRecorder.js";

// ── consentNotice ───────────────────────────────────────────────────────────
// What:  the notice that asks members in 🏛️ Meeting Hall whether Dero may record them
//        (2026-11 item 388, owner decision D6), posted in 📝meeting-notes when a recording
//        starts and for each member who joins the hall during it, and its three buttons
//        (prefix mcon): I agree, No thanks and Stop recording me.
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

/** Post the notice in 📝meeting-notes. False when it could not be posted. Never throws. */
export async function postConsentNotice(
	client: Client,
	channelId: string,
	copy: IPluginCopy,
	input: { meetingId: string; title: string; hostId: string; memberIds: readonly string[] }
): Promise<boolean> {
	return postInChannel(client, channelId, buildConsentNotice(copy, input)).catch(() => false);
}

// ── the buttons ─────────────────────────────────────────────────────────────

/**
 * Stop recording me, in the order that keeps every promise: ① the member's live buffer is
 * dropped (a sync step, before any await, so no further chunk of theirs flushes), ② the row
 * and the trust cache say revoked, ③ `answer` tells the member, inside Discord's three second
 * window, ④ their words leave every meeting not yet summarized, once any chunk already at the
 * provider (up to MEETINGS.STT_TIMEOUT_MS) has settled, so no write lands after the delete.
 */
export async function stopRecordingMember(guildId: string, userId: string, answer: (hadConsent: boolean) => Promise<void>): Promise<void> {
	const dropped = dropSpeakerEverywhere(guildId, userId);
	const hadConsent = await revokeMeetingConsent(guildId, userId);
	await answer(hadConsent);
	await dropped;
	await removeWordsFromOpenMeetings(guildId, userId);
}

async function handleConsentButton(interaction: ButtonInteraction, onChange: ConsentChangeHook): Promise<void> {
	const [, action] = interaction.customId.split(":");
	const guildId = interaction.guildId;
	if (!guildId) return;
	const config = await guildConfigStore.findByGuildId(guildId);
	const copy = getPluginCopy(config as unknown as ICopyConfig | null);
	const words = copy.meetingRecording.consent;
	const userId = interaction.user.id;
	const say = (line: string): Promise<void> => showNotice(interaction, { title: copy.meetingRecording.noticeTitle, sections: [line] });

	// No thanks writes nothing (R7): a member who never agreed has no row to keep.
	if (action === ACTIONS.decline) return say(words.declined);
	if (action === ACTIONS.agree) {
		await agreeToRecording(guildId, userId);
		allowSpeakerEverywhere(guildId, userId);
		await say(words.agreed);
	}
	else if (action === ACTIONS.revoke) {
		await stopRecordingMember(guildId, userId, (hadConsent) => say(hadConsent ? words.revoked : words.notAgreed));
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
