import GuildConfigModel from "@db/models/GuildConfig.js";

// ── migrateArcadeChannelFields ────────────────────────────────────────
// What:  renames the two arcade channel id fields on every GuildConfig row that still
//        carries their pre-2026-08-12 names, including the copies nested inside the
//        `introMessageIds` subdocument.
// Who:   every guild that ran `/setup` on the 2026-08-10 or 2026-08-11 builds. A small
//        and knowable set, but the damage per guild is visible and permanent.
// When:  once per boot, before the ensureHomebase sweep in main.ts. That ordering is the
//        whole point: `repairMissingChannels` is what reads these fields, and it must not
//        see a legacy row.
// Where: the code side of the rename was complete on 2026-08-12 (a grep for the old names
//        returns nothing) and nothing migrated the DATA, which is the gap this closes.
//
// ⚠️ WHY A STALE ROW IS WORSE THAN "THE CHANNEL IS NOT FOUND". `gamesCategoryId` kept its
// name through the rename, so the CATEGORY still resolves and nothing looks broken. Both
// renamed fields read null, `repairMissingChannels` treats that as the legacy rebuild case,
// and `repairOneChannel`'s adopt-before-build scan matches on the channel's effective NAME.
// `⚔️challenges` is adopted (its display name did not change) but the rules channel is not,
// because the live one still carries the pre-rename display name, so a SECOND rules channel
// is created beside it. The drift-sync rename path cannot repair the orphan afterwards
// either: it keys off a stored id that is now null. The stranded `introMessageIds` entry
// separately makes `refreshIntroEmbeds` repost rather than edit.
//
// How:   one `$rename` per field pair, each filtered on the OLD field existing, so the write
//        touches only rows that still need it and re-running it is a no-op. `$rename` on a
//        field the document does not have is an error in a multi-update, which is why the
//        filter is `$exists: true` rather than a blanket update.

// The four paths, old to new. The nested pair matters as much as the top-level one: a
// stranded introMessageIds entry is what makes the intro embed repost instead of edit.
const FIELD_RENAMES: Record<string, string> = {
	gamesRulesChannelId: "arcadeRulesChannelId",
	gamesChallengesChannelId: "arcadeChallengesChannelId",
	"introMessageIds.gamesRulesChannelId": "introMessageIds.arcadeRulesChannelId",
	"introMessageIds.gamesChallengesChannelId": "introMessageIds.arcadeChallengesChannelId",
};

export interface ArcadeFieldMigrationResult {
	// Keyed by the OLD field name, so a log line names the thing that was actually stale.
	renamed: Record<string, number>;
	total: number;
}

export async function migrateArcadeChannelFields(): Promise<ArcadeFieldMigrationResult> {
	const renamed: Record<string, number> = {};
	let total = 0;

	for (const [oldField, newField] of Object.entries(FIELD_RENAMES)) {
		// Errors are swallowed per field rather than per sweep: a rename that fails on one
		// field must not stop the other three, and none of them is a precondition of the
		// others. Boot continues either way, because a failed migration leaves the row exactly
		// as it was and the next boot tries again.
		try {
			const result = await GuildConfigModel.updateMany(
				{ [oldField]: { $exists: true } },
				{ $rename: { [oldField]: newField } }
			);
			const count = result.modifiedCount ?? 0;
			if (count > 0) {
				renamed[oldField] = count;
				total += count;
			}
		} catch (error) {
			console.error("[setup] arcade field rename failed", { field: oldField, error });
		}
	}

	if (total > 0) {
		console.log("[setup] migrateArcadeChannelFields: renamed legacy arcade fields", renamed);
	}

	return { renamed, total };
}
