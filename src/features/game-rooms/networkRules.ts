import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
	type ColorResolvable,
	type EmbedBuilder,
} from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import type { INetworkBan } from "@db/models/NetworkBan.js";
import type { ChannelAnswer } from "@utils/answerInChannel.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { asChallengeReach } from "./challengeReach.js";

// ── networkRules ─────────────────────────────────────────────────────
// What:  the network's few shared rules (2026-10 item 244 Phase 5b), in one place so no
//        door, board or ranking applies them its own way: which server is on the
//        network, which servers keep each other off, which ban a request runs into,
//        and the one time network notice a member is shown. Who has consented is
//        networkConsent's, kept apart because it knows no discord.js.
// Who:   the network board and the remote join (networkBoard, networkJoin), the host's
//        network choice and the local doors of a network room (challengeBoard, the
//        Hold'em Buy in, joinGate), the server ratings and the tag notice.
// Does NOT: write anything but the notice's buttons, or decide what a refusal says to a
//        member (each caller picks its words from the pack's arcadeNetwork).
//
// ⚠️ "ON THE NETWORK" IS TWO FACTS, AND BOTH ARE CHECKED EVERY TIME: Dero is in the
// server, and the server's challenge reach is network (the plan's assumption). A config
// row alone is not enough: a server that removed Dero keeps its row and its reach.

const words = rokCommanderCopy.arcadeNetwork;

// The customId prefix of the notice's two buttons. Registered by networkJoin.
export const NETWORK_CONSENT_PREFIX = "networkConsent";

/** The slice of a GuildConfig row the network reads. */
export interface NetworkGuildConfig {
	guildId: string;
	challengeReach?: unknown;
	blockedNetworkGuildIds?: readonly string[] | null;
}

// ── servers on the network ────────────────────────────────────────────
/** Whether a server is on the network: Dero is in it, and its reach is network. */
export function isOnNetwork(client: Client, config: NetworkGuildConfig | null | undefined): boolean {
	if (!config) return false;
	return client.guilds.cache.has(config.guildId) && asChallengeReach(config.challengeReach) === "network";
}

/** Read a server's config and say whether it is on the network, with the config for the caller's next check. */
export async function readNetworkGuild(client: Client, guildId: string): Promise<{ onNetwork: boolean; config: NetworkGuildConfig | null }> {
	const config = (await guildConfigStore.findByGuildId(guildId)) as NetworkGuildConfig | null;
	return { onNetwork: isOnNetwork(client, config), config };
}

/** True when either server keeps the other off the network. A block reaches both ways by design. */
export function blocksEachOther(first: NetworkGuildConfig | null | undefined, second: NetworkGuildConfig | null | undefined): boolean {
	if (!first || !second) return false;
	return (first.blockedNetworkGuildIds ?? []).includes(second.guildId) || (second.blockedNetworkGuildIds ?? []).includes(first.guildId);
}

// ── bans ──────────────────────────────────────────────────────────────
/** True when one of these bans names this member. */
export function isUserBanned(bans: readonly Pick<INetworkBan, "kind" | "targetId">[], userId: string): boolean {
	return bans.some((ban) => ban.kind === "user" && ban.targetId === userId);
}

/** True when one of these bans names this server. */
export function isGuildBanned(bans: readonly Pick<INetworkBan, "kind" | "targetId">[], guildId: string): boolean {
	return bans.some((ban) => ban.kind === "guild" && ban.targetId === guildId);
}

// ── the network notice ────────────────────────────────────────────────
/**
 * What accepting the notice does next. "again": nothing more, the member presses what
 * they pressed again (a door in their own server, or the host's network choice).
 * "join": the network board's request for a seat carries on by itself, since the
 * board's select cannot be pressed "again" without picking the table a second time.
 */
export type ConsentNext = { kind: "again" } | { kind: "join"; hostGuildId: string; roomId: string };

/** The accept button's customId for a continuation. Under Discord's 100 characters: a uuid roomId and a snowflake fit twice over. */
export function consentAcceptId(next: ConsentNext): string {
	return next.kind === "join" ? `${NETWORK_CONSENT_PREFIX}:yes:join:${next.hostGuildId}:${next.roomId}` : `${NETWORK_CONSENT_PREFIX}:yes:again`;
}

/** Parse a notice button's customId without trusting it. Null for anything malformed. */
export function parseConsentId(customId: string): { accepted: false } | { accepted: true; next: ConsentNext } | null {
	const [prefix, answer, kind, hostGuildId, roomId] = customId.split(":");
	if (prefix !== NETWORK_CONSENT_PREFIX) return null;
	if (answer === "no") return { accepted: false };
	if (answer !== "yes") return null;
	if (kind === "again") return { accepted: true, next: { kind: "again" } };
	if (kind === "join" && hostGuildId && roomId) return { accepted: true, next: { kind: "join", hostGuildId, roomId } };
	return null;
}

/** The notice's embed, the same at every door. */
export function consentEmbed(): EmbedBuilder {
	return infoEmbed(words.consent.title, words.consent.body, COLORS.ARCADE as ColorResolvable);
}

/**
 * The answer that shows the network notice with I agree and Not now, posted through
 * answerInChannel in 💬dero-commands (2026-10 item 257 Phase 5). Every door that meets a
 * member without consent answers with this, so the notice reads the same wherever a member
 * first meets the network. Either button speaks only for its presser: I agree records the
 * presser's own consent, so a member who presses another's prompt consents for themselves.
 */
export function consentPrompt(next: ConsentNext): ChannelAnswer {
	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(consentAcceptId(next)).setLabel(words.consent.acceptLabel).setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`${NETWORK_CONSENT_PREFIX}:no`).setLabel(words.consent.declineLabel).setStyle(ButtonStyle.Secondary)
	);
	return { embeds: [consentEmbed()], components: [row] };
}
