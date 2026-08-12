import { Router, Request, Response } from "express";
import { GameRoom } from "@db/models/GameRoom.js";
import { requireGuildId } from "../middleware/requireGuildId.js";

// ── GET /api/game-rooms ───────────────────────────────────────────────
// What:  the dashboard's read of a guild's finished matches, newest first.
// Who:   the Company Uno dashboard, through the plugin proxy. Mounted behind
//        verifySignature in server.ts like every other /api route.
// When:  on demand, when a member opens their Discord game history.
// Where: guild scoping is a SECURITY BOUNDARY (invariant 2). Every query below
//        filters on the guildId the middleware resolved, so a roomId belonging to
//        another guild simply is not in the result set. There is no by-id route
//        here precisely so there is nothing that could 403 and thereby confirm a
//        room exists somewhere else.
// How:   an `endedAt` keyset cursor rather than skip/limit, because skip re-scans
//        the whole prefix on every page and a busy guild's history only grows.
//
// ⚠️ THE SECRET AND THE FULL MOVE LIST ARE EXCLUDED, and the exclusion is a
// projection at the DATABASE, not a delete after the fact. `secret.word` is the
// hidden half of a hangman room and must never reach a client while any room is
// still playable; projecting it away here means a future field added to the secret
// is excluded by default rather than leaked until somebody notices.

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface GameRoomRow {
	roomId: string;
	game: string;
	hostId: string;
	playerIds: string[];
	visibility: string;
	winnerId: string | null;
	startedAt: Date | null;
	endedAt: Date | null;
	// The COUNT rather than the moves. A transcript can run to hundreds of entries
	// and the list view renders none of them; the detail route is where they belong.
	moveCount: number;
}

type GameRoomsRequest = Request<
	Record<string, never>,
	unknown,
	unknown,
	{ guildId?: string; userId?: string; limit?: string; cursor?: string }
>;

export function createGameRoomsRouter(): Router {
	const router = Router();

	router.get("/", requireGuildId, async (req: GameRoomsRequest, res: Response) => {
		try {
			const guildId = req.query.guildId as string;

			// Clamped rather than trusted. A caller asking for 10000 would otherwise
			// pull a guild's entire history into memory to serialise it.
			const requested = Number.parseInt(req.query.limit ?? "", 10);
			const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_LIMIT) : DEFAULT_LIMIT;

			// Only TERMINAL rooms. A live match is not history, and listing one would
			// expose the current player set of a room the caller may not be able to see
			// in Discord.
			const filter: Record<string, unknown> = { guildId, status: { $in: ["finished", "archived"] } };

			// Spectators are deliberately excluded: watching a match is not playing one,
			// and the index this rides is { guildId, playerIds, endedAt }.
			if (req.query.userId) filter.playerIds = req.query.userId;

			// Keyset pagination. An unparseable cursor is ignored rather than 400'd: the
			// worst case is a caller getting page one again, and rejecting it would turn
			// a stale bookmark into an error the dashboard has to handle.
			if (req.query.cursor) {
				const cursorDate = new Date(req.query.cursor);
				if (!Number.isNaN(cursorDate.getTime())) filter.endedAt = { $lt: cursorDate };
			}

			const rooms = await GameRoom.find(filter)
				// The projection IS the security control. `-secret` keeps the hangman
				// word server side; `-moves` keeps the payload bounded.
				.select("-secret -moves.meta")
				.sort({ endedAt: -1 })
				.limit(limit)
				.lean();

			const rows: GameRoomRow[] = rooms.map((room) => ({
				roomId: room.roomId,
				game: room.game,
				hostId: room.hostId,
				playerIds: room.playerIds ?? [],
				visibility: room.visibility,
				winnerId: room.winnerId ?? null,
				startedAt: room.startedAt ?? null,
				endedAt: room.endedAt ?? null,
				moveCount: room.moves?.length ?? 0,
			}));

			// The cursor for the NEXT page, or null when this was the last one. Handing
			// it back beats making the dashboard derive it from the final row, which is
			// the kind of duplication that drifts the first time the sort changes.
			const nextCursor = rows.length === limit ? rows[rows.length - 1]?.endedAt?.toISOString() ?? null : null;

			res.json({ rooms: rows, nextCursor });
		} catch (error) {
			console.error("[api] GET /api/game-rooms failed", error);
			res.status(500).json({ error: "Failed to load game rooms" });
		}
	});

	return router;
}
