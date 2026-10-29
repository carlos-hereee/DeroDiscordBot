// ── plainRow ────────────────────────────────────────────────────────────────
// What:  turns a GuildConfig read into a plain object whose own keys are its fields.
// Who:   retireAdminControls (its corrupt row guard walks the row's entries) and
//        GuildSetupManager's forced rebuild settle step (it chains rows by spread).
// Why:   guildConfigStore returns a hydrated Mongoose document, whose own enumerable
//        keys are $__, $isNew and _doc rather than its fields, so Object.entries over
//        it sees nothing and `{ ...row }` keeps none of its fields. A plain object (a
//        lean read, a test fixture) passes through as it is.

/** The row as a plain object, or null when there is none. */
export function asPlainRow(row: unknown): Record<string, unknown> | null {
	if (!row || typeof row !== "object") return null;
	const document = row as { toObject?: () => unknown };
	return (typeof document.toObject === "function" ? document.toObject() : row) as Record<string, unknown>;
}
