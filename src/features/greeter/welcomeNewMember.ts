import { Client, Events, GuildMember, PermissionFlagsBits, TextChannel } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { ICEBREAKERS } from "./icebreakers.js";
import { attachListenRow } from "@features/voice/listenButton.js";
import { avatarRequestFor, isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import type { IPluginCopy } from "@base/copy/types.js";
import { renderWelcomeCard, WELCOME_AVATAR_SIZE, type WelcomeCardView } from "./welcomeCardRenderer.js";

// ── new-member greeter (v1.6) ──────────────────────────────────────────────
// What:  on guildMemberAdd, post a welcome in the guild's introductions channel
//        that pings the new member and asks a random icebreaker. The intro
//        channel is member-writable (GuildSetupManager.createChannels uses
//        introOverwrites for new guilds; ensureIntroChannelsWritable below
//        brings existing guilds into line) so the newcomer can answer in place,
//        which also satisfies a Discord Onboarding gate that requires posting
//        in a channel before full access.
// Who:   registered once from main.ts (registerGreeter) on the ClientReady boot.
// When:  every non-bot join in a setup-complete guild that has an intro channel.
// How:   compose a random pack-voiced framing (kingdom vs neutral) with a random
//        icebreaker from the shared bank, then post as message CONTENT (not an
//        embed) so the mention actually notifies, Discord does not fire a
//        notification for a mention inside an embed description. allowedMentions
//        is scoped to the one joining member so nothing else can be pinged.
//        The welcome card (2026-10 item 243 Phase 4) rides the same message as
//        a file under the text; when it does not draw, the text posts alone.

// Uniform random pick. Math.random is fine in bot runtime (the no-random rule
// only applies to resumable Workflow scripts, not the bot itself).
function pick<T>(arr: readonly T[]): T | undefined {
	if (arr.length === 0) return undefined;
	return arr[Math.floor(Math.random() * arr.length)];
}

// Returns true only when a greeting was actually posted. The on-join caller
// ignores the result (fire-and-forget); the on-demand "Fire a greeting" button
// uses it to give the admin an honest success/failure ack instead of a blind
// confirmation.
export async function welcomeNewMember(member: GuildMember): Promise<boolean> {
	// Never greet bots, they don't read it and it would clutter the channel.
	if (member.user.bot) return false;

	try {
		const config = await guildConfigStore.findByGuildId(member.guild.id);
		// Only greet fully set-up guilds that have a provisioned intro channel.
		if (!config?.setupComplete || !config.introChannelId) return false;

		const channel = await member.client.channels.fetch(config.introChannelId).catch(() => null);
		if (!(channel instanceof TextChannel)) return false;

		const copy = getPluginCopy(config);
		const framing = pick(copy.greeter.framings);
		const question = pick(ICEBREAKERS);
		if (!framing || !question) return false;

		// Drawn BEFORE the send, so the card arrives with the ping rather than as
		// a second notification. Both callers can wait: the join path is fire and
		// forget and the admin button deferred its reply first.
		const card = await withRenderFallback(
			() => renderWelcomeCard(welcomeCardView(member, copy.greeter.card)),
			() => null
		);
		const message = await channel.send({
			content: framing(`<@${member.id}>`, question),
			allowedMentions: { users: [member.id] },
			...(isRenderPayload(card) ? { files: [card.attachment] } : {}),
		});
		// Dero's voice can read the welcome aloud. Added by an edit AFTER the send,
		// fire and forget, so the voice config read can never delay or block the
		// greeting; the edit touches components only, so the mention does not ping
		// a second time.
		void attachListenRow(member.guild.id, (components) => message.edit({ components }));
		return true;
	} catch (error) {
		// Fire-and-forget on the join path: a greeting failure must never throw
		// back into the gateway event handler and stall other listeners.
		console.error(`[greeter] failed to welcome ${member.id} in guild ${member.guild?.id}`, error);
		return false;
	}
}

// The welcome card's view of one newcomer, in the guild pack's voice. The member
// count is the guild's own, which already includes the newcomer.
export function welcomeCardView(member: GuildMember, copy: IPluginCopy["greeter"]["card"]): WelcomeCardView {
	const count = member.guild.memberCount;
	return {
		kicker: copy.kicker,
		title: copy.title(member.displayName),
		subtitle: copy.subtitle(member.guild.name),
		memberCount: Number.isFinite(count) && count > 0 ? copy.memberCount(count) : null,
		displayName: member.displayName,
		avatar: avatarRequestFor(member.user, WELCOME_AVATAR_SIZE),
	};
}

// ── boot: make existing guilds' introductions channels member-writable ──────
// What:  new guilds get a writable intro channel from createChannels'
//        introOverwrites. This idempotent sweep brings guilds that were set up
//        BEFORE the greeter shipped into line so newcomers can post their answer.
// Who:   called once from main.ts's ClientReady boot, after the homebase sweep.
// How:   for each guild, if @everyone is not already allowed to send in the
//        intro channel, grant ViewChannel + SendMessages on that one channel.
//        The pre-check keeps it a no-op (no API write) once already writable.
export async function ensureIntroChannelsWritable(client: Client): Promise<void> {
	for (const guild of client.guilds.cache.values()) {
		try {
			const config = await guildConfigStore.findByGuildId(guild.id);
			if (!config?.introChannelId) continue;

			const channel = await client.channels.fetch(config.introChannelId).catch(() => null);
			if (!(channel instanceof TextChannel)) continue;

			const everyoneId = guild.roles.everyone.id;
			const overwrite = channel.permissionOverwrites.cache.get(everyoneId);
			if (overwrite?.allow.has(PermissionFlagsBits.SendMessages)) continue;

			await channel.permissionOverwrites.edit(everyoneId, {
				ViewChannel: true,
				SendMessages: true,
			});
		} catch (error) {
			console.warn(`[greeter] failed to ensure intro channel writable in guild ${guild.id}`, error);
		}
	}
}

// ── join-flood throttle ─────────────────────────────────────────────────────
// Per-guild rolling-window cap so a raid / invite-blast / mass-join cannot turn
// the greeter into a self-inflicted flood: at most GREET_BURST greetings per
// GREET_WINDOW_MS per guild; joins past that are skipped (logged). Only the
// on-join path is throttled, the admin "Fire a greeting" button calls
// welcomeNewMember directly and is never rate-limited. In-memory like the bot's
// other cooldowns (announce / test-fire routes); resets on restart, which is fine.
const GREET_WINDOW_MS = 60_000;
const GREET_BURST = 8;
const recentGreets = new Map<string, number[]>();

function greetAllowed(guildId: string): boolean {
	const now = Date.now();
	const times = (recentGreets.get(guildId) ?? []).filter((t) => now - t < GREET_WINDOW_MS);
	if (times.length >= GREET_BURST) {
		recentGreets.set(guildId, times); // keep the trimmed window so it decays
		return false;
	}
	times.push(now);
	recentGreets.set(guildId, times);
	return true;
}

// Register the guildMemberAdd listener. Called once at boot from main.ts,
// alongside the other registerX handlers.
export function registerGreeter(client: Client): void {
	client.on(Events.GuildMemberAdd, (member) => {
		if (member.user.bot) return;
		if (!greetAllowed(member.guild.id)) {
			console.warn(`[greeter] join-flood throttle hit in guild ${member.guild.id}; skipping greeting`);
			return;
		}
		void welcomeNewMember(member);
	});
}
