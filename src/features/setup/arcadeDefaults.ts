// ── arcadeDefaults ───────────────────────────────────────────────────
// What:  the arcade's three switches and the value a new arcade starts with: chips
//        and the daily claim, the monthly arcade post, and Dero bot opponents, all on
//        (2026-10 item 257, owner item 11). The one table both writers read, so a
//        built arcade and a reset one cannot start differently. Also the one test of
//        whether a row's arcade is off, read by the switch and by a forced rebuild.
// Who:   GuildSetupManager.runAutoSetup (setup builds the arcade), arcadeSwitch
//        (/arcade on rebuilds it) and serverReset's CONFIG_DEFAULTS (Delete my data).
// Why:   the schema defaults are true too, but a schema default only shows on a read
//        of a missing field; writing the switches when the arcade is built makes the
//        stored row say what the server actually has, so no admin has to switch on
//        what the release promises is on.

/** Every arcade switch and its starting value. */
export const ARCADE_SWITCH_DEFAULTS = {
	chipEconomyEnabled: true,
	arcadeMonthlyPost: true,
	botOpponentsEnabled: true,
} as const;

type ArcadeSwitch = keyof typeof ARCADE_SWITCH_DEFAULTS;

/**
 * The write that switches the arcade on when it is built: every switch set to its
 * starting value, EXCEPT one the server already turned off. A stored false is an
 * admin's choice and stays false; anything else (missing, null, true) is written.
 */
export function arcadeSwitchesToWrite(stored: unknown): Partial<Record<ArcadeSwitch, boolean>> {
	const row = (stored ?? {}) as Partial<Record<ArcadeSwitch, unknown>>;
	const write: Partial<Record<ArcadeSwitch, boolean>> = {};
	for (const key of Object.keys(ARCADE_SWITCH_DEFAULTS) as ArcadeSwitch[]) {
		if (row[key] !== false) write[key] = ARCADE_SWITCH_DEFAULTS[key];
	}
	return write;
}

/**
 * True when every arcade slot is opted out and no category is recorded, which is what off
 * leaves behind and what a Headquarters only install stores. `arcadeFields` are the arcade's
 * managed channel fields, read off the specs by the caller so this file stays free of them.
 */
export function isArcadeOff(stored: unknown, arcadeFields: readonly string[]): boolean {
	const row = (stored ?? {}) as { gamesCategoryId?: string | null; userRemovedChannels?: readonly string[] | null };
	const removed = new Set(row.userRemovedChannels ?? []);
	return !row.gamesCategoryId && arcadeFields.every((field) => removed.has(field));
}
