import { DiscordAPIError } from "discord.js";

// ── discordGone ──────────────────────────────────────────────────────
// What:  one question asked of Discord, "is this thing gone?", answered true only when Discord
//        itself said the thing does not exist.
// Who:   the satellite boot reconcile (a satellite channel or member gone) and the rematch check
//        (a player who left the server during the match).
// Why:   a fetch fails for many reasons (a timeout, a rate limit, a gateway hiccup), and reading
//        any failure as "gone" would seat a member out of their match over a network blip. Only
//        Discord's own Unknown answer (the RESTJSONErrorCodes the caller names) proves it.

/** True only when `fetch` failed with Discord's `unknownCode`; any success or other failure is false. */
export async function isGone(fetch: () => Promise<unknown>, unknownCode: number): Promise<boolean> {
	try {
		await fetch();
		return false;
	} catch (error) {
		return error instanceof DiscordAPIError && error.code === unknownCode;
	}
}
