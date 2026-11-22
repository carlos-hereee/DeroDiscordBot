import { randomBytes } from "node:crypto";

// ── shortId ─────────────────────────────────────────────────────────────────
// What:  the id of every new meeting, todo, reminder and summary job row (2026-11 item 388).
// Why:   the id rides button customIds, which Discord caps at 100 characters
//        (DISCORD_LIMITS.MAX_CUSTOM_ID_LENGTH) alongside a prefix and an action word, and a
//        36 character UUID would crowd that. Nine random bytes are 72 bits, which no guild's
//        rows will ever collide on, and base64url keeps them to 12 characters that are safe
//        in a customId, a URL path and a log line.

const SHORT_ID_BYTES = 9;

/** A fresh random id: 12 characters of A to Z, a to z, 0 to 9, underscore and the hyphen. */
export function shortId(): string {
	return randomBytes(SHORT_ID_BYTES).toString("base64url");
}
