// src/db/models/NetworkBan.ts
import mongoose from "mongoose";

// ── NetworkBan ──
// The platform owner's network bans (2026-10 item 244 Phase 5b): a member, or a whole
// server, kept off every network table. Written only by the owner's /platform network command
// through networkBanStore; read by the network board (a banned host or server is not
// listed) and by every remote join (a banned member, the server they click from, or
// the hosting server refuses the seat). A ban placed while its target already sits at a
// network table seats them out at once (satelliteSeats, Phase 5c), so a ban never waits
// for a table to end.
//
// A ban reaches the network only. A banned member still plays every room inside their
// own server, and a banned server keeps its own arcade; an admin's per server block
// list (GuildConfig.blockedNetworkGuildIds) is the narrower tool beside this one.

export const NETWORK_BAN_KINDS = ["user", "guild"] as const;
export type NetworkBanKind = (typeof NETWORK_BAN_KINDS)[number];

export interface INetworkBan {
	kind: NetworkBanKind;
	// A Discord user id for "user", a guild id for "guild".
	targetId: string;
	// The owner's note, shown back only to the owner. Empty when none was given.
	reason: string;
	createdAt: Date;
}

const networkBanSchema = new mongoose.Schema<INetworkBan>({
	kind: { type: String, enum: [...NETWORK_BAN_KINDS], required: true },
	targetId: { type: String, required: true },
	reason: { type: String, default: "" },
	createdAt: { type: Date, required: true },
});

// ⚠️ REQUIRED. Banning is an upsert, so banning the same member twice stays one row and
// unbanning deletes that one row; it also serves every "is this id banned" read.
networkBanSchema.index({ kind: 1, targetId: 1 }, { unique: true });

export const NetworkBan = mongoose.model<INetworkBan>("NetworkBan", networkBanSchema);
