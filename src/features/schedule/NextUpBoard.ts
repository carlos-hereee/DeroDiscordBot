import {
	Client,
	TextChannel,
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
} from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { eventOverrideStore } from "@db/stores/eventOverrideStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getUpcomingOccurrences } from "@features/events/occurrenceCalculator.js";
import type { IGameEvent } from "@features/events/event.types.js";
import { decreeEditCustomIds } from "./decreeEditHandlers.js";

// ── NextUpBoard ─────────────────────────────────────────────────────
// Posts a fresh embed for each upcoming decree in a guild's configured
// nextDecreeChannelId. Posts are append-only: every decree gets its own
// message, so the channel doubles as an audit trail of what was scheduled
// and (via the Edit button) which decrees got modified.
//
// Triggered by main.ts on bot startup (refreshAllNextUp) and by
// ReminderScheduler after each fire (refreshNextUp). Read by any warrior
// in the alliance who joins the channel. Rolling 24-hour horizon means
// a decree gets posted as soon as it enters the window.
//
// Dedup model: the in-memory postedDecrees Set is a cache. The channel
// itself is the source of truth, the Edit button on every post carries
// a customId encoding (eventId, occurrenceUnix), so on first refresh per
// guild per process we seed the cache from the channel's last 100
// messages. That makes the dedup survive bot restarts without a database
// table or a purge job. v1.5.1 fix; pre-fix every bot restart caused a
// fresh wave of duplicate decree posts because the in-memory Set wiped.

const HORIZON_MS = 24 * 60 * 60 * 1000; // 24 hours

// Module-scoped dedup Set. Key shape: `${guildId}:${eventId}:${occurrenceMs}`.
// Written by tryPostDecree AND by seedDedupFromChannel on first refresh.
const postedDecrees = new Set<string>();

// Tracks which guilds have had their dedup seeded from channel history in
// THIS process. Without this gate, every refreshNextUp call would re-fetch
// the same 100 messages, burning API quota.
const seededGuilds = new Set<string>();

function postedDecreeKey(guildId: string, eventId: string, occurrenceMs: number): string {
	return `${guildId}:${eventId}:${occurrenceMs}`;
}

// Exported for testing, lets tests reset module state between runs.
export function _resetNextUpDedupForTest(): void {
	postedDecrees.clear();
	seededGuilds.clear();
}

// Exported for testing, the number of keys the dedup cache holds.
export const _postedDecreeCountForTest = (): number => postedDecrees.size;

// Drops every key whose occurrence has passed. The refresh loop skips a past occurrence
// before it reads the cache, so such a key can never stop a post again, and without the
// prune the cache grew with every decree for the life of the process (2026-10 item 280).
function prunePastDecrees(now: number): void {
	for (const key of postedDecrees) {
		const occurrenceMs = Number(key.slice(key.lastIndexOf(":") + 1));
		if (occurrenceMs <= now) postedDecrees.delete(key);
	}
}

// ── public entry points ─────────────────────────────────────────────

export async function refreshAllNextUp(client: Client): Promise<void> {
	for (const [guildId] of client.guilds.cache) {
		await refreshNextUp(client, guildId).catch((error) => {
			// Per-guild failures must not stop the sweep. Log loud and move
			// on. The next refresh trigger (event create, reminder fire) will
			// retry naturally.
			console.error("[nextUp] guild refresh failed", { guildId }, error);
		});
	}
}

export async function refreshNextUp(client: Client, guildId: string): Promise<void> {
	const config = await guildConfigStore.findByGuildId(guildId);
	// self-destructed guild: homebase channels are gone, nothing to refresh.
	if (config?.homebaseDestroyed) return;
	if (!config?.nextDecreeChannelId) {
		// Legacy guilds (those that ran /setup before nextDecreeChannelId
		// was added to the schema) load without the channel id. Silent
		// bail, autoSetup will provision the channel on the next run
		// without a re-/setup.
		return;
	}

	const channel = await client.channels.fetch(config.nextDecreeChannelId).catch(() => null);
	if (!channel || !(channel instanceof TextChannel)) {
		console.error("[nextUp] next-decree channel not resolvable", { guildId, channelId: config.nextDecreeChannelId });
		return;
	}

	// Seed dedup from channel history on the first refresh per guild per
	// process. The channel is the source of truth for "what has already
	// been posted"; the in-memory Set is just a cache that needs warming.
	// Seed failures do not abort the refresh, worst case we re-post some
	// decrees, which is the same bug we are fixing but degraded gracefully.
	if (!seededGuilds.has(guildId)) {
		await seedDedupFromChannel(channel, guildId);
		seededGuilds.add(guildId);
	}

	const events = await eventStore.findByGuildId(guildId);
	const now = Date.now();
	const horizonEnd = now + HORIZON_MS;
	prunePastDecrees(now);

	for (const eventLike of events) {
		const event = eventLike as unknown as IGameEvent;
		// Skip paused events. ReminderScheduler already suppresses fires on
		// paused events; the next-decree poster has to mirror that or
		// "paused" reads as "no reminder ping, but here is your decree
		// announcement anyway" which is the worst of both worlds. The auto-
		// resume tick in ReminderScheduler clears event.paused, after which
		// the next refreshNextUp run will start posting again.
		if (event.paused) continue;
		// Compute up to 5 upcoming occurrences and filter to the window.
		// 5 is comfortably above the maximum a 40-hour-cadence event
		// could produce in 24h (which is 1), and even a 4-hour cadence
		// caps at 6, close enough that the constant is fine.
		const upcoming = getUpcomingOccurrences(event, 5);
		for (const occurrence of upcoming) {
			const occurrenceMs = occurrence.getTime();
			if (occurrenceMs <= now || occurrenceMs > horizonEnd) continue;

			const key = postedDecreeKey(guildId, event.eventId, occurrenceMs);
			if (postedDecrees.has(key)) continue;

			// Claim the key BEFORE awaiting the post, so a second refresh racing this one
			// (a reminder fire and an event write landing together) sees it and skips
			// rather than posting the same decree again. A failed post releases the claim
			// so the next refresh retries (2026-10 item 280).
			postedDecrees.add(key);
			try {
				await tryPostDecree(channel, event, occurrence, config.defaultEventImageUrl ?? null);
			} catch (error) {
				postedDecrees.delete(key);
				console.error("[nextUp] post failed", { guildId, eventId: event.eventId, occurrenceMs }, error);
			}
		}
	}
}

// ── private ─────────────────────────────────────────────────────────

// Walks the last 100 messages in the next-decree channel and seeds the
// postedDecrees Set with the (guildId, eventId, occurrenceMs) tuples it
// finds. The Edit button on each decree post carries a customId of shape
// `edit_decree:{eventId}:{occurrenceUnix}`, parsing that gives back the
// exact key the live refresh path writes after a successful post.
//
// 100 messages is enough for any realistic 24-hour horizon (typical KvK
// guild: 7-10 events with 1-2 occurrences each = under 20 posts per day).
// A guild with >100 next-decree posts in its recent history would have
// the oldest tuples fall out of dedup, but those occurrences are well
// outside the 24h horizon by then so they will not be considered for
// re-posting anyway.
async function seedDedupFromChannel(channel: TextChannel, guildId: string): Promise<void> {
	try {
		const messages = await channel.messages.fetch({ limit: 100 });
		for (const message of messages.values()) {
			for (const row of message.components) {
				// message.components is typed as a union of every top-level
				// component kind (ActionRow, FileComponent, Section, etc).
				// Only ActionRow has nested .components, so narrow by type
				// before iterating. The decree Edit button is always rendered
				// inside an ActionRow (see tryPostDecree below) so this is
				// the only kind we care about anyway.
				if (row.type !== ComponentType.ActionRow) continue;
				for (const component of row.components) {
					const customId = (component as { customId?: string }).customId;
					if (!customId) continue;
					const parsed = decreeEditCustomIds.parse(customId);
					if (!parsed) continue;
					// customId stores occurrenceUnix in SECONDS; postedDecrees
					// keys on MILLISECONDS to match Date.getTime(). Multiply.
					const occurrenceMs = parsed.occurrenceUnix * 1000;
					postedDecrees.add(postedDecreeKey(guildId, parsed.eventId, occurrenceMs));
				}
			}
		}
	} catch (error) {
		console.error("[nextUp] dedup seed failed", { guildId }, error);
	}
}

async function tryPostDecree(
	channel: TextChannel,
	event: IGameEvent,
	occurrence: Date,
	defaultImageUrl: string | null
): Promise<void> {
	// Merge overrides on top of the event payload before rendering so
	// the post reflects edits applied through the modal flow. Apply-once
	// overrides are keyed on the original occurrence; this lookup runs
	// per decree and per refresh, so a fresh override applied between
	// refreshes shows up as soon as the next refresh fires.
	const override = await eventOverrideStore.findOne({
		eventId: event.eventId,
		originalOccurrence: occurrence,
	});

	const renderedTitle = override?.overrideTitle ?? event.name;
	const renderedDescription = override?.overrideDescription ?? event.description ?? "";
	const renderedTime = override?.overrideTime ?? occurrence;
	const fireTs = Math.floor(renderedTime.getTime() / 1000);

	const embed = new EmbedBuilder()
		.setTitle(`📅 Upcoming event: ${renderedTitle}`)
		.setDescription(renderedDescription || "_(no description)_")
		.addFields(
			{ name: "Fires", value: `<t:${fireTs}:F> · <t:${fireTs}:R>`, inline: false },
			...(event.prepSteps && event.prepSteps.length > 0
				? [
						{
							name: "Preparation",
							value: [...event.prepSteps]
								.sort((a, b) => a.order - b.order)
								.map((step, i) => `${i + 1}. ${step.label}`)
								.join("\n"),
							inline: false,
						},
				  ]
				: []),
			...(override
				? [
						{
							name: "✏️ Edited",
							value: "_This fire has been edited from its original schedule._",
							inline: false,
						},
				  ]
				: [])
		)
		.setFooter({ text: "Click Edit below to adjust this event (admins only)." });

	// Large banner: this event's image, then the guild default. Guard so null is
	// a clean no-op and a legacy decree with no image posts exactly as before.
	const img = event.imageUrl ?? defaultImageUrl ?? null;
	if (img) embed.setImage(img);

	// occurrence (not renderedTime) is the original anchor, that's the
	// key the modal handler uses when looking up + writing overrides, so
	// the customId must carry the ORIGINAL occurrence even when the
	// override has shifted the actual fire time.
	const occurrenceUnix = Math.floor(occurrence.getTime() / 1000);
	const button = new ButtonBuilder()
		.setCustomId(decreeEditCustomIds.buildEditButton(event.eventId, occurrenceUnix))
		.setLabel("Edit")
		.setStyle(ButtonStyle.Secondary)
		.setEmoji("✏️");

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

	await channel.send({ embeds: [embed], components: [row] });
}
