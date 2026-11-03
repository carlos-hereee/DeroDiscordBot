// ── headquarters ─────────────────────────────────────────────────────
// What:  moves an existing managed channel into a managed category, and says whether
//        Dero may manage channels in a guild at all. Two moves use it: an admin channel
//        into 🏰 DERO HEADQUARTERS (2026-10 item 257 Phase 2a), and a notice board
//        channel left uncategorized by a deleted 🪧 NOTICE BOARD into the rebuilt one
//        (2026-10 item 275). It does NOT build the category or any channel:
//        that is the shared channel spec path in GuildSetupManager (CHANNEL_SPECS,
//        resolveOrCreateManagedCategory, repairOneChannel), so there is one builder.
// Who:   GuildSetupManager.repairMissingChannels, on every boot, for the admin channels
//        that sat under 🪧 NOTICE BOARD before Headquarters existed; and
//        GuildSetupManager.settleReusedCategoryChildren on a forced rebuild.
// How:   setParent with lockPermissions false, then the spec's overwrites re-applied,
//        so the channel keeps its messages, its pins and every entry an owner added
//        by hand (risk R1 in the Phase 2 plan).

import { PermissionFlagsBits, type CategoryChannel, type Guild, type TextChannel, type VoiceChannel } from "discord.js";
import { communityOverwritesFor, type IOverwriteRoles, type ManagedOverwriteKind } from "./communityOverwrites.js";

/**
 * Whether Dero holds Manage Channels in this guild right now. A guild that withheld it
 * keeps its admin channels where they are, and Headquarters is not built there.
 */
export function canManageChannels(guild: Guild): boolean {
	// A guild whose own member is not cached yet (a partial payload) reads as "not
	// known to have it", so nothing is moved on a guess.
	return guild.members?.me?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false;
}

/**
 * Move one live managed channel (text, or a voice room) under a managed category.
 * Resolves true when it moved and false when it was already there (no API call), so a
 * second boot is a no op. Throws what Discord throws; the caller logs it and leaves the
 * channel in place.
 */
export async function moveIntoCategory(
	guild: Guild,
	channel: TextChannel | VoiceChannel,
	category: CategoryChannel,
	kind: ManagedOverwriteKind,
	roles: IOverwriteRoles
): Promise<boolean> {
	if (channel.parentId === category.id) return false;

	// lockPermissions false keeps the channel's own overwrites rather than syncing it
	// to the category's, which would drop the bot's own entry and any role an owner
	// granted by hand. Messages and pins belong to the channel, so a move keeps them.
	await channel.setParent(category.id, { lockPermissions: false });

	// Re-applied from the spec after the move, so a channel whose overwrites drifted
	// while it sat elsewhere lands on the shape a fresh build gives it.
	// Dero's own entries are replaced; every other entry is carried over untouched, the
	// rule reconcileChannelOverwrite follows, or a bare set() would delete an owner's roles.
	const desired = communityOverwritesFor(kind, guild, { ownerId: guild.ownerId }, roles);
	const managedIds = new Set(desired.map((entry) => entry.id));
	const foreign = [...channel.permissionOverwrites.cache.values()].filter((overwrite) => !managedIds.has(overwrite.id));
	await channel.permissionOverwrites.set([...desired, ...foreign]);
	return true;
}
