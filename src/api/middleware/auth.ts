import { createHash, timingSafeEqual } from "node:crypto";
import { dashboardApiKey } from "@utils/config.js";
import { Request, Response, NextFunction } from "express";

/**
 * Whether an `x-api-key` header carries the dashboard's shared key. Both sides are hashed to
 * SHA-256 before the compare, so timingSafeEqual always sees equal lengths and a caller cannot
 * learn the key a byte at a time from response timing, which a plain `!==` would allow. An empty
 * configured key never matches, so an unset DASHBOARD_API_KEY opens nothing. Shared by
 * apiKeyAuth and verifySignature's defense in depth check.
 */
export function isDashboardApiKey(header: unknown): boolean {
	if (typeof header !== "string" || header.length === 0 || dashboardApiKey.length === 0) return false;
	const given = createHash("sha256").update(header).digest();
	const expected = createHash("sha256").update(dashboardApiKey).digest();
	return timingSafeEqual(given, expected);
}

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
	if (!isDashboardApiKey(req.headers["x-api-key"])) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}

	next();
}
