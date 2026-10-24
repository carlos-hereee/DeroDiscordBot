import { escapeMarkdown, type Client, type TextBasedChannel } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { networkConsentStore } from "@db/stores/networkConsentStore.js";
import { tagNoticeStore } from "@db/stores/tagNoticeStore.js";
import { readNetworkGuild } from "@features/game-rooms/networkRules.js";
import { botInviteLink } from "@utils/config.js";
import { onRatedWin, type RatedWin } from "./recordMatchRatings.js";

// ── tagNotice ────────────────────────────────────────────────────────
// What:  the tag notice (2026-10 item 244 Phase 5b, owner: "market companyuno by doing
//        something fun"): after a rated win, when the server tag the winner wears belongs
//        to a server that is not on the network, one line in the channel they won in
//        naming that server and inviting them to bring Dero there.
// Who:   registered once at boot from main.ts as recordMatchRatings' rated win listener.
// Does NOT: rate anything, post for a player who wears no tag (or hides it), or post more
//        than once per TAG_NOTICE_INTERVAL_MS for any one player, however many they win.
//
// How:   ① read the winner's worn tag, when the win is announced; ② stop when there is
//        none, or its server is on the network already; ③ find the channel they won in
//        (their satellite at a network table, else the room); ④ claim the 30 day throttle
//        atomically, on the winner's NetworkConsent row when they have one and on a small
//        TagNotice row when they do not (a consent row must never be written for somebody
//        who did not consent); ⑤ post the one line. The claim comes last of the checks so
//        a notice that could not go out never spends the player's 30 days.

const words = rokCommanderCopy.arcadeNetwork.tagNotice;

/** Bind the tag notice to rated wins. Called once at boot from main.ts. */
export function registerTagNotice(client: Client): void {
	onRatedWin((win) => {
		void sendTagNotice(client, win).catch((error) =>
			console.warn("[ratings] tag notice failed", { roomId: win.room.roomId, userId: win.winnerId, error })
		);
	});
}

/** Send the tag notice for one rated win when the rules allow it. Answers whether a line was posted. */
export async function sendTagNotice(client: Client, win: RatedWin, now: Date = new Date()): Promise<boolean> {
	// ①②
	const tag = await wornTag(client, win.winnerId);
	if (!tag) return false;
	const tagServer = await readNetworkGuild(client, tag.guildId);
	if (tagServer.onNetwork) return false;
	const line = noticeLine(win.winnerId, client.guilds.cache.get(tag.guildId)?.name ?? null, tag.text);
	if (!line) return false;

	// ③
	const channel = await winningChannel(client, win);
	if (!channel || !("send" in channel)) return false;

	// ④⑤
	if (!(await claimTagNotice(win.winnerId, now))) return false;
	await channel.send({ content: line, allowedMentions: { users: [win.winnerId] } });
	return true;
}

/**
 * Claim the tag notice for one player: true at most once per TAG_NOTICE_INTERVAL_MS.
 * On their consent row when they have one (any version: the stamp lives there), else on
 * the TagNotice row kept for players who never consented.
 */
export async function claimTagNotice(userId: string, now: Date): Promise<boolean> {
	const cutoff = new Date(now.getTime() - BOT_CONSTANTS.NETWORK.TAG_NOTICE_INTERVAL_MS);
	if (await networkConsentStore.findByUserId(userId)) return networkConsentStore.claimTagNotice(userId, cutoff, now);
	return tagNoticeStore.claim(userId, cutoff, now);
}

// The one line: the server by name when Dero is in it (its admins only need to open it to
// the network), or by its tag with Dero's invite when Dero is not. A server Dero is not
// in with no tag text either has nothing to name it by, and a line naming nothing is not sent.
function noticeLine(winnerId: string, serverName: string | null, tagText: string | null): string | null {
	if (serverName) return words.notOnNetwork(winnerId, escapeMarkdown(serverName));
	if (tagText) return words.notInServer(winnerId, escapeMarkdown(tagText), botInviteLink);
	return null;
}

// The server whose tag the player wears and shows, and the tag's text, or null.
async function wornTag(client: Client, userId: string): Promise<{ guildId: string; text: string | null } | null> {
	const user = client.users.cache.get(userId) ?? (await client.users.fetch(userId).catch(() => null));
	const identity = user?.primaryGuild;
	if (!identity?.identityEnabled || !identity.identityGuildId) return null;
	return { guildId: identity.identityGuildId, text: identity.tag ?? null };
}

// Where the winner played: the satellite that seats them at a network table, else the
// room's own channel. A room whose channel is already gone has nowhere to post.
async function winningChannel(client: Client, win: RatedWin): Promise<TextBasedChannel | null> {
	const satellite = (win.room.satellites ?? []).find((entry) => entry.userIds.includes(win.winnerId));
	const channelId = satellite?.channelId ?? win.room.channelId ?? null;
	if (!channelId) return null;
	const channel = await client.channels.fetch(channelId).catch(() => null);
	return channel && channel.isTextBased() ? channel : null;
}
