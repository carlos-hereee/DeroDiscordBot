// ── keysetBound ──
// What:  the position a keyset page continues from: the last row's createdAt, and its id to
//        break a tie between rows created in the same millisecond (2026-11 item 388 Phase 5a).
// Who:   todoStore.listPage and meetingStore.listPage; api/utils/keysetCursor.ts turns the
//        dashboard's cursor string into one. A type only, so the stores stay thin.

export interface KeysetBound {
	createdAt: Date;
	id: string;
}
