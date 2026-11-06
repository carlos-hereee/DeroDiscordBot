import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── productionDatabaseGuard ──────────────────────────────────────────
// What:  tells whether a connection string reaches the production Atlas cluster, so a dev
//        boot can refuse it. The local bot shared production's database until 2026-11-06,
//        and nobody noticed for months because the two connection strings differ in nothing
//        a boot checks.
// Who:   db.ts, before connecting, only when NODE_ENV says development.
// Does NOT: guard the node scripts under scripts/, which connect on their own.

/** Whether a Mongo connection string points at the production cluster, whatever user or database it names. */
export function reachesProductionDatabase(uri: string): boolean {
	// Only the part after the credentials: a password may hold anything, including the host.
	const hosts = uri.slice(uri.lastIndexOf("@") + 1).toLowerCase();
	return hosts.includes(BOT_CONSTANTS.PRODUCTION_DATABASE_CLUSTER);
}
