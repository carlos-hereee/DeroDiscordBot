// ── canonicalPhrase ──────────────────────────────────────────────────
// What:  the forgiving form of a phrase a member retypes by hand: uppercase with
//        everything but letters and digits dropped, so "GILDED BY SILENT" as an
//        announcement prints it matches the constant GILDED-BY-SILENT.
// Who:   fortune/secretCodes.ts and economy/chipGift.ts, the two things /secret-code
//        matches a phrase against.

/** A phrase reduced to its letters and digits, uppercased. */
export const canonicalPhrase = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
