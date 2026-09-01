import { ChannelType, type CategoryChannel, type Guild } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { checkGameRoomAccess } from "@features/entitlements/gameRoomAccess.js";
import { startBlackjackTable } from "@features/games/blackjackHandler.js";
import { RoomProvisioner, describeRoomOpenFailure, type RoomOpenResult } from "./RoomProvisioner.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── soloRooms ────────────────────────────────────────────────────────
// What:  the one-player path into a room: "Host Hangman" and "Play Blackjack" on the
//        arcade rules card, and a rematch pressed on a finished solo room.
// Who:   arcadeHost (the buttons) and challengeBoard.rematchFromRoom.
// When:  once per press, same cadence as the challenge board's start.
// Where: routes through RoomProvisioner like every other room, ON PURPOSE. The old
//        inline forms never touched the provisioner, so they held no room slot, dodged
//        the guild cap, and would have dodged the private tier quota the day it
//        shipped. A solo room is visibility "solo" (a variant of "invite"), so it
//        counts as PRIVATE everywhere private is counted.
// How:   resolve the arcade category from GuildConfig exactly the way
//        provisionFromDraft does, open the room, then hand solo-blackjack its board.

export type SoloGameSlug = "solo-hangman" | "solo-blackjack";

export interface SoloHost {
	userId: string;
	displayName: string;
}

export type SoloOpenResult = RoomOpenResult | { ok: false; reason: "noArcadeCategory" };

export async function openSoloRoom(
	guild: Guild,
	game: SoloGameSlug,
	host: SoloHost,
	// Set by the rematch path so the new room and the idempotency marker are one write.
	rematchedFromRoomId: string | null = null
): Promise<SoloOpenResult> {
	const stored = await guildConfigStore.findByGuildId(guild.id);
	const config = stored as unknown as { gamesCategoryId?: string | null; adminRoleId?: string | null } | null;

	const categoryId = config?.gamesCategoryId;
	const category = categoryId ? await guild.channels.fetch(categoryId).catch(() => null) : null;
	if (!category || category.type !== ChannelType.GuildCategory) {
		return { ok: false, reason: "noArcadeCategory" };
	}

	const result = await RoomProvisioner.open({
		guild,
		category: category as CategoryChannel,
		game,
		hostId: host.userId,
		hostDisplayName: host.displayName,
		playerIds: [host.userId],
		spectatorIds: [],
		visibility: "solo",
		adminRoleId: config?.adminRoleId ?? null,
		rematchedFromRoomId,
	});
	if (!result.ok) return result;

	// Solo blackjack rides its own edited board message, posted into the room the way
	// the inline form posted into ⚔️challenges. The roomId rides the in-memory game so
	// the settle path can close the room through roomLifecycle.finish.
	if (game === "solo-blackjack") {
		const started = await startBlackjackTable(
			result.channel,
			guild.id,
			{ userId: host.userId, username: host.displayName },
			true,
			result.room.roomId
		);
		if (started !== "started") {
			// The room exists and its board does not, so the host would hold their one
			// room slot on a channel with nothing to play. Close it out rather than
			// stranding them; abandoned, because no hand was ever dealt.
			await roomLifecycle.finish(guild.client, result.room, { abandoned: true });
			return { ok: false, reason: "createFailed" };
		}
	}

	return result;
}

// The solo counterpart of describeRoomOpenFailure, covering the one extra reason this
// path can fail that the provisioner cannot know about.
export function describeSoloOpenFailure(result: Exclude<SoloOpenResult, { ok: true }>): string {
	if (result.reason === "noArcadeCategory") return gameRoomsCopy.errors.noArcadeCategory;
	return describeRoomOpenFailure(result);
}

// The "6/10 private rooms on the Starter plan" status line, or null while the tier
// surface is not enforcing (infinite quota) or the member is blocked outright. Shared
// by the visibility chooser and the solo entry points so the count, the ceiling and
// the plan name always come from the same cached decision.
export async function readPrivateQuotaStatus(guildId: string, userId: string): Promise<string | null> {
	const decision = await checkGameRoomAccess(guildId, userId);
	if (!decision.allowed || !Number.isFinite(decision.privateQuota)) return null;
	const open = await gameRoomStore.countOpenInGuildByVisibility(guildId, ["invite", "solo"]);
	return gameRoomsCopy.board.privateQuotaStatus(
		open,
		decision.privateQuota,
		gameRoomsCopy.tierName(decision.tierKey ?? "unsubscribed")
	);
}
