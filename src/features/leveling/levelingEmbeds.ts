import { EmbedBuilder, type APIEmbedField, type HexColorString } from "discord.js";
import { AUTHOR, COLORS, FOOTER } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { AvatarRequest } from "@features/renderer/index.js";
import { levelingCopy } from "./levelingCopy.js";
import type { IAchievementUnlock, IGameRecord } from "./levelingTypes.js";

// ── leveling embeds ────────────────────────────────────────────────────────
// Self-contained embed builders. They do NOT reuse embedBuilder.base() on
// purpose: base() resolves branding through getPluginCopy(guildConfig), which
// couples a caller to the pluginId copy-pack system. Leveling is a plain bot
// feature (not a platform plugin), so it pulls the Dero author and colors
// straight from brand.ts, the same "non pack-aware call site" path brand.ts
// documents and that gamesEmbeds.ts and fortuneEmbed.ts already take.
//
// Every builder here takes a VIEW MODEL rather than a Mongoose document. That
// keeps them pure and renderable in a test without a database, and it is what
// stops embed code from quietly growing a store import.
//
// The same view models feed the canvas cards of 2026-10 item 243 Phase 2
// (accountRenderer and its three siblings). The card only fields (an avatar
// request, a display name) are optional, so these builders never read them and
// every fallback embed renders exactly as it did before the cards existed.

// Every embed in this feature carries the same Dero author and footer, so the
// shared spine lives in one place and a new builder cannot forget it.
function base(): EmbedBuilder {
	return new EmbedBuilder().setTimestamp().setAuthor({ name: AUTHOR.name, iconURL: AUTHOR.iconURL }).setFooter({ text: FOOTER });
}

// ── the progress bar ────────────────────────────────────────────────────────
// One helper, used by /account and by /account view:achievements, so a member never sees two
// differently shaped bars for the same idea (rule 17: one helper per concept).
//
// Unicode blocks rather than a custom emoji: a bar is rendered inside an embed
// description alongside other text, and custom emoji serialize to roughly 25
// characters each, so a ten segment custom bar would spend 250 characters to say
// what 10 characters say here.
const BAR_SEGMENTS = 10;

export function progressBar(current: number, total: number, segments = BAR_SEGMENTS): string {
	// A zero or negative span means "nothing left to fill", which is the capped
	// member's case, and a full bar is the honest rendering of it.
	if (!Number.isFinite(total) || total <= 0) return "▰".repeat(segments);
	const fraction = Math.min(1, Math.max(0, current / total));
	const filled = Math.round(fraction * segments);
	return `${"▰".repeat(filled)}${"▱".repeat(segments - filled)}`;
}

// ── the level up card ───────────────────────────────────────────────────────
// The embed under every announced level up's card, and its text fallback when the
// card cannot be drawn. A milestone wears the gold treatment and its footer; an
// ordinary level wears the calm teal. A burst past the threshold skips this and
// posts the combined message below instead.
export interface LevelUpView {
	// Already rendered by the announcer's template pass, so this builder never
	// touches copyOverrides and stays free of a guild config dependency.
	description: string;
	level: number;
	milestone: boolean;
	// attachment:// reference for the bundled Dero art or the rendered card, or
	// null to render flat.
	imageRef?: string | null;
	// Card only. The name and face the level up card draws; a mention cannot be
	// drawn, so the card cannot use the description.
	displayName?: string | null;
	avatar?: AvatarRequest | null;
}

export function buildLevelUpEmbed(view: LevelUpView): EmbedBuilder {
	const embed = base()
		.setTitle(view.milestone ? levelingCopy.levelUp.milestoneTitle : levelingCopy.levelUp.ordinaryTitle)
		.setColor(view.milestone ? COLORS.LEVEL_MILESTONE : COLORS.LEVEL_UP)
		.setDescription(view.description);

	// The mechanic is invisible otherwise: nobody deduces "the loud ones are
	// prime numbers" from a single celebration, so the milestone card says it.
	if (view.milestone) embed.setFooter({ text: `${FOOTER} • ${levelingCopy.levelUp.milestoneFooter}` });
	if (view.imageRef) embed.setImage(view.imageRef);

	return embed;
}

// ── the combined burst message ──────────────────────────────────────────────
// Sent INSTEAD of N separate messages once a burst passes the threshold. This
// solves the unreadable channel complaint and Discord's per channel 429 risk
// with one mechanism.
export interface CombinedLevelUp {
	userId: string;
	level: number;
	milestone: boolean;
}

export function buildCombinedLevelUpEmbed(entries: CombinedLevelUp[]): EmbedBuilder {
	const anyMilestone = entries.some((entry) => entry.milestone);
	return base()
		.setTitle(levelingCopy.levelUp.combinedTitle)
		// A burst containing even one milestone takes the milestone color, so a
		// rare level is never demoted just because it arrived in a busy minute.
		.setColor(anyMilestone ? COLORS.LEVEL_MILESTONE : COLORS.LEVEL_UP)
		.setDescription(
			[
				levelingCopy.levelUp.combinedIntro(entries.length),
				"",
				...entries.map((entry) => levelingCopy.levelUp.combinedLine(entry.userId, entry.level, entry.milestone)),
			].join("\n")
		);
}

// ── /account, the member profile ────────────────────────────────────────────
// Absorbs what would otherwise be a /rank command. One profile surface, not two,
// following the owner's standing rule that too many slash commands is itself a
// usability problem.
export interface AccountView {
	displayName: string;
	avatarUrl: string | null;
	level: number;
	totalXp: number;
	xpIntoLevel: number;
	xpToNext: number;
	nextLevelIsMilestone: boolean;
	guildRank: number;
	guildSize: number;
	weekRank: number | null;
	monthRank: number | null;
	messages: number;
	reactionsGiven: number;
	voiceMinutes: number;
	// Slug plus record, already ordered by the caller. Games the member has never
	// played are omitted rather than rendered as a row of zeros.
	games: Array<{ slug: string; record: IGameRecord }>;
	// This UTC month's coin flip, dice and rps luck, the luck board's numbers, or
	// null when the member decided none (post-launch plan item 7).
	luck: AccountLuck | null;
	// The member's chips in this server (2026-10 item 250 Phase 5), "off" when the server
	// has chips switched off, which the currencies say (2026-10 item 257 Phase 3a), or null
	// when the read failed, which leaves the line out.
	chips: AccountChips | "off" | null;
	// The member's Dero coins, global across servers (2026-10 item 257 Phase 3a), or null
	// when the read failed.
	coins: number | null;
	// The secret code luck boost, in percentage points of gold reading chance above the
	// base, or null when the member holds none.
	luckBoost: number | null;
	unlocked: IAchievementUnlock[];
	// Card only: the avatar the account card draws. The embed keeps avatarUrl.
	avatar?: AvatarRequest | null;
}

/** A member's luck for the month: decided luck games, wins, magic 8 ball readings, and the board's score (null below its minimum). */
export interface AccountLuck {
	decided: number;
	wins: number;
	readings?: number;
	score: number | null;
}

/** A member's chips: the balance, and, on their own profile only, when they may claim next (null nextClaimAt: never claimed). */
export interface AccountChips {
	balance: number;
	claim: { nextClaimAt: Date | null; now: Date } | null;
}

// The per game record with its W/L ratio, shared by the text profile and the card's
// embed (post-launch plan item 7), since a card at embed width cannot hold the
// table legibly. A code block so the columns line up in both light and dark mode
// and on mobile, where a markdown table does not exist and spaces inside normal
// text collapse.
function recordField(view: Pick<AccountView, "games">): APIEmbedField {
	const c = levelingCopy.labels;
	if (view.games.length === 0) return { name: c.record, value: c.noRecordYet, inline: false };
	const rows = view.games.map((entry) => {
		const r = entry.record;
		return `${entry.slug.padEnd(11)}${String(r.played).padStart(4)}${String(r.won).padStart(5)}${String(r.lost).padStart(5)}${String(r.drawn).padStart(6)}${String(r.assists).padStart(8)}   ${ratio(r.won, r.lost)}`;
	});
	const totals = view.games.reduce(
		(sum, entry) => ({
			played: sum.played + entry.record.played,
			won: sum.won + entry.record.won,
			lost: sum.lost + entry.record.lost,
			drawn: sum.drawn + entry.record.drawn,
			assists: sum.assists + entry.record.assists,
		}),
		{ played: 0, won: 0, lost: 0, drawn: 0, assists: 0 }
	);
	const header = `${"".padEnd(11)}${c.played.slice(0, 4).padStart(4)}${c.won.padStart(5)}${c.lost.padStart(5)}${c.drawn.padStart(6)}${c.assists.padStart(8)}   ${c.ratio}`;
	const overall = `${c.overall.padEnd(11)}${String(totals.played).padStart(4)}${String(totals.won).padStart(5)}${String(totals.lost).padStart(5)}${String(totals.drawn).padStart(6)}${String(totals.assists).padStart(8)}   ${ratio(totals.won, totals.lost)}`;
	return { name: c.record, value: ["```", header, ...rows, overall, "```"].join("\n"), inline: false };
}

// The month's luck line, the luck board's own numbers (post-launch plan item 7).
// The secret code boost is its own line under the game luck (2026-10 item 257 Phase 3a),
// so a member can tell the luck they rolled from the luck a code gave them.
function luckField(view: Pick<AccountView, "luck" | "luckBoost">): APIEmbedField {
	const c = levelingCopy.labels;
	const games = view.luck ? c.luckLine(view.luck, BOT_CONSTANTS.RATINGS.LUCK_MIN_DECIDED) : c.noLuckYet;
	const value = view.luckBoost === null ? games : `${games}\n${c.luckBoostLine(view.luckBoost)}`;
	return { name: c.luck, value, inline: false };
}

// The currencies (2026-10 item 257 Phase 3a): Hold'em chips in this server, or "off"
// where the server switched them off, and the global Dero coins. A read that failed
// leaves its own line out, and both failing leaves the field out.
function currenciesFields(view: Pick<AccountView, "chips" | "coins">): APIEmbedField[] {
	const c = levelingCopy.labels;
	const lines: string[] = [];
	if (view.chips === "off") lines.push(`${c.holdemChips}: ${c.chipsOff}`);
	else if (view.chips) lines.push(`${c.holdemChips}: ${c.chipsLine(view.chips.balance, view.chips.claim)}`);
	if (view.coins !== null) lines.push(`${c.deroCoins}: ${c.coinsLine(view.coins)}`);
	return lines.length === 0 ? [] : [{ name: c.currencies, value: lines.join("\n"), inline: false }];
}

/** A win/loss ratio as the text profile and the account card both show it. */
export function ratio(won: number, lost: number): string {
	// An undefeated member divides by zero, so the record is stated rather than
	// computed in that case. "5/0" reads better than "Infinity" and better than a
	// silent dash.
	if (lost === 0) return won === 0 ? "0.00" : `${won}/0`;
	return (won / lost).toFixed(2);
}

export function buildAccountEmbed(view: AccountView): EmbedBuilder {
	const c = levelingCopy.labels;

	// ① Identity and progress. The bar is the first thing a member looks for, so
	// it leads, and the milestone nudge rides directly under it because it is only
	// meaningful in the context of the next level.
	const identity = [
		`**${c.level} ${view.level}**  ${progressBar(view.xpIntoLevel, view.xpIntoLevel + view.xpToNext)}`,
		`${c.xpIntoLevel}: **${view.xpIntoLevel.toLocaleString()}**  •  ${c.xpToNext}: **${view.xpToNext.toLocaleString()}**`,
		`${c.totalXp}: **${view.totalXp.toLocaleString()}**`,
		view.nextLevelIsMilestone ? `\n✦ ${c.nextMilestone}` : "",
	]
		.filter(Boolean)
		.join("\n");

	const embed = base().setTitle(view.displayName).setColor(COLORS.ACCOUNT).setDescription(identity);
	if (view.avatarUrl) embed.setThumbnail(view.avatarUrl);

	// ② Standing. Guild rank comes from an index-only count, never a sort.
	const standing = [
		`${c.guildRank}: **#${view.guildRank}** of ${view.guildSize.toLocaleString()}`,
		view.weekRank !== null ? `${c.weekRank}: **#${view.weekRank}**` : null,
		view.monthRank !== null ? `${c.monthRank}: **#${view.monthRank}**` : null,
	]
		.filter(Boolean)
		.join("\n");
	embed.addFields({ name: c.rank, value: standing, inline: false });

	// ③ The record, the month's luck and the currencies.
	embed.addFields(recordField(view), luckField(view), ...currenciesFields(view));

	// ④ Presence.
	embed.addFields({
		name: "Presence",
		value: [
			`${c.messages}: **${view.messages.toLocaleString()}**`,
			`${c.reactions}: **${view.reactionsGiven.toLocaleString()}**`,
			`${c.voiceMinutes}: **${view.voiceMinutes.toLocaleString()}**`,
		].join("\n"),
		inline: false,
	});

	// ⑤ Achievements, each WITH the action that earned it. That sentence is stored
	// on the unlock rather than reconstructed here, because the counters behind it
	// have moved on by the time anyone opens their profile.
	embed.addFields({
		name: c.achievements,
		value:
			view.unlocked.length > 0
				? view.unlocked.map((entry) => `**${entry.id}** (${entry.tier}) • ${entry.earnedBy}`).join("\n")
				: c.noAchievementsYet,
		inline: false,
	});

	return embed;
}

/**
 * The /account message when its card rendered: the member's name over the card,
 * which carries the whole profile, the per game record, the month's luck and the
 * chips included (2026-10 item 254), so no data is left in text. Title and color
 * match buildAccountEmbed, which keeps every field for the text fallback.
 */
export function buildAccountCardEmbed(view: Pick<AccountView, "displayName">, imageRef: string): EmbedBuilder {
	return base().setTitle(view.displayName).setColor(COLORS.ACCOUNT).setImage(imageRef);
}

// ── the levels standings board ──────────────────────────────────────────────
// A SECOND pinned message in the leaderboard channel, beside the participation
// board. The subtitle is not decoration: two boards in one channel answering
// different questions is the single most likely confusion in this feature, so
// every render states which question this one answers.
export interface LevelsBoardEntry {
	userId: string;
	username: string;
	level: number;
	xp: number;
	// Card only: the face beside the row on the board card.
	avatar?: AvatarRequest | null;
}

// The title, color and "which question this board answers" subtitle, shared by
// the text board and the card board so the two can never answer differently.
function levelsBoardSpine(windowLabel: string): EmbedBuilder {
	return base()
		.setTitle(`${levelingCopy.board.title} • ${windowLabel}`)
		.setColor(COLORS.LEVELS_BOARD)
		.setDescription(levelingCopy.boardSubtitles.levels);
}

/** The board message when its card rendered: the same spine, with the standings drawn on the card. */
export function buildLevelsBoardCardEmbed(windowLabel: string, imageRef: string): EmbedBuilder {
	return levelsBoardSpine(windowLabel).setImage(imageRef);
}

export function buildLevelsBoardEmbed(windowLabel: string, entries: LevelsBoardEntry[]): EmbedBuilder {
	const embed = levelsBoardSpine(windowLabel);

	if (entries.length === 0) return embed.addFields({ name: windowLabel, value: levelingCopy.board.emptyState });

	const medal = (index: number): string => (index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`);
	return embed.addFields({
		name: windowLabel,
		value: entries
			.map(
				(entry, index) =>
					`${medal(index)} **${entry.username}** • ${levelingCopy.labels.level} ${entry.level} • ${entry.xp.toLocaleString()} ${levelingCopy.labels.xp}`
			)
			.join("\n"),
	});
}

// ── the unlock announcement ─────────────────────────────────────────────────
// Posted once per pass, listing every tier crossed in that pass. A member who
// jumps from nothing to gold gets one message naming all three rather than three
// messages, which is the same reasoning behind the level up coalescing.
export interface AchievementUnlockEntry {
	id: string;
	tier: string;
	earnedBy: string;
}

/** The unlock card's view: who earned it (a name and a face, since a mention cannot be drawn) and what. */
export interface AchievementUnlockView {
	userId: string;
	displayName: string;
	avatar: AvatarRequest | null;
	unlocks: readonly AchievementUnlockEntry[];
}

function achievementUnlockSpine(unlockCount: number): EmbedBuilder {
	return base()
		.setTitle(unlockCount === 1 ? levelingCopy.achievements.unlockedOne : levelingCopy.achievements.unlockedMany)
		.setColor(COLORS.ACHIEVEMENT);
}

/**
 * The unlock message when its medallion card rendered. The "<@id> earned:" line
 * stays in text, because only text can name the member as a mention; the card
 * carries the tiers and what earned them.
 */
export function buildAchievementUnlockCardEmbed(userId: string, unlockCount: number, imageRef: string): EmbedBuilder {
	return achievementUnlockSpine(unlockCount).setDescription(levelingCopy.achievements.unlockedBy(userId)).setImage(imageRef);
}

export function buildAchievementUnlockEmbed(userId: string, unlocks: readonly AchievementUnlockEntry[]): EmbedBuilder {
	return achievementUnlockSpine(unlocks.length)
		.setDescription(
			[
				levelingCopy.achievements.unlockedBy(userId),
				"",
				...unlocks.map((unlock) => levelingCopy.achievements.unlockLine(unlock.id, unlock.tier, unlock.earnedBy)),
			].join("\n")
		);
}

// ── role unlock (2026-10 item 243 Phase 4) ─────────────────────────────────
// One builder for both shapes of the message: with the card's ref it carries
// the card as its image, without one it is the text fallback on its own. The
// mention line is the same either way, since only text can name a member.
export interface RoleUnlockView {
	userId: string;
	roleId: string;
	/** The role's name as plain text, because a card cannot draw a role mention. */
	roleName: string;
	/** The role's own color, or LEVEL_MILESTONE's when the role has none. */
	roleColor: HexColorString;
	level: number;
	displayName: string;
	avatar: AvatarRequest | null;
}

export function buildRoleUnlockEmbed(view: RoleUnlockView, imageRef?: string): EmbedBuilder {
	const embed = base()
		.setTitle(levelingCopy.roleUnlock.title)
		.setColor(view.roleColor)
		.setDescription(levelingCopy.roleUnlock.unlockedBy(view.userId, view.roleId, view.level));
	if (imageRef) embed.setImage(imageRef);
	return embed;
}

// ── weekly digest (2026-10 item 243 Phase 4) ───────────────────────────────
// A member's own week, sent to them as a direct message. Plain data, so the
// card and this text fallback read the same numbers.
export interface WeeklyDigestView {
	guildName: string;
	displayName: string;
	avatar: AvatarRequest | null;
	weekXp: number;
	weekRank: number;
	activeMembers: number;
	level: number;
}

export function buildWeeklyDigestEmbed(view: WeeklyDigestView, imageRef?: string): EmbedBuilder {
	const copy = levelingCopy.weeklyDigest;
	const embed = base()
		.setTitle(copy.title(view.guildName))
		.setColor(COLORS.ACCOUNT)
		.setDescription([copy.xpLine(view.weekXp), copy.rankLine(view.weekRank, view.activeMembers), copy.levelLine(view.level)].join("\n"))
		.setFooter({ text: copy.footer });
	if (imageRef) embed.setImage(imageRef);
	return embed;
}

// ── achievements ────────────────────────────────────────────────────────────
// Hidden entries are omitted ENTIRELY until they unlock, not shown as a locked
// placeholder with the name blanked out. A placeholder tells a member a secret
// exists, which is most of what the secret was.
export interface AchievementProgressView {
	id: string;
	label: string;
	current: number;
	threshold: number;
	nextTier: string;
}

/** The achievements message when its card rendered: the same title and color as the text view, with everything drawn on the card (2026-10 item 254). */
export function buildAchievementsCardEmbed(displayName: string, imageRef: string): EmbedBuilder {
	return base().setTitle(`${levelingCopy.labels.achievements} • ${displayName}`).setColor(COLORS.ACHIEVEMENT).setImage(imageRef);
}

export function buildAchievementsEmbed(
	displayName: string,
	unlocked: IAchievementUnlock[],
	inProgress: AchievementProgressView[]
): EmbedBuilder {
	const embed = base().setTitle(`${levelingCopy.labels.achievements} • ${displayName}`).setColor(COLORS.ACHIEVEMENT);

	embed.addFields({
		name: levelingCopy.labels.achievements,
		value:
			unlocked.length > 0
				? unlocked.map((entry) => `**${entry.id}** (${entry.tier}) • ${entry.earnedBy}`).join("\n")
				: levelingCopy.labels.noAchievementsYet,
		inline: false,
	});

	if (inProgress.length > 0) {
		embed.addFields({
			name: levelingCopy.labels.inProgress,
			value: inProgress
				.map(
					(entry) =>
						`**${entry.label}** (${entry.nextTier})\n${progressBar(entry.current, entry.threshold)} ${entry.current.toLocaleString()} / ${entry.threshold.toLocaleString()}`
				)
				.join("\n"),
			inline: false,
		});
	}

	return embed;
}
