import { describe, it, expect } from "vitest";
import { ChannelType, Collection, GuildOnboardingMode, GuildOnboardingPromptType, PermissionFlagsBits, type Guild, type GuildOnboarding } from "discord.js";
import { communityCopy } from "./communityCopy.js";
import {
	ONBOARDING_OPTION_TITLE_MAX_LENGTH,
	ONBOARDING_PROMPT_TITLE_MAX_LENGTH,
	buildOnboardingDraft,
	plainOption,
	snapshotOnboarding,
	toOnboardingEditOptions,
	validateOnboardingDraft,
	type IDraftPrompt,
	type IOnboardingSnapshot,
	type PendingOnboardingDraft,
} from "./onboardingDraft.js";

// ── onboardingDraft (2026-10 item 247 Phase 4) ──────────────────────────────
// The starter draft's exact shape (two optional questions, then the required final
// one whose single answer gives the member role, in Advanced mode), its default
// channels, the already configured path that keeps the server's own questions
// instead of overwriting them, the checks every draft passes, and the two
// conversions: the live config into plain data, and the draft into the one
// guild.editOnboarding call.

const EVERYONE = "guild-1";
const MEMBER_ROLE = "role-member";
const GAMER_ROLE = "role-gamer";
const STAFF_ROLE = "role-staff";
const copy = communityCopy.onboarding;

// A channel whose resolved @everyone permission to view and send is `open`.
const channel = (id: string, open = true) => ({
	id,
	type: ChannelType.GuildText,
	permissionsFor: (role: { id: string }) => ({
		has: (flags: bigint[]) => open && role.id === EVERYONE && flags.includes(PermissionFlagsBits.SendMessages),
	}),
});

function makeGuild(channelIds: Array<[string, boolean]> = [["intro", true], ["general", true], ["memes", true], ["gated", false]]): Guild {
	const roles = new Map([
		[MEMBER_ROLE, { id: MEMBER_ROLE, name: "Member", position: 2 }],
		[GAMER_ROLE, { id: GAMER_ROLE, name: "Gamer", position: 3 }],
		[STAFF_ROLE, { id: STAFF_ROLE, name: "Staff", position: 9 }],
	]);
	return {
		id: "guild-1",
		features: ["COMMUNITY"],
		roles: { everyone: { id: EVERYONE }, cache: roles },
		members: { me: { permissions: { has: () => true }, roles: { highest: { position: 5 } } } },
		channels: { cache: new Map(channelIds.map(([id, open]) => [id, channel(id, open)])) },
	} as unknown as Guild;
}

const stored = { memberRoleId: MEMBER_ROLE, introChannelId: "intro" };

function draftOf(result: ReturnType<typeof buildOnboardingDraft>): PendingOnboardingDraft {
	if (!result.ok) throw new Error(`expected a draft, got a refusal: ${result.reason}`);
	return result.draft;
}

// A question read from a server's live config, already in draft shape.
function livePrompt(overrides: Partial<IDraftPrompt> = {}): IDraftPrompt {
	return {
		id: "prompt-live-1",
		title: "Pick your games",
		singleSelect: false,
		required: false,
		inOnboarding: true,
		type: GuildOnboardingPromptType.Dropdown,
		options: [{ ...plainOption("Chess", "Board games"), id: "option-live-1", roleIds: [GAMER_ROLE], channelIds: ["general"], emoji: "♟️" }],
		isFinal: false,
		...overrides,
	};
}

const snapshot = (prompts: IDraftPrompt[], defaultChannelIds: string[] = []): IOnboardingSnapshot => ({ enabled: true, prompts, defaultChannelIds });

describe("the starter draft", () => {
	const draft = draftOf(buildOnboardingDraft({ guild: makeGuild(), stored, copy, current: snapshot([]) }));

	it("is Advanced mode with two optional questions and the required final one, in that order", () => {
		expect(draft.mode).toBe(GuildOnboardingMode.OnboardingAdvanced);
		expect(draft.prompts.map((prompt) => prompt.title)).toEqual([copy.draft.heardAbout.title, copy.draft.goals.title, copy.draft.final.title]);
		expect(draft.startedFromExisting).toBe(false);
		expect(draft.finalPromptAdded).toBe(false);
	});

	it("drafts the optional questions as pick any, not required, with the copy's answers giving nothing", () => {
		const [heardAbout, goals] = draft.prompts;
		for (const prompt of [heardAbout!, goals!]) {
			expect(prompt).toMatchObject({ id: null, singleSelect: false, required: false, inOnboarding: true, type: GuildOnboardingPromptType.MultipleChoice, isFinal: false });
			for (const option of prompt.options) expect(option).toMatchObject({ id: null, description: null, roleIds: [], channelIds: [], emoji: null });
		}
		expect(heardAbout!.options.map((option) => option.title)).toEqual([...copy.draft.heardAbout.options]);
		expect(goals!.options.map((option) => option.title)).toEqual([...copy.draft.goals.options]);
	});

	it("drafts the final question as required, pick one, with ONE answer that gives exactly the member role", () => {
		const final = draft.prompts.at(-1)!;
		expect(final).toMatchObject({ singleSelect: true, required: true, inOnboarding: true, type: GuildOnboardingPromptType.MultipleChoice, isFinal: true });
		expect(final.options).toEqual([{ id: null, title: "Glad to be here", description: null, roleIds: [MEMBER_ROLE], channelIds: [], emoji: null }]);
	});

	it("keeps the owner's final question copy within the caps the edit modal enforces", () => {
		expect(copy.draft.final.title.length).toBeLessThanOrEqual(ONBOARDING_PROMPT_TITLE_MAX_LENGTH);
		expect(copy.draft.final.optionTitle.length).toBeLessThanOrEqual(ONBOARDING_OPTION_TITLE_MAX_LENGTH);
	});

	it("defaults to #introductions and every channel @everyone can send in, each once, and nothing gated", () => {
		expect(draft.defaultChannelIds).toEqual(["intro", "general", "memes"]);
	});

	it("drafts the same starter set when there is no live config at all", () => {
		const fromNothing = draftOf(buildOnboardingDraft({ guild: makeGuild(), stored, copy, current: null }));
		expect(fromNothing.prompts.map((prompt) => prompt.title)).toEqual(draft.prompts.map((prompt) => prompt.title));
	});
});

describe("a server that already has Onboarding questions", () => {
	it("keeps every question as read, ids and attachments included, and appends the final question", () => {
		const existing = livePrompt();
		const draft = draftOf(buildOnboardingDraft({ guild: makeGuild(), stored, copy, current: snapshot([existing]) }));

		expect(draft.startedFromExisting).toBe(true);
		expect(draft.finalPromptAdded).toBe(true);
		expect(draft.prompts).toHaveLength(2);
		expect(draft.prompts[0]).toEqual(existing);
		expect(draft.prompts[0]).not.toBe(existing);
		expect(draft.prompts[1]).toMatchObject({ title: copy.draft.final.title, isFinal: true });
		expect(draft.prompts.map((prompt) => prompt.title)).not.toContain(copy.draft.heardAbout.title);
	});

	it("recognizes a question already shaped like the final one, keeps its id and moves it last", () => {
		const theirFinal = livePrompt({
			id: "prompt-live-final",
			title: "Welcome aboard",
			singleSelect: true,
			required: true,
			type: GuildOnboardingPromptType.MultipleChoice,
			options: [{ ...plainOption("Let me in"), id: "option-live-final", roleIds: [MEMBER_ROLE] }],
		});
		const games = livePrompt();
		const draft = draftOf(buildOnboardingDraft({ guild: makeGuild(), stored, copy, current: snapshot([theirFinal, games]) }));

		expect(draft.finalPromptAdded).toBe(false);
		expect(draft.prompts.map((prompt) => prompt.id)).toEqual(["prompt-live-1", "prompt-live-final"]);
		expect(draft.prompts.at(-1)).toMatchObject({ title: "Welcome aboard", isFinal: true });
	});

	it("merges the server's own default channels, dropping one that no longer exists", () => {
		const draft = draftOf(buildOnboardingDraft({ guild: makeGuild(), stored, copy, current: snapshot([livePrompt()], ["gated", "deleted-channel", "general"]) }));
		expect(draft.defaultChannelIds).toEqual(["intro", "gated", "general", "memes"]);
	});

	it("refuses a question whose answer gives a role above Dero's, naming the role", () => {
		const staffOnly = livePrompt({ options: [{ ...plainOption("Staff"), roleIds: [STAFF_ROLE] }] });
		const result = buildOnboardingDraft({ guild: makeGuild(), stored, copy, current: snapshot([staffOnly]) });
		expect(result).toEqual({ ok: false, code: "role-above-bot", reason: copy.draftErrors.roleAboveBot("Staff") });
	});

	it("refuses a question whose answer gives a role that no longer exists", () => {
		const ghost = livePrompt({ options: [{ ...plainOption("Ghost"), roleIds: ["role-deleted"] }] });
		expect(buildOnboardingDraft({ guild: makeGuild(), stored, copy, current: snapshot([ghost]) })).toEqual({ ok: false, code: "role-gone", reason: copy.draftErrors.roleGone });
	});
});

describe("validateOnboardingDraft", () => {
	const valid = () => draftOf(buildOnboardingDraft({ guild: makeGuild(), stored, copy, current: null }));
	const invalid = { ok: false, code: "final-prompt-invalid", reason: copy.draftErrors.finalPromptInvalid };

	it("passes the starter draft", () => {
		expect(validateOnboardingDraft(makeGuild(), valid(), copy)).toBeNull();
	});

	it("refuses a final question whose answer lost the member role", () => {
		const draft = valid();
		const final = draft.prompts.at(-1)!;
		draft.prompts[draft.prompts.length - 1] = { ...final, options: [{ ...final.options[0]!, roleIds: [] }] };
		expect(validateOnboardingDraft(makeGuild(), draft, copy)).toEqual(invalid);
	});

	it("refuses a draft whose final question is not last, is missing, or is not alone", () => {
		const draft = valid();
		expect(validateOnboardingDraft(makeGuild(), { ...draft, prompts: [...draft.prompts].reverse() }, copy)).toEqual(invalid);
		expect(validateOnboardingDraft(makeGuild(), { ...draft, prompts: draft.prompts.slice(0, 2) }, copy)).toEqual(invalid);
		expect(validateOnboardingDraft(makeGuild(), { ...draft, prompts: [draft.prompts.at(-1)!, ...draft.prompts] }, copy)).toEqual(invalid);
	});

	it("refuses a final question that is no longer required or pick one", () => {
		const draft = valid();
		const final = draft.prompts.at(-1)!;
		expect(validateOnboardingDraft(makeGuild(), { ...draft, prompts: [...draft.prompts.slice(0, 2), { ...final, required: false }] }, copy)).toEqual(invalid);
		expect(validateOnboardingDraft(makeGuild(), { ...draft, prompts: [...draft.prompts.slice(0, 2), { ...final, singleSelect: false }] }, copy)).toEqual(invalid);
	});

	it("refuses a member role that moved above Dero since the draft", () => {
		const guild = makeGuild();
		(guild.roles.cache.get(MEMBER_ROLE) as unknown as { position: number }).position = 8;
		expect(validateOnboardingDraft(guild, valid(), copy)).toEqual({ ok: false, code: "role-above-bot", reason: copy.draftErrors.roleAboveBot("Member") });
	});

	it("is not reached without a member role: the drafter refuses first", () => {
		expect(buildOnboardingDraft({ guild: makeGuild(), stored: { memberRoleId: null }, copy, current: null })).toEqual({
			ok: false,
			code: "no-member-role",
			reason: copy.preconditions.noMemberRole,
		});
	});
});

describe("snapshotOnboarding", () => {
	it("reads ids, flags, role and channel ids from the keys, and each emoji as an identifier", () => {
		// discord.js keys each answer's roles by id even when the role is not cached,
		// so a value can be undefined; the keys are what the snapshot keeps.
		const option = (id: string, title: string, emoji: { id: string | null; name: string | null; animated?: boolean } | null) => ({
			id,
			title,
			description: null,
			roles: new Collection([[GAMER_ROLE, undefined]]),
			channels: new Collection([["general", undefined]]),
			emoji,
		});
		const live = {
			enabled: true,
			prompts: new Collection([
				[
					"prompt-1",
					{
						id: "prompt-1",
						title: "Games",
						singleSelect: false,
						required: false,
						inOnboarding: true,
						type: GuildOnboardingPromptType.Dropdown,
						options: new Collection([
							["option-1", option("option-1", "Chess", { id: null, name: "♟️" })],
							["option-2", option("option-2", "Party", { id: "123456789012345678", name: "party", animated: true })],
							["option-3", option("option-3", "Plain", null)],
						]),
					},
				],
			]),
			defaultChannels: new Collection([["general", undefined]]),
		} as unknown as GuildOnboarding;

		expect(snapshotOnboarding(live)).toEqual({
			enabled: true,
			defaultChannelIds: ["general"],
			prompts: [
				{
					id: "prompt-1",
					title: "Games",
					singleSelect: false,
					required: false,
					inOnboarding: true,
					type: GuildOnboardingPromptType.Dropdown,
					isFinal: false,
					options: [
						{ id: "option-1", title: "Chess", description: null, roleIds: [GAMER_ROLE], channelIds: ["general"], emoji: "♟️" },
						{ id: "option-2", title: "Party", description: null, roleIds: [GAMER_ROLE], channelIds: ["general"], emoji: "<a:party:123456789012345678>" },
						{ id: "option-3", title: "Plain", description: null, roleIds: [GAMER_ROLE], channelIds: ["general"], emoji: null },
					],
				},
			],
		});
	});
});

describe("toOnboardingEditOptions", () => {
	it("is the full write: Onboarding on, Advanced mode, every question in discord.js's names, the defaults and the reason", () => {
		const draft = draftOf(buildOnboardingDraft({ guild: makeGuild(), stored, copy, current: snapshot([livePrompt()]) }));
		const options = toOnboardingEditOptions(draft, copy.auditReason);

		expect(options).toEqual({
			enabled: true,
			mode: GuildOnboardingMode.OnboardingAdvanced,
			defaultChannels: ["intro", "general", "memes"],
			reason: "Configured by Dero via Configure Onboarding",
			prompts: [
				{
					id: "prompt-live-1",
					title: "Pick your games",
					singleSelect: false,
					required: false,
					inOnboarding: true,
					type: GuildOnboardingPromptType.Dropdown,
					options: [{ id: "option-live-1", title: "Chess", description: "Board games", roles: [GAMER_ROLE], channels: ["general"], emoji: "♟️" }],
				},
				{
					id: undefined,
					title: copy.draft.final.title,
					singleSelect: true,
					required: true,
					inOnboarding: true,
					type: GuildOnboardingPromptType.MultipleChoice,
					options: [{ id: null, title: "Glad to be here", description: null, roles: [MEMBER_ROLE], channels: [], emoji: null }],
				},
			],
		});
	});
});
