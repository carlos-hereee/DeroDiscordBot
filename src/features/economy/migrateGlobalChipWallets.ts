import { chipWalletStore } from "@db/stores/chipWalletStore.js";

// ── migrateGlobalChipWallets ─────────────────────────────────────────
// What:  the boot migration that turns per server chip balances into one global wallet
//        per member (2026-10 item 267 Session 1a, owner decision 1: the balances are
//        ADDED TOGETHER). Every per server ChipWallet row is summed into its member's
//        global row once, and marked so it is never summed again.
// Who:   main.ts, once per boot, after the database connects and before any handler
//        registers, so no claim or buy in reads a global row the migration has not filled.
// Does NOT: delete or zero the per server rows. They stay, marked with migratedAt and
//        migratedAmount, as the owner's rollback (risk R1), until a later release drops them.
//
// How, per row: ① claim it with a conditional write that stamps migratedAt and
// migratedAmount and matches only while it is unclaimed; ② only when this boot won the
// claim, credit the member's global row with its chips and claimed total, keeping the
// later last claim. A second boot finds every row claimed and writes nothing.
//
// ⚠️ MONEY INVARIANT: CLAIM, THEN CREDIT, never the other way. A crash between ① and ②
// loses that ONE row's credit, and the row's migratedAmount says exactly what to restore
// by hand. The reverse order could credit a row twice on the next boot, which mints chips
// nobody can find again.
//
// ⚠️ THE ROWS ARE HYDRATED MONGOOSE DOCUMENTS. Every field is read by name; walking a row
// with Object.entries or a spread reads Mongoose internals, not the stored fields
// (item 263's f9a6a74).

// The last claim a merged member who never claimed in any server is given. The owner's
// decision makes every member the migration gives a global row one who has had their first
// claim, and only a non null lastClaimAt says so; the epoch keeps the daily claim open at once.
const NEVER_CLAIMED_AT = new Date(0);

/** What one boot of the migration did. */
export interface GlobalWalletMigrationResult {
	rowsMerged: number;
	chipsMerged: number;
	// Rows whose claim landed but whose credit threw: each is logged with its amount for a hand restore.
	creditsFailed: number;
}

/** The fields of a per server row the migration reads, by name. */
interface ServerWalletRow {
	_id: unknown;
	guildId: string;
	userId: string;
	balance: number;
	lastClaimAt: Date | null;
	totalClaimed: number;
}

/** Sum every unmigrated per server wallet into its member's global wallet. Idempotent: safe on every boot. */
export async function migrateGlobalChipWallets(now: Date = new Date()): Promise<GlobalWalletMigrationResult> {
	const result: GlobalWalletMigrationResult = { rowsMerged: 0, chipsMerged: 0, creditsFailed: 0 };
	const rows: ServerWalletRow[] = await chipWalletStore.findUnmigratedServerRows();
	for (const row of rows) await mergeRow(row, now, result);
	console.log(`[economy] global chip wallets: merged ${result.rowsMerged} server rows, ${result.chipsMerged} chips, ${result.creditsFailed} credits failed`);
	return result;
}

async function mergeRow(row: ServerWalletRow, now: Date, result: GlobalWalletMigrationResult): Promise<void> {
	const amount = row.balance ?? 0;
	// ①
	let claimed: boolean;
	try {
		claimed = await chipWalletStore.claimServerRowForMigration(row._id, amount, now);
	} catch (error) {
		// Nothing moved: the row stays unclaimed and the next boot tries it again.
		console.error(`[economy] claiming the chip wallet of ${row.userId} in guild ${row.guildId} for the global migration failed`, error);
		return;
	}
	// Another boot claimed it first, or its balance moved since the read; either way this
	// boot must not credit it.
	if (!claimed) return;

	// ②
	try {
		await chipWalletStore.mergeIntoGlobal({ userId: row.userId }, { amount, totalClaimed: row.totalClaimed ?? 0, lastClaimAt: row.lastClaimAt ?? NEVER_CLAIMED_AT });
		result.rowsMerged += 1;
		result.chipsMerged += amount;
	} catch (error) {
		result.creditsFailed += 1;
		console.error(
			`[economy] the global migration claimed the chip wallet of ${row.userId} in guild ${row.guildId} but crediting ${amount} chips to their global wallet failed; restore it from the row's migratedAmount`,
			error
		);
	}
}
