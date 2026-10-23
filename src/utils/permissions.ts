import type { ButtonInteraction, GuildMember, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── permissions ─────────────────────────────────────────────────────
// Centralized authorization helpers. Today only the decree-edit flow
// reads from here; future features (transfer-bot-ownership, dangerous
// admin actions) should add their helpers alongside canEditDecree so
// every authorization decision lives in one file.
//
// Why a helper instead of inlining the check at the call site: persistent
// button interactions (the Edit button on NextUpBoard posts) cannot rely
// on Discord's built-in setDefaultMemberPermissions slash-command gate,
// that only filters the command picker. The component handler must
// re-verify the actor on every interaction, and that re-verification
// must match the gate the slash command would have applied.

interface IGuildConfigPermissionShape {
	adminRoleId?: string | null;
}

/**
 * canEditDecree
 *
 * What:  decides whether a Discord member is allowed to mutate an event
 *        through the decree-edit UI (apply once or apply permanent).
 *        Mirrors the slash-command admin gate in main.ts so a member who
 *        could run /events delete can also click Edit on a NextUpBoard post.
 * Who:   read by the persistent button + modal handlers in the decree-edit
 *        flow. Returns true on the happy path; the caller replies with an
 *        ephemeral denial when false.
 * When:  evaluated on every button click and every modal submit. The
 *        permission check is NOT cached, a role removal on Discord
 *        propagates to the next interaction immediately.
 * How:   server owner always passes. Admin-role match falls back to
 *        guild-level role cache, which discord.js refreshes on
 *        GUILD_MEMBER_UPDATE. If the guild has no adminRoleId set
 *        (legacy config), only the server owner is authorized.
 */
export function canEditDecree(member: GuildMember, config: IGuildConfigPermissionShape): boolean {
	return isOwnerOrAdmin(member, config);
}

/**
 * isOwnerOrAdmin
 *
 * The generic owner-or-admin gate: the server owner always passes; otherwise
 * the member must hold the configured admin role. A legacy config with no
 * adminRoleId restricts the action to the owner alone. This is the same rule
 * the slash-command admin gate applies in main.ts; canEditDecree above is a
 * named alias so the decree-edit call sites read intentionally.
 */
export function isOwnerOrAdmin(member: GuildMember, config: IGuildConfigPermissionShape): boolean {
	if (member.id === member.guild.ownerId) return true;
	if (config.adminRoleId && member.roles.cache.has(config.adminRoleId)) return true;
	return false;
}

/**
 * gateOwnerOrAdmin
 *
 * Button-interaction wrapper around the owner-or-admin gate. Persistent button
 * handlers cannot lean on a slash command's setDefaultMemberPermissions, so
 * they must re-verify the clicker. ButtonInteraction.member can be a partial
 * API member with no populated roles cache, and the guild cache can be cold
 * after a restart, so we resolve cache-first then fetch, a miss would wrongly
 * deny a real admin. Returns false (deny) when there is no guild context or the
 * member cannot be resolved.
 *
 * Accepts a string select and a modal submit too (the game request ballot, 2026-10
 * item 245 Phase 4a): their customIds and values are user input exactly like a
 * button press, and the gate reads only the guild and the clicker, which all carry.
 *
 * Note: ScheduleControls and the main.ts command gate still inline this same
 * resolution; they could adopt this helper on a future cleanup pass.
 */
export async function gateOwnerOrAdmin(
	interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
	config: IGuildConfigPermissionShape | null | undefined
): Promise<boolean> {
	if (!interaction.guild) return false;
	if (interaction.user.id === interaction.guild.ownerId) return true;
	const adminRoleId = config?.adminRoleId ?? null;
	if (!adminRoleId) return false; // no admin role configured → owner-only
	let member = interaction.guild.members.cache.get(interaction.user.id) ?? null;
	if (!member) member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
	return member ? member.roles.cache.has(adminRoleId) : false;
}

/**
 * isAdminCommand
 *
 * Whether a slash command, or one subcommand of it, sits behind the owner or admin
 * gate. BOT_CONSTANTS.ADMIN_COMMANDS lists a bare command name to gate all of it, or
 * "command subcommand" to gate that one subcommand alone (/events delete, while
 * /events list stays a member view). main.ts's slash command gate and the admin
 * command launcher both ask this, so a button can never open what the command
 * would refuse.
 */
export function isAdminCommand(commandName: string, subcommand: string | null): boolean {
	if (BOT_CONSTANTS.ADMIN_COMMANDS.has(commandName)) return true;
	return subcommand !== null && BOT_CONSTANTS.ADMIN_COMMANDS.has(`${commandName} ${subcommand}`);
}
