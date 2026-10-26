import { ButtonBuilder, ButtonStyle, Client, Guild, MessageFlags, Role, TextChannel, type ButtonInteraction } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { refreshLeaderboard } from "@features/leaderboard/LeaderboardBoard.js";
import { refreshLevelsBoard } from "@features/leveling/LevelsBoard.js";
import { welcomeNewMember } from "@features/greeter/welcomeNewMember.js";
import { respondWithFortune } from "@features/fortune/respondWithFortune.js";
import { runChipClaim } from "@features/economy/chipClaim.js";
import { levelingCopy } from "@features/leveling/levelingCopy.js";
import { showAccountProfile } from "@features/leveling/accountProfile.js";
import { showLevelsStandings } from "@features/leveling/levelsStandings.js";
import { showAchievements } from "@features/leveling/achievementsView.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";

// ── Channel controls (v1.6 item 36; folded into intro guides 2026-06) ──────
// The bot's common channel actions are one-click buttons in Discord, no slash
// command required. They USED to live on standalone pinned "power-up" panel
// messages; they are now BUTTONS on the pinned intro guides instead:
//   • #command-center guide: "Account", "Levels", "Achievements" and "Toggle
//     pings" (any member)
//   • Summon Dero invite card: "Icebreaker" (any member)
//   • 🕹️games intro's daily row: "Fortune" and "Claim daily rewards" (any member,
//     2026-10 item 254)
//   • admin-controls guide:  "Refresh standings" (owner/admin)
// The admin "Post hangman" button moved to 🎉party-games as Host hangman
// (post-launch plan item 3, features/game-rooms/partyGames); a stale one on an
// old card answers as a retired control.
// resolveIntroComponents (GuildSetupManager) composes these, built by the
// factories below, into the guide rows alongside the suggestion-box, invite,
// and self-destruct buttons.
//
// This module still owns the button BEHAVIOUR:
//  - customId scheme `powerup:<kind>:<action>`, dispatched on the "powerup"
//    prefix through interactionRegistry; handlePowerUpButton splits + gates +
//    routes. The host message does not matter, routing is purely by customId.
//  - the one-time removeAllPowerUpPanels sweep deletes the OLD standalone panels
//    from guilds set up before the fold-in.
// The schedule channel is deliberately NOT here: its controls (Go Live + a
// phase-gated Pause/Resume toggle) live on the schedule board itself, owned by
// ScheduleControls.

const POWERUP_PREFIX = "powerup";

// The folded controls, keyed by `<kind>:<action>` (the customId tail). The
// handler reads this table to (a) reject unknown/retired customIds and (b)
// decide whether to gate the click. "Icebreaker" (member:greet) is member-usable,
// any member can pull their own icebreaker question, so it is NOT adminOnly.
const POWERUP_ACTIONS = {
	"member:subscribe": { adminOnly: false },
	"member:greet": { adminOnly: false },
	// "Fortune" (member:fortune), any member can pull their own fortune reading,
	// so it is NOT adminOnly.
	"member:fortune": { adminOnly: false },
	// "Claim daily rewards" (member:claim), the /claim chip claim as a button on the
	// 🕹️games daily row (2026-10 item 254). Any member; with chips off the press gets
	// runChipClaim's own refusal.
	"member:claim": { adminOnly: false },
	// The three /account views (2026-10 item 245 Phase 4b), each answered privately
	// for the member who pressed it: a guide's buttons never post in its channel.
	"member:account": { adminOnly: false },
	"member:levels": { adminOnly: false },
	"member:achievements": { adminOnly: false },
	"admin:refresh": { adminOnly: true },
} as const satisfies Record<string, { adminOnly: boolean }>;

// ── button factories (folded into the intro guides) ──────────────────────
// Built here so the customIds stay co-located with the handler that routes them.
// Returned as bare ButtonBuilders so resolveIntroComponents can pack several into
// one ActionRow. The customIds MUST match POWERUP_ACTIONS / the switch below.

// #command-center guide row: the announcement-ping toggle ("Toggle pings", the
// bell carries "announcements"). Open to any member. Secondary style so the
// Suggestion Box (Primary) stays the row's visual lead.
export function buildMemberControlButtons(): ButtonBuilder[] {
	return [
		new ButtonBuilder().setCustomId(`${POWERUP_PREFIX}:member:subscribe`).setLabel("Toggle pings").setEmoji("🔔").setStyle(ButtonStyle.Secondary),
	];
}

// #command-center guide's first row: the three /account views, which share their
// handlers with the slash command (features/leveling) and answer privately here.
export function buildProfileButtons(): ButtonBuilder[] {
	const labels = levelingCopy.guideButtons;
	return [
		new ButtonBuilder().setCustomId(`${POWERUP_PREFIX}:member:account`).setLabel(labels.account).setEmoji("🪪").setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`${POWERUP_PREFIX}:member:levels`).setLabel(labels.levels).setEmoji("📈").setStyle(ButtonStyle.Secondary),
		new ButtonBuilder().setCustomId(`${POWERUP_PREFIX}:member:achievements`).setLabel(labels.achievements).setEmoji("🏅").setStyle(ButtonStyle.Secondary),
	];
}

// "Icebreaker", pulls the clicking member a random icebreaker question (posted to
// #introductions). Member-usable (member:greet). Lives on the Summon Dero invite
// card, not the command guide row.
export function buildIcebreakerButton(): ButtonBuilder {
	return new ButtonBuilder().setCustomId(`${POWERUP_PREFIX}:member:greet`).setLabel("Icebreaker").setEmoji("🎲").setStyle(ButtonStyle.Secondary);
}

// "Fortune", pulls the clicking member a quick personal fortune reading, privately.
// Member-usable (member:fortune). Rides the 🕹️games daily row (2026-10 item 254),
// since it is a game that feeds the luck board; its customId never changed, so an
// old Fortune button left on a message still reads.
export function buildFortuneButton(label: string): ButtonBuilder {
	return new ButtonBuilder().setCustomId(`${POWERUP_PREFIX}:member:fortune`).setLabel(label).setEmoji("🔮").setStyle(ButtonStyle.Secondary);
}

// "Claim daily rewards", the member's daily chip claim (member:claim), beside
// Fortune on the 🕹️games daily row. Always shown: a button cannot hide itself when a
// server switches chips off, and the press then says so.
export function buildClaimButton(label: string): ButtonBuilder {
	return new ButtonBuilder().setCustomId(`${POWERUP_PREFIX}:member:claim`).setLabel(label).setEmoji("🪙").setStyle(ButtonStyle.Success);
}

// admin-controls guide row: refresh the leaderboard standings. Owner/admin gated
// in handlePowerUpButton via POWERUP_ACTIONS.
export function buildAdminControlButtons(): ButtonBuilder[] {
	return [
		// Changing this row re-edits every existing guild's pinned admin card on its
		// next boot, via the componentsAreEquivalent check in refreshIntroEmbeds, so
		// it ships with no re-run of /setup.
		new ButtonBuilder().setCustomId(`${POWERUP_PREFIX}:admin:refresh`).setLabel("Refresh standings").setEmoji("🔄").setStyle(ButtonStyle.Primary),
	];
}

// ── button handling ────────────────────────────────────────────────────

async function handlePowerUpButton(interaction: ButtonInteraction): Promise<void> {
	// customId: powerup:<kind>:<action> → key on the `<kind>:<action>` tail.
	const parts = interaction.customId.split(":");
	const key = `${parts[1]}:${parts[2]}`;
	const actionDef = POWERUP_ACTIONS[key as keyof typeof POWERUP_ACTIONS] as { adminOnly: boolean } | undefined;

	// Unknown / retired control (a stale button from an older layout). Ack quietly.
	if (!actionDef) {
		await interaction.reply({ content: "This control is no longer available.", flags: MessageFlags.Ephemeral });
		return;
	}

	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) {
		await interaction.reply({ embeds: [errorEmbed("This button only works inside a server.")], flags: MessageFlags.Ephemeral });
		return;
	}

	// Per-action gate. Persistent buttons cannot rely on a slash command's
	// permission filter, so admin-only actions re-verify the clicker here.
	if (actionDef.adminOnly) {
		const config = await guildConfigStore.findByGuildId(guildId);
		const allowed = await gateOwnerOrAdmin(interaction, config);
		if (!allowed) {
			await interaction.reply({ embeds: [errorEmbed(rokCommanderCopy.responses.noWizardPowers)], flags: MessageFlags.Ephemeral });
			return;
		}
	}

	switch (key) {
		case "admin:refresh":
			await runLeaderboardRefresh(interaction, guildId);
			return;
		case "member:greet":
			await runFireGreeting(interaction);
			return;
		case "member:fortune":
			await runFortune(interaction);
			return;
		case "member:claim":
			await runChipClaim(interaction);
			return;
		case "member:subscribe":
			await runToggleNotificationRole(interaction, guildId);
			return;
		case "member:account":
			await showAccountProfile(interaction, { target: interaction.user, isPrivate: true });
			return;
		case "member:levels":
			// The all time standings, the slash command's own default window.
			await showLevelsStandings(interaction, { window: "alltime", isPrivate: true });
			return;
		case "member:achievements":
			await showAchievements(interaction, { target: interaction.user, isPrivate: true });
			return;
		default:
			// In POWERUP_ACTIONS but not wired here, should not happen for shipped
			// actions, but keeps the switch exhaustive and loud.
			await interaction.reply({ content: "This control is not wired up yet.", flags: MessageFlags.Ephemeral });
	}
}

// Refresh standings rebuilds EVERY board of the leaderboard channel (2026-10 item
// 254): the participation board and the levels board share that channel, and an
// admin who deleted both expects one press to bring both back. Each refresher
// reposts a deleted message on its own and reports what it did, so the reply names
// each board rather than claiming success for a refresh that posted nothing.
async function runLeaderboardRefresh(interaction: ButtonInteraction, guildId: string): Promise<void> {
	// Defer: both refreshes do Discord I/O (channel fetch, message edit or post, a
	// card render) which can exceed the 3s interaction-ack window on a cold cache.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const copy = setupCopy.refreshStandings;
	// The two boards write different anchors (leaderboardMessageId, levelsMessageId),
	// so they can run side by side.
	const [participation, levels] = await Promise.all([refreshLeaderboard(interaction.client, guildId), refreshLevelsBoard(interaction.client, guildId)]);
	const outcomes = [
		{ board: copy.boards.participation, result: participation },
		{ board: copy.boards.levels, result: levels },
	];
	const lines = outcomes.map(({ board, result }) =>
		result.posted ? copy.refreshed(board) : copy.failed(board, copy.problems[result.problem ?? "unexpected-error"])
	);
	const failed = outcomes.filter(({ result }) => !result.posted).map(({ board }) => board);
	adminLog.emitFor(interaction, guildId, "powerup.toggle", {
		subject: setupCopy.adminLog.subjects.refreshStandings,
		detail: failed.length === 0 ? copy.auditAllRefreshed : copy.auditSomeFailed(failed),
	});
	await interaction.editReply({ content: lines.join("\n") });
}

async function runFireGreeting(interaction: ButtonInteraction): Promise<void> {
	// Fire the real new-member greeting flow for the clicking member: the same
	// path a join takes (a pack-voiced welcome framing + a random icebreaker,
	// posted to the introductions channel pinging them). Member-usable, anyone
	// can drop a fresh icebreaker or re-introduce themselves on demand. Reuses
	// welcomeNewMember so the on-demand fire and the on-join fire never drift.
	// Silent ack: the posted greeting IS the visible feedback, so there is no
	// ephemeral success reply (it was just clutter). deferUpdate acknowledges the
	// click without a "thinking" state and buys time for welcomeNewMember's
	// channel I/O; we only speak up (ephemeral followUp) when nothing got posted
	// so a dud click is not left silent.
	await interaction.deferUpdate();
	let member = interaction.guild?.members.cache.get(interaction.user.id) ?? null;
	if (!member) member = (await interaction.guild?.members.fetch(interaction.user.id).catch(() => null)) ?? null;
	const sent = member ? await welcomeNewMember(member) : false;
	if (!sent) {
		await interaction.followUp({
			content: "Could not post a greeting. Check that the introductions channel exists and the bot can post there.",
			flags: MessageFlags.Ephemeral,
		});
	}
}

async function runFortune(interaction: ButtonInteraction): Promise<void> {
	// A quick personal reading, always ephemeral so it never clutters the channel
	// the button sits in. A button cannot take text input without a
	// modal, so the button gives a no-question reading; /mini-game fortune is the
	// path for a custom question. All reading logic (kill-switch, cooldown, roll, embed) is
	// shared with the slash command via respondWithFortune, and the cooldown Map
	// is shared too, so alternating button and command cannot bypass the gate.
	await respondWithFortune(interaction, { isPrivate: true });
}

const NOTIFICATIONS_ROLE_NAME = "🔔 Announcements";

// Dedupe concurrent first-use creates: without this, two members tapping the
// brand-new guild's Toggle pings in the same tick would each create a duplicate
// Announcements role, since the read-then-create below is not atomic. Cache the
// in-flight resolve per guild so a second caller awaits the first. Mirrors
// GuildSetupManager.inflightAutoSetups; single-process only.
const inflightNotificationsRoleResolves = new Map<string, Promise<Role>>();

// Resolve the guild's dedicated announcement-ping role, creating it on first use
// and recreating it if an admin deleted the stored one. The id is persisted on
// config.notificationsRoleId. Kept separate from memberRoleId on purpose: that is
// the verified-member role + the default reminder audience, so toggling it here
// would strip a member's standing instead of just their pings.
async function resolveOrCreateNotificationsRole(guild: Guild, guildId: string, storedRoleId: string | null): Promise<Role> {
	const inflight = inflightNotificationsRoleResolves.get(guildId);
	if (inflight) return inflight;

	const work = (async (): Promise<Role> => {
		// Reuse the stored role when it still exists; an admin deleting it falls
		// through to a fresh create so the button always works.
		if (storedRoleId) {
			const existing = guild.roles.cache.get(storedRoleId) ?? (await guild.roles.fetch(storedRoleId).catch(() => null));
			if (existing) return existing;
		}
		const created = await guild.roles.create({
			name: NOTIFICATIONS_ROLE_NAME,
			mentionable: true,
			reason: "Announcement ping opt-in role, self-assigned via the Toggle pings power-up",
		});
		await guildConfigStore.update(guildId, { notificationsRoleId: created.id });
		return created;
	})();

	inflightNotificationsRoleResolves.set(guildId, work);
	try {
		return await work;
	} finally {
		inflightNotificationsRoleResolves.delete(guildId);
	}
}

async function runToggleNotificationRole(interaction: ButtonInteraction, guildId: string): Promise<void> {
	if (!interaction.guild) {
		await interaction.reply({ embeds: [errorEmbed("This only works inside a server.")], flags: MessageFlags.Ephemeral });
		return;
	}
	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config) {
		await interaction.reply({ embeds: [errorEmbed("This server is not set up yet.")], flags: MessageFlags.Ephemeral });
		return;
	}

	// Resolve (or lazily create) the DEDICATED announcement-ping role. This is
	// deliberately NOT config.memberRoleId: that is the verified-member role from
	// /setup and the default reminder audience, so toggling it here would strip a
	// member's standing instead of just their pings. The opt-in role is its own
	// mentionable role, created on first use, recreated if an admin deletes it,
	// and its id is persisted on config.notificationsRoleId.
	let role: Role;
	try {
		role = await resolveOrCreateNotificationsRole(interaction.guild, guildId, config.notificationsRoleId ?? null);
	} catch (err) {
		console.error(`[powerup] could not resolve or create notifications role in guild ${guildId}`, err);
		await interaction.reply({
			embeds: [errorEmbed("Could not set up the announcements role. The bot may be missing Manage Roles, or its own role is too low to create one.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {

		// Resolve the clicking member cache-first, fetch fallback (the cache can be
		// cold on a fresh restart).
		let member = interaction.guild.members.cache.get(interaction.user.id) ?? null;
		if (!member) member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
		if (!member) {
			await interaction.reply({ embeds: [errorEmbed("Could not resolve your membership. Try again in a moment.")], flags: MessageFlags.Ephemeral });
			return;
		}

		// Toggle: state is conveyed through this ephemeral reply, not the button
		// label (a shared button label cannot be per-user).
		if (member.roles.cache.has(role.id)) {
			await member.roles.remove(role.id, "Announcement ping opt-out");
			await interaction.reply({ content: "🔕 You're off the announcement ping list.", flags: MessageFlags.Ephemeral });
		} else {
			await member.roles.add(role.id, "Announcement ping opt-in");
			await interaction.reply({ content: "🔔 You're on the announcement ping list. Tap again to opt out.", flags: MessageFlags.Ephemeral });
		}
	} catch (err) {
		console.error(`[powerup] toggle notifications role failed in guild ${guildId}`, err);
		await interaction.reply({
			embeds: [
				errorEmbed(
					"Could not update your notifications. The bot may be missing Manage Roles, or the announcements role sits above the bot's own role. Try again in a moment."
				),
			],
			flags: MessageFlags.Ephemeral,
		});
	}
}

/**
 * Register the power-up button handler. Called once at boot from main.ts
 * alongside the other registerXHandlers, BEFORE the InteractionCreate listener.
 * Still required even though the buttons now live on the intro guides, every
 * `powerup:*` click routes through here.
 */
export function registerPowerUpHandlers(): void {
	registerButton(POWERUP_PREFIX, handlePowerUpButton);
}

// ── one-time migration: delete the old standalone control panels ──────────
// The controls used to live on separate pinned "power-up" panel messages; they
// are now buttons on the pinned intro guides. On boot we delete any leftover
// panel (whose id is tracked in GuildConfig.powerUpMessageIds) and clear the
// field. Idempotent: once every tracked id is null this is a no-op (one
// findByGuildId, no write). Safe to retire this sweep once every live guild has
// booted past it.
const PANEL_KEYS = [
	"commandsChannelId",
	"adminCommandsChannelId",
	"adminChannelId",
	"leaderboardChannelId",
	"introChannelId",
	"announcementsChannelId",
] as const;

/**
 * Delete every tracked control panel for one guild and clear powerUpMessageIds.
 * Best-effort per panel: a failed delete is logged and the rest proceed.
 */
async function removeGuildPowerUpPanels(client: Client, guild: Guild): Promise<void> {
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!config) return;

	const channelIds = config as unknown as Record<string, string | null | undefined>;
	const stored = (config.powerUpMessageIds ?? {}) as unknown as Record<string, string | null | undefined>;

	let changed = false;
	const cleared: Record<string, null> = {};
	for (const key of PANEL_KEYS) {
		cleared[key] = null;
		const panelId = stored[key];
		if (!panelId) continue;
		changed = true; // a tracked panel existed → delete it + clear the id

		const channelId = channelIds[key] ?? null;
		const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
		if (channel instanceof TextChannel) {
			const stale = await channel.messages.fetch(panelId).catch(() => null);
			if (stale) {
				try {
					await stale.delete();
				} catch (error) {
					console.warn(`[powerup] failed to delete legacy ${key} panel in guild ${guild.id}`, error);
				}
			}
		}
	}

	if (changed) await guildConfigStore.update(guild.id, { powerUpMessageIds: cleared });
}

/**
 * Boot-sweep entry point: delete the old standalone control panels for every
 * guild (the buttons now live on the intro guides). Per-guild failures are
 * logged and swallowed so one guild cannot stall the rest. Called from main.ts
 * where ensureAllPowerUps used to run.
 */
export async function removeAllPowerUpPanels(client: Client): Promise<void> {
	for (const guild of client.guilds.cache.values()) {
		await removeGuildPowerUpPanels(client, guild).catch((error) => console.error(`[powerup] panel cleanup failed for guild ${guild.id}`, error));
	}
}
