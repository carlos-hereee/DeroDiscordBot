import {
	Client,
	TextChannel,
	ButtonInteraction,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { pollResultStore } from "@db/stores/pollResultStore.js";
import { pollSentEvent } from "@base/constants/BOT_LOG_EVENTS.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { ACTIVE_POLLS, IPollDefinition } from "./pollDefinitions.js";

// ── PollDispatcher ────────────────────────────────────────────────────
// Reusable audience-poll mechanism (v1.6 Phase 3, item 34a). Broadcasts each
// active poll to every eligible guild's announcements channel as a buttoned
// embed, records per-user votes to PollResult, and logs a cross-guild tally on
// boot for the platform owner. Built to be reused: ship the next question by
// adding a definition to ACTIVE_POLLS.
//
// Mirrors postFeatureAnnouncement: boot-triggered sweep, sequential per guild
// so one Discord hiccup cannot stall the rest, idempotent via a botLog key
// (poll_sent:<pollId>) so a redeploy never reposts. Votes are collected with
// buttons routed through interactionRegistry rather than Discord's native poll
// widget, because per-user vote capture (for PollResult dedup) maps cleanly
// onto button interactions and needs no extra gateway intent.

// customId scheme: `poll:<pollId>:<optionKey>`. The interactionRegistry routes
// on the "poll" prefix; this handler splits the rest.
const POLL_BUTTON_PREFIX = "poll";

// Neutral platform framing, see pollDefinitions for why poll copy is not pack
// voice. Kept here as module consts so the reusable framing stays in one place.
const POLL_EMBED_TITLE = "📊 Quick question";
const POLL_INSTRUCTION =
	"_Tap a button to vote. You can change your vote anytime, and only the tally is shared, never who voted._";

// ── vote handling ──────────────────────────────────────────────────────

async function handlePollVote(interaction: ButtonInteraction): Promise<void> {
	// customId: poll:<pollId>:<optionKey>
	const parts = interaction.customId.split(":");
	const pollId = parts[1];
	const optionKey = parts[2];
	const poll = pollId ? ACTIVE_POLLS.find((p) => p.pollId === pollId) : undefined;
	const option = poll?.options.find((o) => o.key === optionKey);

	// Unknown / retired poll, or an option that no longer exists (a stale
	// message left over from an older deploy). Acknowledge quietly so the click
	// does not surface a generic interaction error.
	if (!poll || !option) {
		await interaction.reply({ content: "This poll is no longer active.", flags: MessageFlags.Ephemeral });
		return;
	}

	// Polls only post to guild channels, but a button can technically be clicked
	// from a forwarded/DM context, guard so we never write a null guildId row.
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({ content: "Please vote from within the server.", flags: MessageFlags.Ephemeral });
		return;
	}

	try {
		await pollResultStore.recordVote(poll.pollId, guildId, interaction.user.id, option.key);
		await interaction.reply({
			content: `Thanks, your vote for "${option.label}" is recorded. Tap another option anytime to change it.`,
			flags: MessageFlags.Ephemeral,
		});
	} catch (error) {
		console.error(`[poll] failed to record vote for ${poll.pollId} in guild ${guildId}`, error);
		await interaction.reply({ content: "Could not record your vote. Try again in a moment.", flags: MessageFlags.Ephemeral });
	}
}

/**
 * Register the poll vote button handler. Called once at boot from main.ts
 * alongside the other registerXHandlers, BEFORE the InteractionCreate listener.
 */
export function registerPollHandlers(): void {
	registerButton(POLL_BUTTON_PREFIX, handlePollVote);
}

// ── message building ────────────────────────────────────────────────────

function buildPollEmbed(poll: IPollDefinition): EmbedBuilder {
	return infoEmbed(POLL_EMBED_TITLE, `${poll.question}\n\n${POLL_INSTRUCTION}`, COLORS.ANNOUNCEMENTS);
}

function buildPollComponents(poll: IPollDefinition): ActionRowBuilder<ButtonBuilder>[] {
	const rows: ActionRowBuilder<ButtonBuilder>[] = [];
	// Discord caps an action row at 5 buttons and a message at 5 rows. Chunk
	// options into rows of 5 so a poll with more than 5 options still renders.
	for (let i = 0; i < poll.options.length; i += 5) {
		const slice = poll.options.slice(i, i + 5);
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			slice.map((option) =>
				new ButtonBuilder()
					.setCustomId(`${POLL_BUTTON_PREFIX}:${poll.pollId}:${option.key}`)
					.setLabel(option.label)
					.setStyle(ButtonStyle.Secondary)
			)
		);
		rows.push(row);
	}
	return rows;
}

// ── dispatch ────────────────────────────────────────────────────────────

/**
 * Broadcast every active poll to all eligible guilds. Called once at the tail
 * of main.ts's ClientReady boot loop. Most boots are no-ops (every guild has
 * already been logged for every active poll); only the first boot after a new
 * poll ships actually posts.
 */
export async function dispatchPolls(client: Client): Promise<void> {
	for (const poll of ACTIVE_POLLS) {
		await dispatchOnePoll(client, poll);
	}
}

async function dispatchOnePoll(client: Client, poll: IPollDefinition): Promise<void> {
	const eventKey = pollSentEvent(poll.pollId);
	let posted = 0;
	let skipped = 0;

	for (const guild of client.guilds.cache.values()) {
		try {
			const config = await guildConfigStore.findByGuildId(guild.id);

			// Skip new / unconfigured guilds: with no finished /setup there is no
			// announcements channel to post to and no shared history to probe.
			if (!config?.setupComplete) {
				skipped += 1;
				continue;
			}

			// Idempotency: has this guild already received this poll? Checked
			// before the Discord fetch so the common no-op boot stays cheap.
			const already = await botLogStore.has(guild.id, eventKey);
			if (already) {
				skipped += 1;
				continue;
			}

			const announcementsChannelId = config.announcementsChannelId;
			if (!announcementsChannelId) {
				// Not a failure, defer without logging so the next boot (once
				// ensureHomebase has rebuilt) re-attempts.
				console.warn(`[poll] guild ${guild.id} missing announcements channel; deferring ${poll.pollId}`);
				continue;
			}

			const channel = await client.channels.fetch(announcementsChannelId).catch(() => null);
			if (!(channel instanceof TextChannel)) {
				console.warn(`[poll] guild ${guild.id} announcements channel missing or wrong type; deferring ${poll.pollId}`);
				continue;
			}

			// Quiet post (no role ping), matching the feature-announcement
			// convention. allowedMentions guards against accidental mass pings.
			await channel.send({
				embeds: [buildPollEmbed(poll)],
				components: buildPollComponents(poll),
				allowedMentions: { parse: [] },
			});

			// Log only AFTER a successful post so a failure re-attempts next boot.
			await botLogStore.log(guild.id, eventKey, { pollId: poll.pollId });
			posted += 1;
		} catch (error) {
			console.error(`[poll] failed to dispatch ${poll.pollId} to guild ${guild.id}`, error);
		}
	}

	if (posted > 0 || skipped > 0) {
		console.log(`[poll] ${poll.pollId}, posted to ${posted} guild(s), skipped ${skipped}`);
	}
}

/**
 * Log a cross-guild tally for every active poll. Called once on boot so the
 * platform owner can read accumulating results from Railway logs. Vote data
 * also lives in PollResult for deeper ad-hoc queries.
 */
export async function logPollTallies(): Promise<void> {
	for (const poll of ACTIVE_POLLS) {
		try {
			const counts = await pollResultStore.tally(poll.pollId);
			const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
			const breakdown = poll.options.map((o) => `${o.key}=${counts[o.key] ?? 0}`).join(" ");
			console.log(`[poll] results ${poll.pollId}: total=${total} ${breakdown}`);
		} catch (error) {
			console.error(`[poll] failed to read tally for ${poll.pollId}`, error);
		}
	}
}
