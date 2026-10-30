import { GameRoom, type BlackjackLateCharge, type BlackjackStackEntry, type IGameRoom, type TurnPromptRecord } from "@db/models/GameRoom.js";
import {
	NON_TERMINAL_ROOM_STATUSES,
	ROOMS_AWAITING_PLAY,
	type GameSlug,
	type RatingBand,
	type RoomMove,
	type RoomStatus,
	type RoomVisibility,
	type SatelliteRoom,
	type SpectatorMode,
} from "@features/game-rooms/roomTypes.js";

// ── gameRoomStore ──
// What:  the thin Mongoose wrapper over the GameRoom collection. Query shapes only; every
//        decision about WHEN a room may open, finish, or be swept lives in features/game-rooms.
// Who:   RoomProvisioner, roomTrail, roomLifecycle, roomArchiveSweep, the gameroom: button
//        handlers, and later the dashboard's GET /api/game-rooms route.
// When:  on member interaction (open, move, forfeit) and on the 5-minute archive cron.
// Where: guild scoping is a security boundary (invariant 2), so every method except the
//        cross-guild sweep query takes guildId and filters on it. A roomId that belongs to
//        another guild therefore reads as NOT FOUND rather than forbidden, which is what stops
//        a caller probing whether a room exists somewhere else. The satellite methods are
//        the one other shape: they are asked from a REMOTE guild, so they take that guild
//        and match it inside the satellite entry rather than on the row's own guildId.
// How:   house store rules apply: thin wrappers, no business logic, no tests against Mongo
//        itself (rule 6). The behavioral guarantee that matters most here, one open room per
//        host, is enforced by the schema's partial unique index rather than by anything in
//        this file, which is why create() surfaces a duplicate-key error instead of pre-checking.

interface ICreateGameRoom {
	guildId: string;
	game: GameSlug;
	hostId: string;
	visibility: RoomVisibility;
	// Seeded with the host; the accepted opponent is added when the host confirms.
	playerIds?: string[];
	spectatorIds?: string[];
	boardMessageId?: string | null;
	// Set at create when this room is a rematch of a finished one, so the button's
	// idempotency check and the row are born in the same write with no race window.
	rematchedFromRoomId?: string | null;
	// Set at create only by a rematch in the same channel, whose row takes over a
	// channel that already exists. Born pointing at it so the channel always has a row
	// that will archive it, whichever write a crash lands between.
	channelId?: string | null;
	// Monopoly's match settings, carried from the finished room by a rematch. A board
	// challenge sets them on its draft with the card's toggles instead.
	monopolyAuctions?: boolean;
	// Dero bot opponents (2026-10 item 250 Phase 5): offered on a new card, carried in
	// number by a rematch, which seats the same bots again.
	botsOffered?: boolean;
	botSeats?: number;
	// The host's Casual choice (2026-10 item 254, Arcade 6), carried by a rematch so it
	// stays unrated like the match it follows.
	casual?: boolean;
	// A ranked rematch's buy ins (2026-10 item 276), charged before the row exists and born on its
	// draft ledger, so every refund a draft has (the start's failure, the idle sweep) reaches them.
	buyInPaidBy?: string[];
	// Null (the default) reads as the game's own default in roomTypes.refereeOn: on for Hold'em
	// (2026-10 item 263 R3-28), off for Monopoly. A rematch carries the finished room's choice.
	referee?: boolean | null;
	// The host's Dero voice (2026-10 item 267), read before referee by roomTypes.refereeOn. A
	// rematch carries the finished room's choice here.
	deroVoice?: boolean | null;
	// The host controls, carried from the finished room by a rematch in the same
	// channel, so a member removed from that channel stays removed. A board challenge
	// sets them on its draft with the card's controls instead.
	ratingBand?: RatingBand;
	requireApproval?: boolean;
	kickedIds?: string[];
	// The host's spectator setting, carried from the finished room by a rematch so the
	// rematch is watched by exactly who watched the match before it.
	spectatorMode?: SpectatorMode | null;
	// The buy in, carried from the finished room by a Blackjack rematch (2026-10 item 267), so
	// every returning player pays what they paid before.
	holdemBuyIn?: number | null;
}

// Mongo's duplicate key error code, what the one open room per host index answers with.
const DUPLICATE_KEY_CODE = 11000;

// Where an accepted join request lands: the draft's pool, or a live room's players.
export type AdmittedJoinField = "spectatorIds" | "playerIds";

// Where a match keeps its board message id: every board game's `boardMessageId`, and the
// hangman gallows card's own `gallowsMessageId`, which predates the shared turn board.
export type BoardMessageField = "boardMessageId" | "gallowsMessageId";

// ⚠️ EVERY MOVE WRITE MATCHES A ROOM STILL IN PLAY (2026-10 item 276, audit root cause A). A move
// is read, decided and written back with awaits between, and in that gap the room can be finished
// from outside the game (a surrender, the leave watcher, the idle sweep, a give up), which never
// touches the game's own state in `secret`. A compare and swap on `secret` alone then still
// matches, and the move lands on a finished match: a shot after a surrender, a Monopoly payment
// after the watcher ended it, a hangman guess after the give up. Matching the status here, in the
// three writers every move goes through, is decided once for every game instead of per caller,
// so a new move writer cannot forget it.
const STILL_IN_PLAY = { status: "playing" } as const;

// The one body behind setSecretField and setSecretFieldsIf (read their comments). Same two write
// shape as claimSecretField: `secret` defaults to null and Mongo will not create a dotted path
// inside a null, and the seeding write is safe to race.
async function setSecretPathsIf(guildId: string, roomId: string, expected: Record<string, unknown>, fields: Record<string, unknown>) {
	await GameRoom.updateOne({ guildId, roomId, secret: null }, { $set: { secret: {} } });
	const set = Object.fromEntries(Object.entries(fields).map(([path, value]) => [`secret.${path}`, value]));
	return GameRoom.findOneAndUpdate({ guildId, roomId, ...expected, ...STILL_IN_PLAY }, { $set: set }, { new: true });
}

/**
 * Where the start claim moves a chip match's buy ins as it empties the draft ledger
 * (gameRoomStore.claimForPlay), so no moment holds a buy in that no ledger has. `seatIds` are the
 * seats Start read, host first, and `buyIn` what each of them paid.
 * - `blackjackStacks`: each seat still paid becomes a stacks entry at its buy in (2026-10 item 276).
 * - `chipPot`: a ranked Monopoly or Battleship match's pot takes EVERY payer (2026-10 item 278, G1).
 * - `heldBuyIns`: a Hold'em chip table holds EVERY payer until its table is saved (item 278, G2).
 * The pot and the held seats take every payer, not only the seats Start read, so a payer the room
 * then seats nowhere is still on a ledger until a pull claims their refund.
 */
export type StartLedger =
	| { kind: "blackjackStacks"; buyIn: number; seatIds: readonly string[]; actedAt: Date }
	| { kind: "chipPot" | "heldBuyIns"; buyIn: number; seatIds: readonly string[] };

// The claim pipeline's fields for `ledger`, every one read from the draft ledger as the write
// finds it. The pot and the held seats list the seats Start read that are still paid, in seat
// order (potPayouts gives a remainder to the first), then every other payer in the order they
// paid. The target field is null on a draft, so the embedded document replaces it whole.
function startLedgerFields(ledger: StartLedger): Record<string, unknown> {
	const paid = { $ifNull: ["$buyInPaidBy", []] };
	const seatIds = { $literal: [...ledger.seatIds] };
	const stillPaidSeats = { $filter: { input: seatIds, cond: { $in: ["$$this", paid] } } };
	if (ledger.kind === "blackjackStacks") {
		const stacks = { $map: { input: stillPaidSeats, as: "seat", in: { userId: "$$seat", buyIn: { $literal: ledger.buyIn }, stack: { $literal: ledger.buyIn } } } };
		return { blackjackStacks: stacks, blackjackActedAt: { $literal: ledger.actedAt } };
	}
	const otherPayers = { $filter: { input: paid, cond: { $not: [{ $in: ["$$this", seatIds] }] } } };
	return { [ledger.kind]: { buyIn: { $literal: ledger.buyIn }, userIds: { $concatArrays: [stillPaidSeats, otherPayers] } } };
}

export const gameRoomStore = {
	// Insert a new draft room.
	//
	// NOT an upsert, unlike activityStore.upsert: a room is genuinely new every time, and the
	// partial unique index on (guildId, hostId) over the non-terminal statuses is the guard
	// against a second one. That means a host who already holds an open room makes this THROW
	// a Mongo duplicate-key error (code 11000), and RoomProvisioner is expected to catch it and
	// reply with a jump link to the existing room. Do NOT convert this to an upsert to make the
	// error go away: the throw IS the F11 enforcement, and upserting would resurrect a stale
	// draft into a live room.
	async create(input: ICreateGameRoom) {
		return GameRoom.create({
			guildId: input.guildId,
			game: input.game,
			hostId: input.hostId,
			visibility: input.visibility,
			playerIds: input.playerIds ?? [input.hostId],
			spectatorIds: input.spectatorIds ?? [],
			boardMessageId: input.boardMessageId ?? null,
			rematchedFromRoomId: input.rematchedFromRoomId ?? null,
			channelId: input.channelId ?? null,
			monopolyAuctions: input.monopolyAuctions ?? false,
			referee: input.referee ?? null,
			deroVoice: input.deroVoice ?? null,
			ratingBand: input.ratingBand ?? "any",
			requireApproval: input.requireApproval ?? false,
			kickedIds: input.kickedIds ?? [],
			botsOffered: input.botsOffered ?? false,
			botSeats: input.botSeats ?? 0,
			casual: input.casual ?? false,
			spectatorMode: input.spectatorMode ?? null,
			holdemBuyIn: input.holdemBuyIn ?? null,
			buyInPaidBy: input.buyInPaidBy ?? [],
			status: "draft",
		});
	},

	// The Rematch button's idempotency check: has ANY room already been opened as a
	// rematch of this finished one? Statuses are deliberately not filtered, because a
	// rematch that was itself cancelled or finished still consumed the one offer.
	async findByRematchedFrom(guildId: string, roomId: string) {
		return GameRoom.findOne({ guildId, rematchedFromRoomId: roomId });
	},

	// Primary lookup for every gameroom: button, whose customId carries the roomId.
	async findByRoomId(guildId: string, roomId: string) {
		return GameRoom.findOne({ guildId, roomId });
	},

	// Used by the in-room handlers (which know their channel, not their roomId) and by
	// ChannelDeleteWatcher to recognize that a deleted channel was a live room rather than a
	// managed homebase slot it should rebuild.
	async findByChannelId(guildId: string, channelId: string) {
		return GameRoom.findOne({ guildId, channelId });
	},

	// Another row on the same channel: during a rematch's takeover the new row is born on the
	// channel before the finished one releases it, so for that moment two rows point at it. The
	// archive re-checks here before it deletes a channel (2026-10 item 276, audit P3).
	async findOtherRoomOnChannel(guildId: string, channelId: string, roomId: string) {
		return GameRoom.findOne({ guildId, channelId, roomId: { $ne: roomId } });
	},

	// The friendly half of the one-room-per-host rule: a hit means the host already has a room,
	// so the caller can reply with a jump link instead of letting create() throw. The `$in` list
	// is imported from roomTypes so this query and the partial unique index cannot disagree.
	async findOpenByHost(guildId: string, hostId: string) {
		return GameRoom.findOne({ guildId, hostId, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } });
	},

	// Every live room in this guild the given member is PLAYING in. Backs the
	// GuildMemberRemove watcher, which runs on EVERY departure whether or not the
	// member was in a room, so in a busy guild this fires around once a minute.
	//
	// ⚠️ THE QUERY MUST STAY ON THE { guildId, playerIds, endedAt } COMPOUND INDEX.
	// guildId + playerIds is that index's prefix, so this shape is an index seek; a
	// bare { playerIds: userId } would collection-scan the whole rooms history on
	// every leave, which is a Mongo bill for an event that almost never matches.
	async findOpenByPlayer(guildId: string, userId: string) {
		return GameRoom.find({ guildId, playerIds: userId, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } });
	},

	// Backs the GAME_ROOM_MAX_PER_GUILD check. Counting live rooms rather than channels is
	// deliberate: it stays correct even if an admin deletes a room channel by hand, whereas
	// counting the games category's children would drift.
	async countOpenInGuild(guildId: string): Promise<number> {
		return GameRoom.countDocuments({ guildId, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } });
	},

	// Backs the tier-gated PRIVATE room quota: how many live rooms of the given
	// visibilities this guild holds. The { guildId, status } compound index covers the
	// selective half of the filter; visibility is narrowed from those candidates.
	async countOpenInGuildByVisibility(guildId: string, visibilities: RoomVisibility[]): Promise<number> {
		return GameRoom.countDocuments({
			guildId,
			status: { $in: [...NON_TERMINAL_ROOM_STATUSES] },
			visibility: { $in: visibilities },
		});
	},

	// General patch, for the draft-stage edits the challenge board makes: visibility,
	// the board message id, and the player/pool arrays at the moment the host starts.
	//
	// Separate from setStatus because a draft edit is NOT a lifecycle transition and
	// must not have to name a status to avoid changing one. Callers pass only what
	// changed; this store decides nothing.
	async update(guildId: string, roomId: string, patch: Partial<IGameRoom>) {
		return GameRoom.findOneAndUpdate({ guildId, roomId }, { $set: patch }, { new: true });
	},

	// A starting draft's players and leftover pool, as its host's Start chose them.
	//
	// ⚠️ ONLY MEMBERS STILL IN THE POOL ARE WRITTEN (2026-10 item 276, found in Phase 1). Start read
	// the pool seconds before this write, and a member the host removed or who left the server in
	// between was pulled from it (removeMember, leaveDraftPool); writing the stale lists back would
	// seat them with a channel overwrite and, in Monopoly, a seat. So each list is filtered against
	// the pool as stored, in the same write: the host always stays, everyone else must still be in
	// spectatorIds. Matches a draft only; null when the draft already started or closed. An update
	// pipeline rather than $set, because only a pipeline can read the stored pool in the write; the
	// literal id lists are safe in it since a member id is digits and never starts with "$".
	async seatDraft(guildId: string, roomId: string, hostId: string, playerIds: readonly string[], spectatorIds: readonly string[]) {
		const stillPooled = (ids: readonly string[], keepHost: boolean) => ({
			$filter: {
				input: [...ids],
				cond: { $or: [...(keepHost ? [{ $eq: ["$$this", hostId] }] : []), { $in: ["$$this", { $ifNull: ["$spectatorIds", []] }] }] },
			},
		});
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, status: "draft" },
			[{ $set: { playerIds: stillPooled(playerIds, true), spectatorIds: stillPooled(spectatorIds, false) } }],
			{ new: true }
		);
	},

	// Compare and swap on the Mixed `secret` blob: write it only if the row still
	// matches what the caller read.
	//
	// ⚠️ THIS IS THE CONCURRENCY CLAIM FOR EVERY GAME THAT KEEPS ITS STATE IN
	// `secret`, and `update` above cannot serve that purpose. `secret` is a single
	// Mixed field, so `$set` REPLACES it wholesale; two handlers that both read the
	// same room and both write back leave only the second one's work, and the first
	// player's move, seat or shot is gone with nothing logged. Passing the value the
	// caller read as `expected` (a dotted subfield such as `secret.lastActionAt` or
	// `secret.handNumber`) makes Mongo compare it server side, so the loser writes
	// nothing and gets a null back to react to.
	//
	// `extra` carries update operators that must land in the SAME write, which is
	// what keeps a seat and its playerIds entry atomic with each other. Use an atomic
	// operator there ($addToSet, $push), never another read-modify-write.
	//
	// The room must also still be playing (STILL_IN_PLAY above), so a move read before a finish
	// writes nothing once the room is finished, whatever `expected` names.
	//
	// Returns the updated row, or null when the expectation did not hold. A null is
	// an ordinary outcome, not an error: the caller re-reads and retries, or defers
	// to whoever won.
	async updateSecretIf(
		guildId: string,
		roomId: string,
		expected: Record<string, unknown>,
		secret: unknown,
		extra: Record<string, unknown> = {}
	) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, ...expected, ...STILL_IN_PLAY },
			{ $set: { secret }, ...extra },
			{ new: true }
		);
	},

	// ── The board message of a match in a room (2026-10 item 254 Phase 4b, generalized by item 257 Phase 4a) ──
	// Point a match at the board message just posted, but only while it still points at
	// `fromMessageId`: a dotted $set, so it touches nothing a move wrote, and conditional, so a
	// repost that lost to another one writes nothing. Null when it lost. `alsoSet` rides the
	// same write (Hold'em stamps the reveal the new table shows), so the id and the stamp can
	// never disagree. Every game whose turns post a new board (turnBoard.postTurnBoard) claims
	// through this one method, hangman by its own `field`.
	async moveBoardMessage(
		guildId: string,
		roomId: string,
		fromMessageId: string | null,
		toMessageId: string,
		alsoSet: Record<string, unknown> = {},
		field: BoardMessageField = "boardMessageId"
	) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, [`secret.${field}`]: fromMessageId },
			{ $set: { [`secret.${field}`]: toMessageId, ...alsoSet } },
			{ new: true }
		);
	},

	// ── The turn prompt (2026-10 item 257 Phase 4a) ──
	// Point the room at the prompt line just posted, but only while it still holds the prompt
	// the caller read (`fromFingerprint`, null for none): two syncs racing for one turn post
	// two lines and exactly one claim lands, the loser deletes its own. Answers the row as it
	// stood BEFORE the write (the previous prompt, for the caller to retire), or null when it lost.
	async claimTurnPrompt(guildId: string, roomId: string, fromFingerprint: string | null, next: Omit<TurnPromptRecord, "played">) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, "turnPrompt.fingerprint": fromFingerprint },
			{ $set: { turnPrompt: { ...next, played: false } } },
			{ new: false }
		);
	},

	// Mark the current prompt's turn as played through its modal, or take the mark back when the
	// move was refused. Conditional on the fingerprint, so a turn that already passed is untouched.
	async setTurnPromptPlayed(guildId: string, roomId: string, fingerprint: string, played: boolean) {
		return GameRoom.findOneAndUpdate({ guildId, roomId, "turnPrompt.fingerprint": fingerprint }, { $set: { "turnPrompt.played": played } }, { new: true });
	},

	// Point the current prompt at the message that replaced its line (the turn clock's warning).
	// Conditional on the fingerprint AND the old message, so a turn that moved on is untouched.
	async moveTurnPromptMessage(guildId: string, roomId: string, fingerprint: string, fromMessageId: string, toMessageId: string) {
		return GameRoom.findOneAndUpdate({ guildId, roomId, "turnPrompt.fingerprint": fingerprint, "turnPrompt.messageId": fromMessageId }, { $set: { "turnPrompt.messageId": toMessageId } }, { new: true });
	},

	// Change only the layout stamp of the current prompt (Monopoly's extra buttons come and go
	// within one turn). Conditional on the fingerprint, so a prompt that moved on is untouched.
	async setTurnPromptLayout(guildId: string, roomId: string, fingerprint: string, layout: string) {
		return GameRoom.findOneAndUpdate({ guildId, roomId, "turnPrompt.fingerprint": fingerprint }, { $set: { "turnPrompt.layout": layout } }, { new: true });
	},

	// ── The Hold'em buy in on a draft (2026-10 item 257 Phase 4a) ──
	// The host sets the amount while nobody has paid it: conditional on an empty ledger, so a
	// joiner who paid first makes this refuse. An older draft row may lack the ledger field.
	async setHoldemBuyIn(guildId: string, roomId: string, amount: number | null) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, status: "draft", $or: [{ buyInPaidBy: { $exists: false } }, { buyInPaidBy: { $size: 0 } }] },
			{ $set: { holdemBuyIn: amount } },
			{ new: true }
		);
	},

	// Record that a joiner's wallet was charged, but only against the buy in they were charged
	// (`expectedBuyIn`, null for the standard one): a host who changed the amount meanwhile makes
	// this refuse and the caller gives the chips back.
	// Null when the member is already on the ledger, so a double press is charged once (2026-10 item 263 risk R7).
	async addBuyInPaid(guildId: string, roomId: string, userId: string, expectedBuyIn: number | null) {
		return GameRoom.findOneAndUpdate({ guildId, roomId, status: "draft", holdemBuyIn: expectedBuyIn, buyInPaidBy: { $ne: userId } }, { $addToSet: { buyInPaidBy: userId } }, { new: true });
	},

	// Claim one member's refund: the row BEFORE the pull, or null when they were not on the ledger.
	// Whoever gets the row pays the chips back, so two refunds for one payment pay once.
	async takeBuyInPaid(guildId: string, roomId: string, userId: string) {
		return GameRoom.findOneAndUpdate({ guildId, roomId, buyInPaidBy: userId }, { $pull: { buyInPaidBy: userId } }, { new: false });
	},

	// ── The buy ins the start claim moved off the draft ledger (2026-10 item 278) ──
	// A payer the room did not seat comes off a ranked match's pot: the row BEFORE the pull, or
	// null when they were not in it. Only on a row still playing, because finish pays the pot from
	// the row its own claim returned: a pull that landed after that claim would refund a buy in the
	// finish already paid out as a share, so a finished row refuses it and the share stands.
	async takePotPayer(guildId: string, roomId: string, userId: string) {
		return GameRoom.findOneAndUpdate({ guildId, roomId, ...STILL_IN_PLAY, "chipPot.userIds": userId }, { $pull: { "chipPot.userIds": userId } }, { new: false });
	},

	// One payer comes off a Hold'em table's held buy ins: the row BEFORE the pull, or null when they
	// were not held. No status filter: finish refunds these by this same pull, entry by entry, so
	// whoever pulls an entry pays it and nobody pays it twice.
	async takeHeldBuyIn(guildId: string, roomId: string, userId: string) {
		return GameRoom.findOneAndUpdate({ guildId, roomId, "heldBuyIns.userIds": userId }, { $pull: { "heldBuyIns.userIds": userId } }, { new: false });
	},

	// Save a Hold'em room's opening table, pulling every seat it gives a stack off the held buy ins
	// in the SAME write (2026-10 item 278, gap G2), so each buy in is on the row as held or as a
	// stack and never as both or neither. Matches only a room still playing whose held buy ins still
	// name every one of `seatedPayers`: a finish that landed first refunds the held entries itself,
	// and a table written after it would be a second claim on the same chips. Null when refused. A
	// table nobody paid for (free play, the rules card, a rematch's joining table) passes no payers.
	async saveOpeningHoldemTable(guildId: string, roomId: string, secret: IGameRoom["secret"], seatedPayers: readonly string[]) {
		const filter = { guildId, roomId, ...STILL_IN_PLAY, ...(seatedPayers.length > 0 ? { "heldBuyIns.userIds": { $all: [...seatedPayers] } } : {}) };
		const update = { $set: { secret }, ...(seatedPayers.length > 0 ? { $pull: { "heldBuyIns.userIds": { $in: [...seatedPayers] } } } : {}) };
		return GameRoom.findOneAndUpdate(filter, update, { new: true });
	},

	// ── A Blackjack chip table's stacks (2026-10 item 267, risk R5) ──
	// The ledger as the table opens: one entry per paid seat. Null when the room is gone.
	async openBlackjackStacks(guildId: string, roomId: string, entries: readonly BlackjackStackEntry[], actedAt: Date) {
		return GameRoom.findOneAndUpdate({ guildId, roomId }, { $set: { blackjackStacks: entries, blackjackActedAt: actedAt } }, { new: true });
	},

	// The stacks after a settle, one positional write per seat in ONE update. An entry already
	// claimed (a seat that cashed out, or a finish that paid the table) matches no array filter,
	// so this can never put a paid seat back on the ledger.
	async saveBlackjackStacks(guildId: string, roomId: string, stacks: readonly { userId: string; stack: number }[], actedAt: Date | null) {
		const set: Record<string, unknown> = {};
		const arrayFilters: Record<string, string>[] = [];
		stacks.forEach((entry, index) => {
			set[`blackjackStacks.$[seat${index}].stack`] = entry.stack;
			arrayFilters.push({ [`seat${index}.userId`]: entry.userId });
		});
		if (actedAt) set.blackjackActedAt = actedAt;
		if (Object.keys(set).length === 0) return null;
		return GameRoom.findOneAndUpdate({ guildId, roomId }, { $set: set }, { new: true, arrayFilters });
	},

	// A member sits down at a ranked Blackjack table while it plays (2026-10 item 276, D14): their
	// ledger entry (a chip table's; null at a free one) and their playerIds place in ONE write, so
	// the seat and the permission that follows it never disagree. It matches only a playing room
	// the member was not removed from and holds no entry for yet, so a finish that claimed the row
	// first, a removal, or a second write for the same member applies nothing (null).
	//
	// A chip seat names the `chargeId` its buy in was held under (holdLateSeatCharge): the write then
	// matches only while that held charge is still on the row and takes it off as it adds the entry,
	// so the charge is on the row exactly once, as held or as a stack (2026-10 item 276, audit P3).
	async addLateBlackjackSeat(guildId: string, roomId: string, userId: string, entry: BlackjackStackEntry | null, chargeId: string | null = null) {
		return GameRoom.findOneAndUpdate(
			{
				guildId,
				roomId,
				status: "playing",
				kickedIds: { $ne: userId },
				"blackjackStacks.userId": { $ne: userId },
				...(chargeId ? { "blackjackLateCharges.chargeId": chargeId } : {}),
			},
			{
				$addToSet: { playerIds: userId },
				...(entry ? { $push: { blackjackStacks: entry } } : {}),
				...(chargeId ? { $pull: { blackjackLateCharges: { chargeId } } } : {}),
			},
			{ new: true }
		);
	},

	// Hold a late seat's buy in on the row BEFORE the wallet is charged (2026-10 item 276, audit P3),
	// so a crash between the charge and the stacks entry leaves a record finish can refund. Matches
	// only a playing room the member was not removed from and holds no seat or held charge in.
	async holdLateSeatCharge(guildId: string, roomId: string, charge: BlackjackLateCharge) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, status: "playing", kickedIds: { $ne: charge.userId }, "blackjackStacks.userId": { $ne: charge.userId }, "blackjackLateCharges.userId": { $ne: charge.userId } },
			{ $push: { blackjackLateCharges: charge } },
			{ new: true }
		);
	},

	// Let a held late seat charge go, once its seat was refused and the charge given back or never taken.
	async dropLateSeatCharge(guildId: string, roomId: string, chargeId: string) {
		await GameRoom.updateOne({ guildId, roomId }, { $pull: { blackjackLateCharges: { chargeId } } });
	},

	// Claim one seat's cash out: the entry as it stood, or null when it was already claimed.
	// Whoever gets the entry pays the chips, so a leave racing a finish pays once.
	async takeBlackjackStack(guildId: string, roomId: string, userId: string): Promise<BlackjackStackEntry | null> {
		const before = await GameRoom.findOneAndUpdate({ guildId, roomId, "blackjackStacks.userId": userId }, { $pull: { blackjackStacks: { userId } } }, { new: false });
		const entry = before?.blackjackStacks?.find((candidate) => candidate.userId === userId);
		return entry ? { userId: entry.userId, buyIn: entry.buyIn, stack: entry.stack } : null;
	},

	// Claim the referee's one silent notice for this match. Null when it was already claimed.
	async claimRefereeNotice(guildId: string, roomId: string, at: Date) {
		return GameRoom.findOneAndUpdate({ guildId, roomId, monopolyRefereeNoticeAt: null }, { $set: { monopolyRefereeNoticeAt: at } }, { new: true });
	},

	// Hand an open room from one host to another. The partial unique index refuses a
	// member who already hosts an open room with a duplicate key error, which reads as
	// "taken" here so the caller can try the next seat; null means the room is no longer
	// open or no longer hosted by `fromHostId`.
	async transferHost(guildId: string, roomId: string, fromHostId: string, toHostId: string): Promise<IGameRoom | "taken" | null> {
		try {
			return await GameRoom.findOneAndUpdate(
				{ guildId, roomId, hostId: fromHostId, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } },
				{ $set: { hostId: toHostId } },
				{ new: true }
			);
		} catch (error) {
			if ((error as { code?: number })?.code === DUPLICATE_KEY_CODE) return "taken";
			throw error;
		}
	},

	// Claim ONE field inside the `secret` blob, and only if nobody has claimed it yet.
	//
	// ⚠️ NARROWER THAN updateSecretIf, AND BETTER WHERE IT FITS. The CAS above writes the whole
	// blob, so it needs the caller to have read a value it can compare against. A per-player slot
	// (`picks.<userId>`, `pending.<userId>`) does not need that: a dotted $set touches only its own
	// subfield, so two players claiming DIFFERENT slots in the same tick both land and neither can
	// erase the other. That is the failure this replaces for rps, where both picks arriving in one
	// tick left only the second, `bothIn` was false for both players, and the room sat at "playing"
	// forever holding its host's one-room slot with nothing sweeping it.
	//
	// TWO writes, and the first one is not optional. `secret` defaults to null, and Mongo refuses to
	// create a dotted path inside a null ("Cannot create field 'picks' in element {secret: null}"),
	// so a fresh room has nothing to write into. Seeding it is safe to race: the `secret: null`
	// filter stops matching the instant anybody's claim lands, so a late seeder cannot wipe a claim
	// that beat it, and two seeders that both match write the same empty object.
	//
	// `path` is interpolated into the query, so it must never carry user text. Every caller today
	// passes a Discord snowflake, which is digits only.
	//
	// Returns the updated row, whose `secret` reflects EVERY claim including the other player's, or
	// null when the slot was already taken. Read the follow-on state off the returned row rather
	// than off the row you read before calling, which is the half of this bug that made both
	// players think they were waiting on each other.
	//
	// A claim is a move, so it lands only while the room is still playing (STILL_IN_PLAY): a throw
	// picked after a forfeit finished the room claims nothing.
	async claimSecretField(guildId: string, roomId: string, path: string, value: unknown) {
		const field = `secret.${path}`;
		await GameRoom.updateOne({ guildId, roomId, secret: null }, { $set: { secret: {} } });
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, [field]: { $exists: false }, ...STILL_IN_PLAY },
			{ $set: { [field]: value } },
			{ new: true }
		);
	},

	// Write ONE field inside the `secret` blob, whether or not it already holds a value, while the
	// room is still playing (STILL_IN_PLAY).
	//
	// ⚠️ THE SIBLING OF claimSecretField, AND THE DIFFERENCE IS THE ONLY THING THAT MATTERS.
	// That one refuses to overwrite (`$exists: false`), which is what makes it a CLAIM. This one
	// always writes, for the slots a player REVISES rather than claims once: battleship's aim is
	// two selects that each fill half a coordinate, so the second must land on top of the first.
	//
	// Use it wherever a handler owns a slot NOBODY ELSE writes. The whole-blob write it replaces
	// (`update(..., { secret: { ...stored, mine } })`) persists a snapshot read before the
	// opponent's move, so it silently REVERTS their shot, the turn and their sunk-ship progress.
	// A dotted $set touches only its own subfield, so a concurrent write to another slot survives.
	//
	// Same two-write shape as claimSecretField and for the same reason: `secret` defaults to null
	// and Mongo will not create a dotted path inside a null. The seeding write is safe to race,
	// because `secret: null` stops matching the instant anybody's write lands.
	//
	// `path` is interpolated into the update, so it must never carry user text. Every caller today
	// passes a Discord snowflake or an array index, both digits only.
	async setSecretField(guildId: string, roomId: string, path: string, value: unknown) {
		return setSecretPathsIf(guildId, roomId, {}, { [path]: value });
	},

	// Write SEVERAL fields inside the `secret` blob in one write, only while the row still matches
	// `expected` (dotted paths, as updateSecretIf takes them) and the room is still playing. Null
	// when it lost. The conditional sibling of setSecretField, which is this with nothing expected.
	//
	// ⚠️ WHY DOTTED AND NOT THE WHOLE BLOB. A whole blob write carries every field the caller read,
	// so it puts back a field another writer moved since: hangman's guess carried a stale
	// `gallowsMessageId` back over the card the last guess posted, and the setup clock's start put a
	// captain's old fleet back over the one Randomize had just shown them. A dotted $set changes
	// only the fields that move, and `expected` is the version they were decided on (2026-10 item
	// 276, audit P1-6 and the Battleship setup P3).
	//
	// The `fields` keys are interpolated like `path` above, so they never carry user text.
	async setSecretFieldsIf(guildId: string, roomId: string, expected: Record<string, unknown>, fields: Record<string, unknown>) {
		return setSecretPathsIf(guildId, roomId, expected, fields);
	},

	// Add one member to a draft's joiner pool.
	//
	// ⚠️ $addToSet, NOT a read-modify-write. An open-to-all challenge is exactly the
	// situation where several members click Join in the same tick, and reading the
	// array then writing it back would silently drop everyone but the last writer.
	// $addToSet is atomic server-side and idempotent, so a double click is a no-op
	// rather than a duplicate entry.
	//
	// The pool lives on spectatorIds because that is what the pool BECOMES: at start
	// the host promotes one member into playerIds and everyone else is already in the
	// right field. See the challenge board for why one mechanism serves both
	// visibilities.
	//
	// ⚠️ THE kickedIds FILTER IS THE NO-REJOIN GUARANTEE, not a tidiness check. The
	// caller checks kickedIds on the row it read, but a kick can land between that read
	// and this write; matching `$ne` here means a removed member can never be written
	// back into the pool, and the null return is the caller's honest refusal. `$ne`
	// also matches a row written before kickedIds existed.
	async addPoolMember(guildId: string, roomId: string, userId: string) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, kickedIds: { $ne: userId } },
			{ $addToSet: { spectatorIds: userId } },
			{ new: true }
		);
	},

	// A person took a bot's seat on a casual draft (2026-10 item 254, Arcade 6): the bot
	// count drops to `ceiling` and never rises. $min rather than a decrement, so a double
	// click or two joins landing out of order cannot take two bots for one person, and the
	// draft and casual filters mean a started match's seats never swap. Null when the
	// write did not apply.
	async lowerBotSeats(guildId: string, roomId: string, ceiling: number) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, status: "draft", casual: true, botSeats: { $gt: ceiling } },
			{ $min: { botSeats: Math.max(0, ceiling) } },
			{ new: true }
		);
	},

	// ── the host controls (2026-10 item 244 Phase 4) ──
	// Each is one atomic write over the arrays it touches, for the reason addPoolMember
	// is: several members press Join in the same tick, and a read-modify-write would
	// drop all but the last. Each filters on kickedIds the same way, so a removed member
	// can never be written back in. A null return means the write did not apply.

	// A join the host must answer first.
	async addPendingJoin(guildId: string, roomId: string, userId: string) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] }, kickedIds: { $ne: userId } },
			{ $addToSet: { pendingJoinIds: userId } },
			{ new: true }
		);
	},

	// The host accepted one request: it leaves the waiting list and lands in `into`,
	// in ONE write, so a member is never in both or in neither. Matching on
	// pendingJoinIds makes a second accept of the same request a no-op.
	async admitPendingJoin(guildId: string, roomId: string, userId: string, into: AdmittedJoinField) {
		return GameRoom.findOneAndUpdate(
			{
				guildId,
				roomId,
				status: { $in: [...NON_TERMINAL_ROOM_STATUSES] },
				pendingJoinIds: userId,
				kickedIds: { $ne: userId },
			},
			// A remote member's origin server goes with the request: once answered it is
			// never read again (hostControls reads it off the row it loaded BEFORE this write).
			{ $pull: { pendingJoinIds: userId, pendingNetworkJoins: { userId } }, $addToSet: { [into]: userId } },
			{ new: true }
		);
	},

	// The host declined these requests. A declined member may ask again; a removed one may not.
	async declinePendingJoins(guildId: string, roomId: string, userIds: readonly string[]) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId },
			{ $pull: { pendingJoinIds: { $in: [...userIds] }, pendingNetworkJoins: { userId: { $in: [...userIds] } } } },
			{ new: true }
		);
	},

	// The host removed a member: out of every list that lets them in, and onto
	// kickedIds for good, in one write. The status filter keeps a finished room's
	// record as it ended, and the hostId filter means the host can never remove
	// themselves, whatever a forged select sends.
	async removeMember(guildId: string, roomId: string, userId: string) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] }, hostId: { $ne: userId } },
			{
				$pull: { playerIds: userId, spectatorIds: userId, pendingJoinIds: userId, pendingNetworkJoins: { userId } },
				$addToSet: { kickedIds: userId },
			},
			{ new: true }
		);
	},

	// The drafts this member waits in as a joiner, an invitee or a join request, never as host.
	// Backs the server leave watcher beside findOpenByPlayer, which cannot see them: a draft's
	// joiners sit in spectatorIds until Start seats them. Rides the { guildId, status } index, and a
	// guild holds a handful of drafts at most, so the per leave cost stays one small indexed read.
	async findDraftsByPoolMember(guildId: string, userId: string) {
		return GameRoom.find({ guildId, status: "draft", hostId: { $ne: userId }, $or: [{ spectatorIds: userId }, { pendingJoinIds: userId }] });
	},

	// A member left the server while waiting in a draft (2026-10 item 276, found in Phase 2): out of
	// every list of it, playerIds included for a draft already being built, in one write. Unlike
	// removeMember nothing goes on kickedIds, since leaving is not a removal and they may come back
	// and join again. Null when the row is no longer a draft.
	async leaveDraftPool(guildId: string, roomId: string, userId: string) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, status: "draft", hostId: { $ne: userId } },
			{ $pull: { playerIds: userId, spectatorIds: userId, pendingJoinIds: userId, pendingNetworkJoins: { userId } } },
			{ new: true }
		);
	},

	// ── satellites (2026-10 item 244 Phase 5a) ──
	// A network table's linked channels in other guilds. Every read names network: true,
	// which is what lets it use the partial satellite indexes on the model, and every
	// lookup by a remote guild matches that guild INSIDE the satellite entry: a satellite
	// press is scoped to the guild and channel it came from exactly as an ordinary press
	// is scoped to its guild, so a roomId replayed anywhere else still reads as not found.

	// The host row a press in a satellite channel belongs to, by the guild and channel
	// the press came from. Any status: the caller refuses by status as it would for the
	// host room, and the channel delete watcher needs a finished row to recognise that a
	// deleted channel was a satellite it should leave alone.
	async findBySatelliteChannel(guildId: string, channelId: string) {
		return GameRoom.findOne({ network: true, satellites: { $elemMatch: { guildId, channelId } } });
	},

	// Every live network room that seats this member through a satellite in this guild.
	// Backs the satellite half of the departure watchers, which run on EVERY member
	// leaving ANY guild, hence the partial index on satellites.userIds.
	async findOpenBySatellitePlayer(guildId: string, userId: string) {
		return GameRoom.find({
			network: true,
			status: { $in: [...NON_TERMINAL_ROOM_STATUSES] },
			satellites: { $elemMatch: { guildId, userIds: userId } },
		});
	},

	// Every live network room with a satellite in this guild. Only for a guild removing
	// the bot, which is rare enough that the status index narrowing to live rooms is
	// enough and no index of its own is spent on it.
	async findOpenBySatelliteGuild(guildId: string) {
		return GameRoom.find({ network: true, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] }, "satellites.guildId": guildId });
	},

	// Every live network room, across every guild, for the boot reconcile.
	async findOpenNetwork() {
		return GameRoom.find({ network: true, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } });
	},

	// ── network bans and blocks reaching seats already taken (2026-10 item 244 Phase 5c) ──
	// Every live network room that seats this member through a satellite in ANY guild, for
	// the owner's network ban. Served by the partial satellites.userIds index.
	async findOpenBySatelliteUser(userId: string) {
		return GameRoom.find({ network: true, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] }, "satellites.userIds": userId });
	},

	// Every live network room this guild hosts, for a server ban and a block. Served by the
	// { guildId, status } index; network: true only narrows what it returns.
	async findOpenNetworkHostedIn(guildId: string) {
		return GameRoom.find({ guildId, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] }, network: true });
	},

	// End one satellite, but only while it seats nobody. The $size match is the claim: a
	// member who sat down through it in the meantime makes this match nothing, so a seat out
	// that emptied the satellite can never take a newcomer's window away with it.
	async endEmptySatellite(guildId: string, roomId: string, satelliteGuildId: string) {
		return GameRoom.findOneAndUpdate(
			{
				guildId,
				roomId,
				status: { $in: [...NON_TERMINAL_ROOM_STATUSES] },
				satellites: { $elemMatch: { guildId: satelliteGuildId, userIds: { $size: 0 } } },
			},
			{ $pull: { satellites: { guildId: satelliteGuildId, userIds: { $size: 0 } } } },
			{ new: true }
		);
	},

	// ── the network board and remote requests (2026-10 item 244 Phase 5b) ──
	// Every network room whose match is under way, across every guild: the candidates
	// the network board lists (networkBoard decides which still take players). Served
	// by the { status, archiveAt } index's prefix, which "playing" keeps to live rooms.
	async findPlayingNetwork() {
		return GameRoom.find({ network: true, status: "playing" });
	},

	// A member of another server asks the host for a seat at a live network table: their
	// id joins the waiting list and the server they asked from is remembered beside it.
	// The old origin goes first, so a member who was declined and asks again from another
	// server is remembered by the server they asked from last. The second write filters
	// on kickedIds like addPendingJoin, so a removed member is never written back in.
	async addNetworkPendingJoin(guildId: string, roomId: string, userId: string, fromGuildId: string) {
		await GameRoom.updateOne({ guildId, roomId, network: true }, { $pull: { pendingNetworkJoins: { userId } } });
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, network: true, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] }, kickedIds: { $ne: userId } },
			{ $addToSet: { pendingJoinIds: userId }, $push: { pendingNetworkJoins: { userId, guildId: fromGuildId } } },
			{ new: true }
		);
	},

	// Add a satellite to a live network room.
	//
	// ⚠️ THE GUILD FILTER IS THE ONE SATELLITE PER GUILD CLAIM. Two members of the same
	// remote guild sitting down in the same tick would otherwise each push a satellite and
	// leave two channels mirroring one table there. The `$ne` makes the second push match
	// nothing, and its caller deletes the channel it built and joins the first one instead.
	async addSatellite(guildId: string, roomId: string, satellite: SatelliteRoom) {
		return GameRoom.findOneAndUpdate(
			{
				guildId,
				roomId,
				network: true,
				status: { $in: [...NON_TERMINAL_ROOM_STATUSES] },
				"satellites.guildId": { $ne: satellite.guildId },
			},
			{ $push: { satellites: satellite } },
			{ new: true }
		);
	},

	// Seat more members of a remote guild through its existing satellite. $addToSet for
	// the reason addPoolMember gives, and kickedIds for the no rejoin guarantee it gives.
	async addSatellitePlayers(guildId: string, roomId: string, satelliteGuildId: string, userIds: readonly string[]) {
		return GameRoom.findOneAndUpdate(
			{
				guildId,
				roomId,
				network: true,
				status: { $in: [...NON_TERMINAL_ROOM_STATUSES] },
				"satellites.guildId": satelliteGuildId,
				kickedIds: { $nin: [...userIds] },
			},
			{ $addToSet: { "satellites.$.userIds": { $each: [...userIds] } } },
			{ new: true }
		);
	},

	// Remember the mirrored table message a relay just posted in one satellite.
	async setSatelliteTableMessage(guildId: string, roomId: string, channelId: string, messageId: string) {
		return GameRoom.updateOne(
			{ guildId, roomId, "satellites.channelId": channelId },
			{ $set: { "satellites.$.tableMessageId": messageId } }
		);
	},

	// Seat members of one satellite out of a live room: they left their server, their
	// server removed the bot, or the satellite's channel was deleted.
	//
	// ONE write, the same lists removeMember clears and the same kickedIds it fills, so a
	// seat out is handled exactly the way a host's removal is: no door lets them back in,
	// no gate counts them a player, and a finish rates without them. `endSatellite` also
	// drops the satellite entry itself, for the two cases where the channel is out of
	// reach for good; otherwise only these members leave its list. The status filter keeps
	// a finished room's record as it ended. Returns null when there was nothing to change.
	async seatOutSatellitePlayers(
		guildId: string,
		roomId: string,
		satelliteGuildId: string,
		userIds: readonly string[],
		options: { endSatellite: boolean }
	) {
		const leaving = { $in: [...userIds] };
		const pull: Record<string, unknown> = { playerIds: leaving, spectatorIds: leaving, pendingJoinIds: leaving };
		if (options.endSatellite) pull.satellites = { guildId: satelliteGuildId };
		else pull["satellites.$[satellite].userIds"] = leaving;
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] }, "satellites.guildId": satelliteGuildId },
			{ $pull: pull, $addToSet: { kickedIds: { $each: [...userIds] } } },
			{ new: true, ...(options.endSatellite ? {} : { arrayFilters: [{ "satellite.guildId": satelliteGuildId }] }) }
		);
	},

	// Append one entry to the transcript.
	//
	// Called ONLY by roomTrail.postMove, and only AFTER its channel.send resolved. A transcript
	// row for a move the players never saw is unrecoverable; a missing row after a successful
	// send is merely a gap. $push is atomic server-side, so two members guessing in the same
	// tick both land without a read-modify-write race.
	async appendMove(guildId: string, roomId: string, move: RoomMove) {
		return GameRoom.findOneAndUpdate({ guildId, roomId }, { $push: { moves: move } }, { new: true });
	},

	// Advance the lifecycle, optionally alongside the ids that become known at the same moment
	// (channelId and openerMessageId when the room goes "playing", for instance). Callers pass
	// only what actually changed; this store decides nothing.
	async setStatus(guildId: string, roomId: string, status: RoomStatus, patch: Partial<IGameRoom> = {}) {
		return GameRoom.findOneAndUpdate({ guildId, roomId }, { $set: { status, ...patch } }, { new: true });
	},

	// The one move of a room into "playing", called only by RoomProvisioner.seedRoom.
	//
	// ⚠️ THE STATUS FILTER IS THE START CLAIM (2026-10 item 276, audit P1-2). Provisioning takes
	// seconds after the countdown read "draft", and Call it off, the idle sweep or the leave
	// watcher can close the draft in that window; an unconditional write here revived the closed
	// row as playing with its joiners seated. Only a row still waiting to start matches, so the
	// loser of the race gets null and opens nothing.
	//
	// The buy in ledger is EMPTIED IN THE SAME WRITE and the row BEFORE it is returned (P2-13):
	// the payers it held are the seats the table opens with, so a removal refunded a moment
	// before this write is not on it and is never seated, and none refunded after it can claim
	// an entry, because the entry is gone. Null when the claim was lost.
	//
	// ⚠️ A CHIP MATCH'S BUY INS MOVE TO THE GAME'S OWN LEDGER IN THIS SAME WRITE (2026-10 item 276,
	// audit P3, for Blackjack; item 278, gaps G1 and G2, for the rest). The ledger it empties held
	// every buy in, and each game used to write its own ledger seconds later, after Discord calls; a
	// crash in between had emptied one ledger and never written the other, so those chips were lost.
	// `startLedger` names where they go (see StartLedger). An update pipeline, since only a pipeline
	// can read the ledger in the write; every value from the caller goes in as a literal so no id
	// can be read as a field path.
	async claimForPlay(guildId: string, roomId: string, patch: Partial<IGameRoom>, startLedger?: StartLedger) {
		const filter = { guildId, roomId, status: { $in: [...ROOMS_AWAITING_PLAY] } };
		if (!startLedger) return GameRoom.findOneAndUpdate(filter, { $set: { status: "playing", ...patch, buyInPaidBy: [] } }, { new: false });
		const literals = Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, { $literal: value }]));
		return GameRoom.findOneAndUpdate(filter, [{ $set: { ...literals, status: "playing", ...startLedgerFields(startLedger), buyInPaidBy: [] } }], { new: false });
	},

	// Terminal write for a match that ended.
	//
	// archiveAt is computed by roomLifecycle.finish and passed in, never derived here: the store
	// stays thin, and keeping the arithmetic in one feature module is what guarantees archiveAt
	// is stamped by exactly one code path (releaseChannel below only ever clears it). That
	// single-writer property is what makes the sweep safe, because a room that is still playing
	// has archiveAt null and no filter bug can reach it.
	//
	// ⚠️ THE STATUS FILTER IS A CLAIM, NOT A TIDINESS CHECK, and it is the ONE write that makes
	// finishing idempotent. findOneAndUpdate is atomic, so the first caller to match a
	// non-terminal room takes the transition and every later caller gets null back. Without it
	// four reachable paths could each re-finish the same room: the still-clickable Forfeit
	// button on a finished room (the status refusal in gameRoomHandlers covers only BOARD_ACTIONS,
	// and a SendMessages deny does not block a component interaction), the channel-delete watcher
	// (findByChannelId has no status filter and channelId survives until markArchived), a double
	// press in versus, and the hold em clock. Each replay re-ran payRoomRateTopUp, which carries
	// no idempotency key, so the winner could pay everyone again, overwrite winnerId with the
	// loser, and push archiveAt out another four hours, repeatedly. One conditional write here
	// beats four call-site guards, because this is the shared infrastructure all four go through.
	async finish(
		guildId: string,
		roomId: string,
		outcome: { winnerId: string | null; endedAt: Date; archiveAt: Date }
	) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } },
			{
				$set: {
					status: "finished",
					winnerId: outcome.winnerId,
					endedAt: outcome.endedAt,
					archiveAt: outcome.archiveAt,
				},
			},
			{ new: true }
		);
	},

	// A finished room hands its channel to the rematch that now plays in it: the row keeps its
	// transcript and stops pointing at the channel, and its archive clock is cleared so the
	// sweep never deletes a channel a live match is using. Called only by
	// roomLifecycle.releaseChannel, which is why the null write here does not break the
	// single-writer rule on archiveAt above.
	//
	// ⚠️ THE FILTER IS THE ONE-REMATCH CLAIM. Matching on status "finished" AND the channel
	// the caller expects means exactly one rematch can take the channel: a second presser, or
	// a sweep that archived the room a moment earlier, gets null back and must undo its own
	// row. Returns the released row, or null when the claim was lost.
	async releaseChannel(guildId: string, roomId: string, channelId: string) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId, status: "finished", channelId },
			{ $set: { channelId: null, archiveAt: null } },
			{ new: true }
		);
	},

	// The archive sweep's query. Cross-guild by nature: one cron tick serves every guild, so this
	// is the one method that does not scope to a guildId.
	//
	// The status filter is what protects a live game (risk R3). `archiveAt: { $ne: null }` is
	// redundant against MongoDB's type bracketing, which already keeps a null out of a $lte Date
	// comparison, but it states the invariant in the query itself so a future edit cannot quietly
	// widen this into "every room with a past timestamp".
	async findExpiredArchives(now: Date) {
		return GameRoom.find({ status: "finished", archiveAt: { $ne: null, $lte: now } });
	},

	// Every room that believes it is still live, across every guild.
	//
	// Cross-guild for the same reason findExpiredArchives is: the boot recovery sweep runs
	// once for the whole process, not once per guild. It reads rooms whose status is
	// non-terminal so the caller can ask Discord whether each one's channel still exists;
	// a row that says "playing" is a CLAIM about the world, and a bot that was offline
	// while an admin deleted the channel comes back holding a claim that is no longer true.
	async findNonTerminal() {
		return GameRoom.find({ status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } });
	},

	// Every live match of one game, across every guild. Backs the battleship turn
	// clock, which is per GAME rather than per room: no other game here has a turn
	// that can be abandoned mid-match, because every other one resolves in a single
	// press or ends when its word is guessed.
	//
	// Cross-guild for the same reason the archive sweep is: one cron tick serves the
	// whole process. `status: "playing"` rather than the non-terminal set on purpose,
	// since a draft has no match to time.
	async findPlayingByGame(game: GameSlug) {
		return GameRoom.find({ game, status: "playing" });
	},

	// The bot driver's tick (2026-10 item 250 Phase 5): every playing room with a Dero bot
	// seat. Rides the status index; the bot rooms are a handful at any moment.
	async findPlayingWithBots() {
		return GameRoom.find({ status: "playing", botSeats: { $gt: 0 } });
	},

	// Called after the channel is gone, by both the sweep and the Archive now button, which
	// share one delete path. A channel that was already deleted by an admin reaches this the
	// same way a swept one does: it is a success, not an error.
	async markArchived(guildId: string, roomId: string) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId },
			{ $set: { status: "archived", channelId: null } },
			{ new: true }
		);
	},

	// Close a challenge that never started: Call it off, or a draft replaced by a new one.
	// ⚠️ THE "draft" FILTER IS THE CANCEL CLAIM (2026-10 item 276, audit P1-2), the other half
	// of claimForPlay: whichever lands first wins, so a cancel that lost to the start writes
	// nothing and refunds nothing, and a start that lost to the cancel opens nothing. Null when
	// the draft had already started or closed.
	async archiveDraft(guildId: string, roomId: string) {
		return GameRoom.findOneAndUpdate({ guildId, roomId, status: "draft" }, { $set: { status: "archived", channelId: null } }, { new: true });
	},

	// Mark a Hold'em table finished inside its row, when the room finished from outside the table
	// (the idle sweep, the leave watcher, a deleted channel, boot recovery). Only a table still
	// joining or playing matches, so a table that ended itself is left as it ended (audit P1-1).
	async closeHoldemTable(guildId: string, roomId: string) {
		return GameRoom.updateOne(
			{ guildId, roomId, game: "holdem", "secret.status": { $in: ["joining", "playing"] } },
			{ $set: { "secret.status": "finished", "secret.betting": null } }
		);
	},

	// A member's match history (/account view:saved, 2026-10 item 263 decision 2): the finished or
	// archived rooms they played in this guild, newest finish first. Matches the { guildId,
	// playerIds, endedAt } index. Spectators are deliberately excluded, watching a match is not
	// playing one, and a Dero bot seat never lives in playerIds. endedAt is still required so a
	// hand written row never lists without a date.
	async findByUserInGuild(guildId: string, userId: string, limit: number) {
		return GameRoom.find({ guildId, playerIds: userId, status: { $in: ["finished", "archived"] }, endedAt: { $ne: null } })
			.sort({ endedAt: -1 })
			.limit(limit)
			.lean();
	},

	// The owner's Verse view: matches completed across every server, by game. Finished and
	// archived rows with an endedAt (finish stamps it), so a draft that was cancelled never
	// counts. Rides the { status, archiveAt } index on its status prefix, and the group
	// returns one row per game, never the rooms themselves.
	async countCompletedByGame(): Promise<{ game: string; count: number }[]> {
		return GameRoom.aggregate<{ game: string; count: number }>([
			{ $match: { status: { $in: ["finished", "archived"] }, endedAt: { $ne: null } } },
			{ $group: { _id: "$game", count: { $sum: 1 } } },
			{ $project: { _id: 0, game: "$_id", count: 1 } },
		]);
	},

	// Self destruct's server data delete (post-launch plan item 10): every row this guild owns.
	async deleteGuild(guildId: string) {
		return GameRoom.deleteMany({ guildId });
	},
};
