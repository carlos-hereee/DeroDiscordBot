import type { Guild } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── invitePicker ──────────────────────────────────────────────────────
// What:  the two halves of an invite list a host picks from: the options the
//        BOT builds for a StringSelect, and the server side re-filter of what the
//        client sends back.
// Who:   the challenge board's invite picker and Dero's hold em rules card. One
//        helper so the two cannot disagree about who may be invited.
// When:  once when a picker is drawn, once per submission.
// Where: reads the guild member cache, with one fetch when the cache is cold.
// How:   ⚠️ A StringSelect THE BOT POPULATES, and that is the whole point. A
//        UserSelect is filled in by Discord from the guild's member list and will
//        happily return a bot, which would put "Dero" on an invite list through a
//        component. Here the bot builds every option itself and filters
//        `member.user.bot`, and the submission is re-checked against the guild,
//        because a customId and its values are user input however the menu was
//        built.

export interface InviteOption {
	label: string;
	value: string;
	description: string;
}

/**
 * Every member the host could invite, bots and the host left out, at most one select's
 * worth. `excludedIds` are members this room's host removed (2026-10 item 244 Phase 4),
 * left out so a removed member can never be invited back by the picker.
 */
export async function buildInviteOptions(guild: Guild, hostId: string, excludedIds: readonly string[] = []): Promise<InviteOption[]> {
	// Cache first, then one fetch. A cold cache after a restart would otherwise show
	// an almost empty picker in a busy guild.
	let members = guild.members.cache;
	if (members.size <= 1) members = await guild.members.fetch().catch(() => members);
	const excluded = new Set(excludedIds);

	return (
		members
			.filter((member) => !member.user.bot && member.id !== hostId && !excluded.has(member.id))
			.map((member) => ({
				label: (member.displayName || member.user.username).slice(0, 100),
				value: member.id,
				description: `@${member.user.username}`.slice(0, 100),
			}))
			// Discord caps a select at 25 options, which is also GAME_ROOM_MAX_SPECTATORS.
			// The two agreeing is deliberate rather than lucky: the picker cannot offer
			// more members than a room could carry overwrites for.
			.slice(0, BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS)
	);
}

/**
 * The submitted ids that are real, non bot members of this guild other than the host,
 * and not among `excludedIds` (members the host removed): the server side half of the
 * picker's exclusion, since a submission can name anyone whatever the menu offered.
 */
export async function refilterInvitees(guild: Guild, values: readonly string[], hostId: string, excludedIds: readonly string[] = []): Promise<string[]> {
	const excluded = new Set(excludedIds);
	const picked: string[] = [];
	for (const id of values.slice(0, BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS)) {
		if (id === hostId || excluded.has(id)) continue;
		const member = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
		if (member && !member.user.bot) picked.push(id);
	}
	return picked;
}
