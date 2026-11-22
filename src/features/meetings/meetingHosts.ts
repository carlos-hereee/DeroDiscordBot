import type { Guild, GuildMember } from "discord.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { isAuthorizedSpeaker } from "@features/dero-brain/authorizer.js";
import { readSpeakerAdminRoleId } from "@features/dero-brain/speakerAdminRole.js";

// ── meetingHosts ────────────────────────────────────────────────────────────
// What:  who may host a meeting (2026-11 item 388, owner decision D11): the members Dero
//        already obeys in voice, through the one rule isAuthorizedSpeaker (owner, admin role,
//        allowlisted roles). Scheduling and cancelling use it now; Phase 3's Start recording
//        uses the same function.
// Who:   features/meetings/scheduledMeetings.ts.

/**
 * True when `member` may host in `guild`. A server that never set up Dero voice has no
 * allowlist, so only its owner and admins may host there, which is what the rule answers
 * for an empty allowlist.
 */
export async function isMeetingHost(member: GuildMember | null, guild: Guild): Promise<boolean> {
	if (!member) return false;
	const voiceConfig = (await deroVoiceConfigStore.findByGuildId(guild.id)) ?? { guildId: guild.id, allowedRoleIds: [] as string[] };
	return isAuthorizedSpeaker({ member, guildOwnerId: guild.ownerId, adminRoleId: await readSpeakerAdminRoleId(guild.id), voiceConfig });
}
