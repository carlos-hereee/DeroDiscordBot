import { GuildOnboardingMode, GuildOnboardingPromptType, type Emoji, type Guild, type GuildOnboarding, type GuildOnboardingEditOptions } from "discord.js";
import type { communityCopy } from "./communityCopy.js";
import { everyoneSendableChannelIds, isRoleBelowBot } from "./onboardingPreconditions.js";

// ── onboardingDraft ──────────────────────────────────────────────────
// What:  the Onboarding draft the owner reviews before Confirm (2026-10 item 247
//        Phase 4): the questions, the default channels and Advanced mode, in plain
//        data, plus the checks that keep it writable and the one conversion into
//        guild.editOnboarding's options. It never talks to Discord; it reads the
//        cached guild and a snapshot of the live config.
// Who:   configureOnboarding builds and validates the draft and turns it into the
//        write; promptEditModal edits its questions and answers; the review renders it.
// When:  on the Configure Onboarding press (build), after each edit (the review
//        redraws from it), and on Confirm (validate again, then write).
// How:   ① a server with no questions gets the starter set: two optional questions
//        and the required final one that gives the member role; ② a server that
//        already has questions keeps every one of them, ids included, so nothing it
//        had is silently replaced, and gains the final question only when none of
//        its own already has that shape; ③ default channels are #introductions, the
//        server's existing defaults and every channel @everyone can send in;
//        ④ every role an answer gives must be one Dero can hand out.

// ── constants ────────────────────────────────────────────────────────
// Caps from Discord's own Onboarding editor. The public API docs do not state them,
// so the edit modal enforces these and anything Discord still refuses comes back
// verbatim at Confirm.

/** The longest question title the edit modal accepts. */
export const ONBOARDING_PROMPT_TITLE_MAX_LENGTH = 100;
/** The longest answer title the edit modal accepts. */
export const ONBOARDING_OPTION_TITLE_MAX_LENGTH = 50;
/** The longest answer description the edit modal accepts. */
export const ONBOARDING_OPTION_DESCRIPTION_MAX_LENGTH = 100;
/** The most answers one question can carry. */
export const ONBOARDING_OPTIONS_PER_PROMPT_MAX = 50;
/**
 * The most questions the review's editor holds: its question select shows 25 at
 * most, Discord's cap on a select, so a 26th could never be picked to edit. Discord's
 * own Onboarding cap may be lower; a refusal on it comes back verbatim at Confirm.
 */
export const ONBOARDING_PROMPTS_MAX = 25;
/** The most roles one answer's role select holds, Discord's cap on a select. */
export const ONBOARDING_OPTION_ROLES_MAX = 25;

// ── types ────────────────────────────────────────────────────────────

/** The copy the drafter and its checks read, the onboarding section of communityCopy. */
export type OnboardingCopy = typeof communityCopy.onboarding;

/** The stored GuildConfig fields the drafter reads. */
export interface IOnboardingDraftConfig {
	memberRoleId?: string | null;
	introChannelId?: string | null;
}

/** One answer in a draft question, in plain data so the review, the modal and the write all read one shape. */
export interface IDraftOption {
	/** Discord's id for an answer read from the live config, so Discord updates it rather than replacing it; null for an answer Dero drafted. */
	id: string | null;
	title: string;
	description: string | null;
	roleIds: string[];
	channelIds: string[];
	/** An identifier discord.js resolves: a unicode emoji, or <:name:id> for a custom one. */
	emoji: string | null;
}

/** One question in the draft. */
export interface IDraftPrompt {
	/** Discord's id for a question read from the live config; null for one Dero drafted (discord.js mints one at write time). */
	id: string | null;
	title: string;
	singleSelect: boolean;
	required: boolean;
	inOnboarding: boolean;
	type: GuildOnboardingPromptType;
	options: IDraftOption[];
	/** The required last question whose one answer gives the member role. Its shape is fixed; the owner can change only its two titles. */
	isFinal: boolean;
}

/** A draft waiting for the owner's Confirm. */
export interface PendingOnboardingDraft {
	mode: GuildOnboardingMode.OnboardingAdvanced;
	prompts: IDraftPrompt[];
	defaultChannelIds: string[];
	memberRoleId: string;
	/** The draft began from questions the server already had rather than the starter set. */
	startedFromExisting: boolean;
	/** The server's own questions had no final question, so Dero appended one. */
	finalPromptAdded: boolean;
}

/** The live Onboarding config, read once into plain data. Every prompt arrives with isFinal false; the drafter decides which one is final. */
export interface IOnboardingSnapshot {
	enabled: boolean;
	prompts: IDraftPrompt[];
	defaultChannelIds: string[];
}

/** Why a draft cannot be written, with the sentence the owner reads. */
export interface IOnboardingDraftRefusal {
	ok: false;
	code: "no-member-role" | "role-gone" | "role-above-bot" | "final-prompt-invalid";
	reason: string;
}

/** A draft ready for review, or the reason there is none. */
export type OnboardingDraftResult = { ok: true; draft: PendingOnboardingDraft } | IOnboardingDraftRefusal;

/** What buildOnboardingDraft needs: the cached guild, the stored config, the copy, and the live config (null when the server has none to read). */
export interface IBuildOnboardingDraftInput {
	guild: Guild;
	stored: IOnboardingDraftConfig;
	copy: OnboardingCopy;
	current: IOnboardingSnapshot | null;
}

// ── building ─────────────────────────────────────────────────────────

/** Build the draft for review, refusing one Discord would not accept. */
export function buildOnboardingDraft({ guild, stored, copy, current }: IBuildOnboardingDraftInput): OnboardingDraftResult {
	const memberRoleId = stored.memberRoleId;
	if (!memberRoleId) return { ok: false, code: "no-member-role", reason: copy.preconditions.noMemberRole };

	const existingPrompts = current?.prompts ?? [];
	const questions = existingPrompts.length > 0 ? keepExistingPrompts(existingPrompts, memberRoleId, copy) : { prompts: starterPrompts(memberRoleId, copy), finalPromptAdded: false };
	const draft: PendingOnboardingDraft = {
		mode: GuildOnboardingMode.OnboardingAdvanced,
		prompts: questions.prompts,
		defaultChannelIds: draftDefaultChannelIds(guild, stored, current),
		memberRoleId,
		startedFromExisting: existingPrompts.length > 0,
		finalPromptAdded: questions.finalPromptAdded,
	};
	const refusal = validateOnboardingDraft(guild, draft, copy);
	return refusal ?? { ok: true, draft };
}

/** An answer that gives nothing and opens nothing, the shape of every drafted answer and of a new one typed in the edit modal. */
export function plainOption(title: string, description: string | null = null): IDraftOption {
	return { id: null, title, description, roleIds: [], channelIds: [], emoji: null };
}

// ① The starter set, in the order a newcomer meets it.
function starterPrompts(memberRoleId: string, copy: OnboardingCopy): IDraftPrompt[] {
	return [
		optionalPrompt(copy.draft.heardAbout.title, copy.draft.heardAbout.options),
		optionalPrompt(copy.draft.goals.title, copy.draft.goals.options),
		finalPrompt(memberRoleId, copy),
	];
}

function optionalPrompt(title: string, optionTitles: readonly string[]): IDraftPrompt {
	return newOptionalPrompt(title, optionTitles.map((optionTitle) => plainOption(optionTitle)));
}

/** An optional, pick any question with these answers: the shape of every starter question and of one added in the review. */
export function newOptionalPrompt(title: string, options: IDraftOption[]): IDraftPrompt {
	return { id: null, title, singleSelect: false, required: false, inOnboarding: true, type: GuildOnboardingPromptType.MultipleChoice, options, isFinal: false };
}

function finalPrompt(memberRoleId: string, copy: OnboardingCopy): IDraftPrompt {
	return {
		id: null,
		title: copy.draft.final.title,
		singleSelect: true,
		required: true,
		inOnboarding: true,
		type: GuildOnboardingPromptType.MultipleChoice,
		options: [{ ...plainOption(copy.draft.final.optionTitle), roleIds: [memberRoleId] }],
		isFinal: true,
	};
}

// ② Every existing question stays, as read. The first one already shaped like the
// final question (required, pick one, a single answer that gives the member role)
// becomes the final one and moves last; with none, the starter final is appended.
// Copied, never mutated, so the snapshot stays what Discord said.
function keepExistingPrompts(existing: readonly IDraftPrompt[], memberRoleId: string, copy: OnboardingCopy): { prompts: IDraftPrompt[]; finalPromptAdded: boolean } {
	const prompts = existing.map((prompt) => ({ ...prompt, options: prompt.options.map((option) => ({ ...option })), isFinal: false }));
	const finalIndex = prompts.findIndex((prompt) => hasFinalShape(prompt, memberRoleId));
	if (finalIndex === -1) return { prompts: [...prompts, finalPrompt(memberRoleId, copy)], finalPromptAdded: true };
	const [existingFinal] = prompts.splice(finalIndex, 1);
	return { prompts: [...prompts, { ...existingFinal!, isFinal: true }], finalPromptAdded: false };
}

function hasFinalShape(prompt: IDraftPrompt, memberRoleId: string): boolean {
	return prompt.required && prompt.singleSelect && prompt.options.length === 1 && prompt.options[0]!.roleIds.includes(memberRoleId);
}

// ③ Introductions first, then what the owner already chose, then every channel
// @everyone can send in, each once. Only channels still in the guild are kept: a
// default naming a deleted channel would fail the whole write.
function draftDefaultChannelIds(guild: Guild, stored: IOnboardingDraftConfig, current: IOnboardingSnapshot | null): string[] {
	const candidates = [stored.introChannelId, ...(current?.defaultChannelIds ?? []), ...everyoneSendableChannelIds(guild)];
	const present = candidates.filter((id): id is string => typeof id === "string" && guild.channels.cache.has(id));
	return [...new Set(present)];
}

// ── checking ─────────────────────────────────────────────────────────

/**
 * The checks every draft passes before review and again before Confirm: exactly
 * one final question, last, still required and pick one, with its one answer still
 * giving the member role; and every role any answer gives still exists and sits
 * below Dero's highest role. Null when the draft is writable.
 */
export function validateOnboardingDraft(guild: Guild, draft: PendingOnboardingDraft, copy: OnboardingCopy): IOnboardingDraftRefusal | null {
	const finals = draft.prompts.filter((prompt) => prompt.isFinal);
	const last = draft.prompts.at(-1);
	if (finals.length !== 1 || !last?.isFinal || !hasFinalShape(last, draft.memberRoleId)) {
		return { ok: false, code: "final-prompt-invalid", reason: copy.draftErrors.finalPromptInvalid };
	}

	for (const roleId of new Set(draft.prompts.flatMap((prompt) => prompt.options.flatMap((option) => option.roleIds)))) {
		const role = guild.roles.cache.get(roleId);
		if (!role) return { ok: false, code: "role-gone", reason: copy.draftErrors.roleGone };
		if (!isRoleBelowBot(guild, role)) return { ok: false, code: "role-above-bot", reason: copy.draftErrors.roleAboveBot(role.name) };
	}
	return null;
}

/**
 * Roles given by answers in more than one question (2026-10 item 254), in the order
 * they are first met. A member can then get one from either question, which the
 * owner may mean, so the review warns and never refuses. Two answers of ONE question
 * giving the same role do not count: a member picks within that question anyway.
 */
export function rolesReusedAcrossPrompts(prompts: readonly IDraftPrompt[]): string[] {
	const questionsByRole = new Map<string, number>();
	for (const prompt of prompts) {
		for (const roleId of new Set(prompt.options.flatMap((option) => option.roleIds))) {
			questionsByRole.set(roleId, (questionsByRole.get(roleId) ?? 0) + 1);
		}
	}
	return [...questionsByRole].filter(([, questions]) => questions > 1).map(([roleId]) => roleId);
}

// ── reading and writing Discord's shape ──────────────────────────────

/** The live config as plain draft data: ids, titles, flags, and each answer's role ids, channel ids and emoji. */
export function snapshotOnboarding(onboarding: Pick<GuildOnboarding, "enabled" | "prompts" | "defaultChannels">): IOnboardingSnapshot {
	return {
		enabled: onboarding.enabled,
		prompts: [...onboarding.prompts.values()].map((prompt) => ({
			id: prompt.id,
			title: prompt.title,
			singleSelect: prompt.singleSelect,
			required: prompt.required,
			inOnboarding: prompt.inOnboarding,
			type: prompt.type,
			// The KEYS, not the values: discord.js keys each answer's roles and channels
			// by id even when one is missing from the cache and its value is undefined.
			options: [...prompt.options.values()].map((option) => ({
				id: option.id,
				title: option.title,
				description: option.description,
				roleIds: [...option.roles.keys()],
				channelIds: [...option.channels.keys()],
				emoji: emojiIdentifier(option.emoji),
			})),
			isFinal: false,
		})),
		defaultChannelIds: [...onboarding.defaultChannels.keys()],
	};
}

/** The one guild.editOnboarding call for a draft: Onboarding on, Advanced mode, every question and every default channel. */
export function toOnboardingEditOptions(draft: PendingOnboardingDraft, reason: string): GuildOnboardingEditOptions {
	return {
		enabled: true,
		mode: draft.mode,
		prompts: draft.prompts.map((prompt) => ({
			id: prompt.id ?? undefined,
			title: prompt.title,
			singleSelect: prompt.singleSelect,
			required: prompt.required,
			inOnboarding: prompt.inOnboarding,
			type: prompt.type,
			options: prompt.options.map((option) => ({
				id: option.id,
				title: option.title,
				description: option.description,
				roles: option.roleIds,
				channels: option.channelIds,
				emoji: option.emoji,
			})),
		})),
		defaultChannels: draft.defaultChannelIds,
		reason,
	};
}

// The identifier discord.js turns back into the emoji fields Discord wants: a
// unicode emoji is its own name, a custom one is <:name:id> (<a:name:id> when it
// moves), and a custom one with no name left is its bare id.
function emojiIdentifier(emoji: Pick<Emoji, "id" | "name" | "animated"> | null): string | null {
	if (!emoji) return null;
	if (!emoji.id) return emoji.name ?? null;
	return emoji.name ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : emoji.id;
}
