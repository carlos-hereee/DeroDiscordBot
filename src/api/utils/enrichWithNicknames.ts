import { Client } from "discord.js";

// ── nickname backfill ────────────────────────────────────────
// What:  enrich a list of activity-style records with each warrior's CURRENT
//        per guild nickname (or globalName, or username) at API read time.
//        Records that were written before nickname tracking landed have the
//        bare Discord username stored, without this pass the dashboard
//        would keep rendering "silent6804" forever even after the warrior
//        sets a nickname inside the guild.
// Who:   /api/players (leaderboard + profile) and /api/leaderboard.
// When:  every read. The Discord member fetch hits the cache first; uncached
//        members fall back to a network fetch which is still cheap because
//        we deduplicate userIds before fetching.
// Where: import this from any route that returns records with a userId +
//        username pair. The route owns the {data} envelope; this helper just
//        rewrites the username field in place.
// How:   ① resolve the guild from the live Discord client (cache first,
//        fetch fallback). If the client has no view of the guild, e.g.
//        the bot was kicked between requests, we return the records
//        untouched so the API still responds.
//        ② collect the unique userIds and fetch them in BATCHES via
//        guild.members.fetch({ user: [...] }) rather than one fetch per id.
//        A 500-player leaderboard was previously 500 parallel member fetches
//        (a per-guild rate-limit hazard on a cold cache); batching makes it
//        ceil(N/100) requests instead. displayName is derived the same way
//        ActivityTracker does at write time so both code paths agree.
//        ③ map the records, swapping the username field when we have a
//        fresh value. Records without a resolved member keep their stored
//        username so a row never goes blank.

// Discord's REQUEST_GUILD_MEMBERS op accepts at most 100 user ids per call, so
// we chunk the unique id list to stay within that limit.
const MEMBER_FETCH_CHUNK_SIZE = 100;
export async function enrichWithNicknames<T extends { userId: string; username?: string }>(
	client: Client,
	guildId: string,
	records: T[]
): Promise<T[]> {
	if (records.length === 0) return records;

	const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
	if (!guild) return records;

	const uniqueIds = Array.from(new Set(records.map((r) => r.userId)));
	const nameById = new Map<string, string>();

	// Fetch members in chunks of 100 (the per-request id ceiling). Each chunk
	// is one batched request instead of one-per-id; a failed chunk is swallowed
	// so a single bad id never blanks the whole enrichment pass.
	for (let i = 0; i < uniqueIds.length; i += MEMBER_FETCH_CHUNK_SIZE) {
		const chunk = uniqueIds.slice(i, i + MEMBER_FETCH_CHUNK_SIZE);
		const members = await guild.members.fetch({ user: chunk }).catch(() => null);
		if (!members) continue;
		for (const member of members.values()) {
			const displayName = member.displayName ?? member.user.globalName ?? member.user.username;
			if (displayName) nameById.set(member.id, displayName);
		}
	}

	return records.map((r) => {
		const fresh = nameById.get(r.userId);
		return fresh ? { ...r, username: fresh } : r;
	});
}
