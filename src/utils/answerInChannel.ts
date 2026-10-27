import {
	ComponentType,
	MessageFlags,
	type ButtonInteraction,
	type InteractionReplyOptions,
	type InteractionResponse,
	type Message,
	type MessageCreateOptions,
	type RepliableInteraction,
	type SendableChannels,
	type StringSelectMenuInteraction,
} from "discord.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { acknowledgeTextModal, showNotice } from "./textModal.js";

// ── answerInChannel ──────────────────────────────────────────────────
// What:  posts an answer to a command, a button or a modal in the channel it belongs
//        in, instead of a private reply that sits under "Only you can see this •
//        Dismiss message" (2026-10 item 257, owner decision 7, Phase 5). A member's
//        answer posts in 💬dero-commands (GuildConfig.commandOutputChannelId); an
//        admin's answer posts in the matching 🏰 DERO HEADQUARTERS channel by its
//        domain. Every post mentions the member it answers, without a ping.
// Who:   every site the private reply audit kept private for Discord's reasons (a
//        slow answer after a defer, a modal Submit, a followUp, a reply carrying
//        buttons, an image or an embed with fields); the site list is the third pass
//        of companyuno-discord/docs/handoffs/dero-private-reply-audit-2026-10.md.
// Does NOT: decide what a command answers, gate who may press anything, or carry
//        private data. A hand, a fleet, a secret word or a recovery secret never comes
//        here; those stay private and are listed with their reason in that audit.
// How:   answerInChannel posts a finished answer. beginChannelAnswer is for a slow one:
//        it acknowledges the interaction inside Discord's three second window (a notice
//        modal naming the channel, or a quiet acknowledgement for a modal Submit), and
//        its send posts the answer once the work is done. askInChannel posts a confirm
//        then act prompt that only its asker can answer, and beginAnswerInPlace keeps a
//        public slash command answer where it was asked.
//
// ⚠️ THE ONE SANCTIONED PRIVATE REPLY: a server whose config stores no such channel
// (setup not rerun since Phase 2a), or whose channel is gone or refuses the post, is
// answered privately exactly as before. Without it that answer would be lost, and the
// private reply is the only place left that the member alone can read.

/** Who an answer is for, and so which channel it posts in. */
export type AnswerAudience =
	/** a member's answer: 💬dero-commands */
	| "member"
	/** Dero's own config and voice: ⚙️dero-config */
	| "deroConfig"
	/** Community and Onboarding: 🧭onboarding */
	| "onboarding"
	/** the arcade, the economy, chips and the network: 🎰arcade-control */
	| "arcade"
	/** every other admin answer: 🎛️admin-controls */
	| "admin";

/** The GuildConfig fields an answer's channel is read from. */
export interface AnswerChannelConfig extends ICopyConfig {
	commandOutputChannelId?: string | null;
	deroConfigChannelId?: string | null;
	onboardingConfigChannelId?: string | null;
	arcadeControlChannelId?: string | null;
	adminCommandsChannelId?: string | null;
}

/** What an answer carries in its channel. Components ride along, so a control lives in the channel. */
export type ChannelAnswer = Pick<MessageCreateOptions, "embeds" | "files" | "components"> & { content?: string };

/** Where an answer landed: the channel and the message posted there, or a null channel when it was answered privately. */
export type AnswerPlace = { channelId: string; message: Message } | { channelId: null };

/** A slow answer already acknowledged; send posts it where the acknowledgement said it would. */
export interface PendingChannelAnswer {
	readonly channelId: string | null;
	send(answer: ChannelAnswer): Promise<AnswerPlace>;
}

/** Options for every entry point. `config` saves a read when the caller already holds the row. */
export interface AnswerOptions {
	config?: AnswerChannelConfig | null;
}

/**
 * A confirm then act prompt posted where its audience's answers go. Only the member who
 * asked can press it: anyone else gets a notice and the press does nothing.
 */
export interface ChannelPrompt {
	readonly channelId: string | null;
	/** The asker's press on one of the prompt's buttons, or null when `timeMs` passes first. */
	awaitPress(timeMs: number): Promise<ButtonInteraction | null>;
	/** The asker's pick on the prompt's string select, or null when `timeMs` passes first. */
	awaitSelect(timeMs: number): Promise<StringSelectMenuInteraction | null>;
	/** Rewrite the prompt itself (a timeout, a result), wherever it was posted. Never throws. */
	edit(answer: ChannelAnswer): Promise<void>;
}

// What a prompt waits on: the posted message, or the private reply's response.
type PromptMessage = Pick<Message, "awaitMessageComponent" | "createMessageComponentCollector"> | Pick<InteractionResponse, "awaitMessageComponent" | "createMessageComponentCollector">;

/**
 * Carried (as true) by a stand in interaction that records its answers instead of sending
 * them: the settings panel's reply collector (features/command-buttons/replyCollector.ts),
 * which gathers every handler run into the one answer the panel posts. Such an answer must
 * go to the stand in's own reply, never straight to a channel, or the collector would miss it.
 */
export const RECORDS_ANSWERS = Symbol.for("dero.recordsAnswers");

const AUDIENCE_FIELD: Record<AnswerAudience, keyof AnswerChannelConfig> = {
	member: "commandOutputChannelId",
	deroConfig: "deroConfigChannelId",
	onboarding: "onboardingConfigChannelId",
	arcade: "arcadeControlChannelId",
	admin: "adminCommandsChannelId",
};

/** The stored channel id an audience's answer posts in, or null when setup never stored it. */
export function answerChannelId(config: AnswerChannelConfig | null | undefined, audience: AnswerAudience): string | null {
	const value = config?.[AUDIENCE_FIELD[audience]];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Post a finished answer in its audience's channel, mentioning the member without a ping,
 * or answer privately when the server has no such channel. Works on an interaction in any
 * state: a fresh one, one deferred either way, or one already answered. Never throws.
 */
export async function answerInChannel(interaction: RepliableInteraction, audience: AnswerAudience, answer: ChannelAnswer, options: AnswerOptions = {}): Promise<AnswerPlace> {
	const config = options.config === undefined ? await readConfig(interaction) : options.config;
	const channel = await resolveAnswerChannel(interaction, audience, config);
	const posted = channel ? await postInChannel(interaction, channel, answer) : null;
	if (channel && posted) {
		// A fresh interaction still needs its acknowledgement, and one that only answers
		// in a channel must leave no private message behind.
		if (!interaction.deferred && !interaction.replied) await acknowledgeQuietly(interaction);
		return { channelId: channel.id, message: posted };
	}
	await answerPrivately(interaction, answer);
	return { channelId: null };
}

/**
 * Acknowledge a slow answer before its work runs: a notice naming the channel the answer
 * will post in (a quiet acknowledgement for a modal Submit, which cannot open a modal), or,
 * with no channel, the private defer every slow answer took before. Never throws.
 */
export async function beginChannelAnswer(interaction: RepliableInteraction, audience: AnswerAudience, options: AnswerOptions = {}): Promise<PendingChannelAnswer> {
	const config = options.config === undefined ? await readConfig(interaction) : options.config;
	const channel = await resolveAnswerChannel(interaction, audience, config);
	if (channel) {
		await acknowledgeWithNotice(interaction, channel.id, config);
		return { channelId: channel.id, send: (answer) => answerInChannel(interaction, audience, answer, { config }) };
	}
	// The sanctioned private fallback (see the module header): no channel to name, so the
	// slow answer is deferred privately and send edits that private reply.
	await settle(() => interaction.deferReply({ flags: MessageFlags.Ephemeral }), "the private defer", interaction.id);
	return {
		channelId: null,
		send: async (answer) => {
			await settle(() => interaction.editReply({ ...answer, allowedMentions: { parse: [] } }), "the private answer", interaction.id);
			return { channelId: null };
		},
	};
}

/**
 * A slow answer that stays where it was asked, for a member who asked for it in public (a
 * slash command's own public answer): a plain defer, then the edit of that public reply.
 * Shaped like beginChannelAnswer's handle, so a view chooses between the two in one line.
 */
export async function beginAnswerInPlace(interaction: RepliableInteraction): Promise<PendingChannelAnswer> {
	await interaction.deferReply();
	return {
		channelId: null,
		send: async (answer) => {
			await interaction.editReply({ ...answer, allowedMentions: { parse: [] } });
			return { channelId: null };
		},
	};
}

/**
 * Post a confirm then act prompt (its buttons are no single choice a modal could hold) in
 * its audience's channel, or privately with no such channel, and hand back the means to
 * wait for the asker's press and to rewrite the prompt. Never throws.
 */
export async function askInChannel(interaction: RepliableInteraction, audience: AnswerAudience, prompt: ChannelAnswer, options: AnswerOptions = {}): Promise<ChannelPrompt> {
	const config = options.config === undefined ? await readConfig(interaction) : options.config;
	const channel = await resolveAnswerChannel(interaction, audience, config);
	const posted = channel ? await postInChannel(interaction, channel, prompt) : null;
	if (channel && posted) {
		if (!interaction.deferred && !interaction.replied) await acknowledgeQuietly(interaction);
		return {
			channelId: channel.id,
			awaitPress: (timeMs) => awaitAskerPress(posted, interaction.user.id, timeMs, config),
			awaitSelect: (timeMs) => awaitAskerSelect(posted, interaction.user.id, timeMs, config),
			edit: async (answer) => {
				await settle(() => posted.edit({ ...answer, allowedMentions: { parse: [] } }), "editing the prompt", interaction.id);
			},
		};
	}
	// The sanctioned private fallback (see the module header): the prompt every one of these
	// sites gave before, which only the asker can see and press.
	const response = await settle(() => interaction.reply({ ...prompt, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }), "the private prompt", interaction.id);
	return {
		channelId: null,
		awaitPress: (timeMs) => (response ? awaitAskerPress(response, interaction.user.id, timeMs, config) : Promise.resolve(null)),
		awaitSelect: (timeMs) => (response ? awaitAskerSelect(response, interaction.user.id, timeMs, config) : Promise.resolve(null)),
		edit: async (answer) => {
			await settle(() => interaction.editReply({ ...answer, allowedMentions: { parse: [] } }), "editing the private prompt", interaction.id);
		},
	};
}

// ── helpers ──────────────────────────────────────────────────────────

// Every Discord call here is logged and swallowed rather than thrown: an answer that fails
// to land costs the member a message, never the work the command already did. Awaited in
// a try rather than chained with .catch, so a call that returns no promise cannot throw.
async function settle<T>(call: () => Promise<T> | T, what: string, interactionId: string): Promise<T | null> {
	try {
		return await call();
	} catch (error) {
		console.warn(`[answer-in-channel] ${what} failed`, { interactionId, error });
		return null;
	}
}

// A prompt in a channel can be pressed by anyone who sees it, so every press but the
// asker's is turned away with a notice and never resolves the wait.
function askerOnly(askerId: string, config: AnswerChannelConfig | null | undefined): (press: ButtonInteraction | StringSelectMenuInteraction) => boolean {
	return (press) => {
		if (press.user.id === askerId) return true;
		const words = getPluginCopy(config).answerInChannel;
		void showNotice(press, { title: words.noticeTitle, sections: [words.notYours] });
		return false;
	};
}

async function awaitAskerPress(message: PromptMessage, askerId: string, timeMs: number, config: AnswerChannelConfig | null | undefined): Promise<ButtonInteraction | null> {
	// A timeout rejects, which is the null the callers read as no answer.
	try {
		return await message.awaitMessageComponent({ componentType: ComponentType.Button, time: timeMs, filter: askerOnly(askerId, config) });
	} catch {
		return null;
	}
}

// A streaming collector closed after one pick rather than awaitMessageComponent, which
// dropped select clicks in discord.js 14.25 (the decree editor's timezone pick found it;
// see decreeEditHandlers.runTimezoneThenApply). The end event resolves a timeout as null.
function awaitAskerSelect(message: PromptMessage, askerId: string, timeMs: number, config: AnswerChannelConfig | null | undefined): Promise<StringSelectMenuInteraction | null> {
	return new Promise((resolve) => {
		let picked: StringSelectMenuInteraction | null = null;
		const collector = message.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: timeMs, max: 1, filter: askerOnly(askerId, config) });
		collector.on("collect", (pick: StringSelectMenuInteraction) => {
			picked = pick;
		});
		collector.on("end", () => resolve(picked));
	});
}

async function readConfig(interaction: RepliableInteraction): Promise<AnswerChannelConfig | null> {
	const guildId = interaction.guildId;
	if (!guildId) return null;
	return settle(() => guildConfigStore.findByGuildId(guildId), `reading guild ${guildId}'s config (answering privately)`, interaction.id);
}

// fetch reads the cache first, which matters because a slow answer resolves its channel
// before its acknowledgement and Discord's three second window counts from the press. A
// recording stand in gets no channel, so its answers take the private path it records.
async function resolveAnswerChannel(interaction: RepliableInteraction, audience: AnswerAudience, config: AnswerChannelConfig | null | undefined): Promise<SendableChannels | null> {
	if ((interaction as unknown as Record<symbol, unknown>)[RECORDS_ANSWERS] === true) return null;
	const channelId = answerChannelId(config, audience);
	if (!channelId) return null;
	const channel = await settle(() => interaction.client.channels.fetch(channelId), `fetching channel ${channelId}`, interaction.id);
	return channel?.isSendable() ? channel : null;
}

async function postInChannel(interaction: RepliableInteraction, channel: SendableChannels, answer: ChannelAnswer): Promise<Message | null> {
	const mention = `<@${interaction.user.id}>`;
	const content = answer.content ? `${mention} ${answer.content}` : mention;
	try {
		// parse [] with no users list: the mention names the member and pings nobody.
		return await channel.send({ content, embeds: answer.embeds, files: answer.files, components: answer.components, allowedMentions: { parse: [] } });
	} catch (error) {
		console.warn(`[answer-in-channel] posting in channel ${channel.id} failed; answering privately`, error);
		return null;
	}
}

// The notice is only the acknowledgement: it names where the answer goes, and the answer
// itself posts when the work behind it is done.
async function acknowledgeWithNotice(interaction: RepliableInteraction, channelId: string, config: AnswerChannelConfig | null | undefined): Promise<void> {
	if (interaction.isModalSubmit()) {
		await acknowledgeTextModal(interaction);
		return;
	}
	const words = getPluginCopy(config).answerInChannel;
	await showNotice(interaction, { title: words.noticeTitle, sections: [words.postsIn(channelId)] });
}

// A fresh interaction answered only in a channel: a modal Submit closes as a text modal
// does, a message component is acknowledged as an update that leaves its message as it
// was, and a slash command takes a private defer that is deleted at once (Discord gives a
// command no silent acknowledgement).
async function acknowledgeQuietly(interaction: RepliableInteraction): Promise<void> {
	if (interaction.isModalSubmit()) {
		await acknowledgeTextModal(interaction);
		return;
	}
	if (interaction.isMessageComponent()) {
		await settle(() => interaction.deferUpdate(), "the quiet acknowledgement", interaction.id);
		return;
	}
	// Swallowed (settle), as acknowledgeTextModal does: the answer already posted, and a
	// failed acknowledgement costs at most Discord's own "interaction failed" note.
	await settle(async () => {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		await interaction.deleteReply();
	}, "the quiet acknowledgement", interaction.id);
}

// The sanctioned private fallback (see the module header): a followUp after any
// acknowledgement (a notice, a deferUpdate, a reply), and a reply to a fresh interaction.
async function answerPrivately(interaction: RepliableInteraction, answer: ChannelAnswer): Promise<void> {
	const reply: InteractionReplyOptions = { ...answer, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
	await settle<unknown>(() => (interaction.deferred || interaction.replied ? interaction.followUp(reply) : interaction.reply(reply)), "the private answer", interaction.id);
}
