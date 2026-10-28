import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, Collection, GuildOnboardingPromptType, PermissionFlagsBits, TextInputStyle, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

// ── promptEditModal (2026-10 item 247 Phase 4, reworked by 2026-10 item 254) ─────
// The Onboarding review's editor: the pure edits (rename, add and delete a question,
// save and delete an answer, the role checks), the modals each control opens, and
// the round trip the way it arrives through the router: pick a question, press a
// control, submit, the review redrawn in place, then Confirm writing what the owner
// edited, each answer with its own roles.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: vi.fn(), registerSelectMenu: vi.fn() }));

import { handleCommunityButton } from "./communityButtons.js";
import { COMMUNITY_CUSTOM_IDS, reviewControlCustomId, type CommunityAction } from "./communityControls.js";
import { communityCopy } from "./communityCopy.js";
import { buildOnboardingDraft, plainOption, rolesReusedAcrossPrompts, type IDraftOption, type PendingOnboardingDraft } from "./onboardingDraft.js";
import {
	addPrompt,
	applyPromptEdit,
	buildAddPromptModal,
	buildAnswerModal,
	buildPromptEditModal,
	deleteAnswer,
	deletePrompt,
	refuseAnswerRoles,
	saveAnswer,
} from "./promptEditModal.js";

const OWNER = "owner-1";
const ADMIN = "admin-1";
const EVERYONE = "everyone-role";
const MEMBER_ROLE = "role-member";
const GAMER_ROLE = "role-gamer";
const ARTIST_ROLE = "role-artist";
const HIGH_ROLE = "role-high";
const copy = communityCopy.onboarding;
const errors = copy.editErrors;

let guildCounter = 0;
let interactionCounter = 0;

function makeGuild() {
	guildCounter += 1;
	const channels = new Map(
		["intro", "a", "b", "c", "d"].map((id) => [
			id,
			{ id, type: ChannelType.GuildText, permissionsFor: (role: { id: string }) => ({ has: (flags: bigint[]) => role.id === EVERYONE && flags.includes(PermissionFlagsBits.SendMessages) }) },
		])
	);
	return {
		id: `g${guildCounter}`,
		ownerId: OWNER,
		features: ["COMMUNITY"],
		roles: {
			everyone: { id: EVERYONE },
			cache: new Map([
				[MEMBER_ROLE, { id: MEMBER_ROLE, name: "Member", position: 2 }],
				[GAMER_ROLE, { id: GAMER_ROLE, name: "Gamer", position: 3 }],
				[ARTIST_ROLE, { id: ARTIST_ROLE, name: "Artist", position: 4 }],
				// Above Dero's highest role (5), so Discord would refuse to give it.
				[HIGH_ROLE, { id: HIGH_ROLE, name: "Moderator", position: 9 }],
			]),
		},
		members: {
			me: { permissions: { has: () => true }, roles: { highest: { position: 5 } } },
			cache: new Map([[ADMIN, { roles: { cache: new Set(["role-admin"]) } }]]),
			fetch: vi.fn(async () => null),
		},
		channels: { cache: channels },
		fetchOnboarding: vi.fn(async () => ({ enabled: false, prompts: new Collection(), defaultChannels: new Collection() })),
		editOnboarding: vi.fn(async (_options: unknown) => ({})),
		fetchOwner: vi.fn(async () => ({ send: vi.fn(async () => undefined) })),
	};
}

type FakeGuild = ReturnType<typeof makeGuild>;

/** What a modal submit typed (text fields) and picked (the role select). */
interface ISubmitValues {
	text: Record<string, string>;
	roles?: string[];
}

function submission(guild: FakeGuild, userId: string, customId: string, values: ISubmitValues) {
	const keys = [...Object.keys(values.text), ...(values.roles ? ["option_roles"] : [])];
	return {
		guild,
		user: { id: userId },
		customId,
		fields: {
			fields: new Map(keys.map((key) => [key, {}])),
			getTextInputValue: (key: string) => values.text[key] ?? "",
			getSelectedRoles: () => new Collection((values.roles ?? []).map((id) => [id, { id }])),
		},
		isFromMessage: () => true,
		update: vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
	} as unknown as ModalSubmitInteraction & { update: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> };
}

// A press whose modal, if it opens one, is submitted with these values. The fake
// collector applies the real filter, so a submit for another modal is not heard.
// A select press carries `values`, which is how the router tells it from a button.
function press(guild: FakeGuild, userId: string, customId: string, options: { submit?: ISubmitValues; values?: string[]; submitter?: string } = {}) {
	interactionCounter += 1;
	const id = `int-${interactionCounter}`;
	const submitted = options.submit ? submission(guild, options.submitter ?? userId, `community:promptmodal:${id}`, options.submit) : null;
	const interaction = {
		id,
		customId,
		guild,
		user: { id: userId },
		...(options.values ? { values: options.values } : {}),
		reply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
		update: vi.fn(async () => undefined),
		showModal: vi.fn(async () => undefined),
		awaitModalSubmit: vi.fn(async ({ filter }: { filter: (submit: ModalSubmitInteraction) => boolean }) => {
			if (!submitted || !filter(submitted)) throw new Error("Collector received no interactions before ending with reason: time");
			return submitted;
		}),
	};
	return { interaction: interaction as unknown as ButtonInteraction & Record<"reply" | "update" | "editReply" | "showModal", ReturnType<typeof vi.fn>>, submitted };
}

interface ISentMessage {
	content?: string;
	embeds?: Array<{ data: { title?: string; description?: string; fields?: Array<{ name: string; value: string }> } }>;
	components?: Array<{ toJSON(): { components: Array<{ custom_id?: string; label?: string }> } }>;
}

const sent = (fn: ReturnType<typeof vi.fn>, call = 0): ISentMessage => fn.mock.calls[call]![0] as ISentMessage;
// What a refused press was told: the notice modal's text (post-launch plan item 9),
// or the private reply's plain text when no notice opened, as after a modal submit.
type NoticeJson = { custom_id: string; components: Array<{ content?: string }> };
const noticeModals = (interaction: { showModal?: ReturnType<typeof vi.fn> }): NoticeJson[] =>
	(interaction.showModal?.mock.calls ?? [])
		.map((call) => (call[0] as { toJSON(): unknown }).toJSON() as NoticeJson)
		.filter((modal) => modal.custom_id.startsWith("notice:"));
const refusalText = (interaction: { showModal?: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> }): string | undefined => {
	const [notice] = noticeModals(interaction);
	if (notice) return notice.components.map((component) => component.content).join("\n");
	// since Phase 1c a refused Submit's private fallback is the notice's plain text (owner rule 1)
	return sent(interaction.reply).content;
};
const fieldNames = (message: ISentMessage): string[] => message.embeds![0]!.data.fields!.map((field) => field.name);
const customIdsOf = (message: ISentMessage): string[] => (message.components ?? []).flatMap((row) => row.toJSON().components.map((component) => component.custom_id ?? ""));

// ── driving the review ──

/** The review the owner sees now: the last message any step drew. */
let latestReview: ISentMessage | null = null;

// The revision the latest review's controls carry, read off its question select.
function currentRevision(): number {
	const select = customIdsOf(latestReview!).find((id) => id.startsWith(COMMUNITY_CUSTOM_IDS.pickPrompt));
	return Number(select!.split(":")[2]);
}

const controlId = (action: CommunityAction, ...indexes: number[]): string => reviewControlCustomId(action, currentRevision(), ...indexes);

async function openReview(guild: FakeGuild, userId = OWNER) {
	const { interaction } = press(guild, userId, COMMUNITY_CUSTOM_IDS.configure);
	await handleCommunityButton(interaction);
	latestReview = sent(interaction.editReply);
	return interaction;
}

async function pick(guild: FakeGuild, action: "pickPrompt" | "pickOption", value: number, ...indexes: number[]) {
	const { interaction } = press(guild, OWNER, controlId(action, ...indexes), { values: [String(value)] });
	await handleCommunityButton(interaction);
	if (interaction.update.mock.calls.length > 0) latestReview = sent(interaction.update);
	return interaction;
}

async function pressControl(guild: FakeGuild, customId: string, options: { submit?: ISubmitValues; submitter?: string } = {}, userId = OWNER) {
	const { interaction, submitted } = press(guild, userId, customId, options);
	await handleCommunityButton(interaction);
	if (interaction.update.mock.calls.length > 0) latestReview = sent(interaction.update);
	if (submitted && submitted.update.mock.calls.length > 0) latestReview = sent(submitted.update);
	return { interaction, submitted: submitted! };
}

const answer = (title: string, roles: string[] = [], description = ""): ISubmitValues => ({ text: { option_title: title, option_description: description }, roles });

async function confirmPayload(guild: FakeGuild) {
	const { interaction } = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.confirmOnboarding);
	await handleCommunityButton(interaction);
	return guild.editOnboarding.mock.calls[0]![0] as {
		prompts: Array<{ title: string; singleSelect: boolean; required: boolean; options: Array<{ id: string | null; title: string; description: string | null; roles: string[]; channels: string[] }> }>;
	};
}

function starterDraft(): PendingOnboardingDraft {
	const result = buildOnboardingDraft({ guild: makeGuild() as never, stored: { memberRoleId: MEMBER_ROLE, introChannelId: "intro" }, copy, current: null });
	if (!result.ok) throw new Error(result.reason);
	return result.draft;
}

function applied(result: ReturnType<typeof applyPromptEdit>): PendingOnboardingDraft {
	if (!result.ok) throw new Error(result.reason);
	return result.draft;
}

const gamesOption: IDraftOption = { ...plainOption("Chess", "Board games"), id: "option-chess", roleIds: [GAMER_ROLE], channelIds: ["a"], emoji: "♟️" };

beforeEach(() => {
	vi.clearAllMocks();
	latestReview = null;
	mocks.findByGuildId.mockResolvedValue({ adminRoleId: "role-admin", memberRoleId: MEMBER_ROLE, introChannelId: "intro" });
	mocks.log.mockResolvedValue(undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ── pure: the edits ──

describe("the question edits", () => {
	it("renames an optional question and leaves every other question the same object", () => {
		const draft = starterDraft();
		const next = applied(applyPromptEdit(draft, 0, { title: "How did you find us?" }));
		expect(next.prompts[0]).toMatchObject({ title: "How did you find us?", options: draft.prompts[0]!.options });
		expect(next.prompts[1]).toBe(draft.prompts[1]);
		expect(draft.prompts[0]!.title).toBe(copy.draft.heardAbout.title);
	});

	it("changes only the final question's two titles: still required, pick one, one answer giving the member role", () => {
		const final = applied(applyPromptEdit(starterDraft(), 2, { title: "Welcome in!", finalOptionTitle: "I'm in" })).prompts[2]!;
		expect(final).toMatchObject({ title: "Welcome in!", singleSelect: true, required: true, isFinal: true });
		expect(final.options).toEqual([{ id: null, title: "I'm in", description: null, roleIds: [MEMBER_ROLE], channelIds: [], emoji: null }]);
	});

	it("refuses an empty or too long title, an empty final answer title, and a question no longer in the draft", () => {
		const draft = starterDraft();
		expect(applyPromptEdit(draft, 0, { title: "  " })).toEqual({ ok: false, reason: errors.emptyTitle });
		expect(applyPromptEdit(draft, 0, { title: "q".repeat(101) })).toEqual({ ok: false, reason: errors.titleTooLong(100) });
		expect(applyPromptEdit(draft, 2, { title: "Welcome", finalOptionTitle: " " })).toEqual({ ok: false, reason: errors.emptyOptionTitle });
		expect(applyPromptEdit(draft, 7, { title: "Anything" })).toEqual({ ok: false, reason: errors.promptGone });
	});

	it("adds a question with its first answer and its roles just before the final question, which stays last", () => {
		const next = applied(addPrompt(starterDraft(), "What do you play?", { title: "Chess", description: "Board games", roleIds: [GAMER_ROLE] }));
		expect(next.prompts.map((prompt) => prompt.isFinal)).toEqual([false, false, false, true]);
		expect(next.prompts[2]).toMatchObject({ title: "What do you play?", required: false, singleSelect: false });
		expect(next.prompts[2]!.options).toEqual([{ ...plainOption("Chess", "Board games"), roleIds: [GAMER_ROLE] }]);
	});

	it("refuses a question past the editor's 25", () => {
		const draft = starterDraft();
		const full = { ...draft, prompts: [...Array.from({ length: 24 }, () => draft.prompts[0]!), draft.prompts[2]!] };
		expect(addPrompt(full, "One more", { title: "A", description: "", roleIds: [] })).toEqual({ ok: false, reason: errors.tooManyPrompts(25) });
	});

	it("deletes a question in one call, and never the final question", () => {
		const draft = starterDraft();
		expect(applied(deletePrompt(draft, 1)).prompts.map((prompt) => prompt.title)).toEqual([copy.draft.heardAbout.title, copy.draft.final.title]);
		expect(deletePrompt(draft, 2)).toEqual({ ok: false, reason: errors.finalPromptFixed });
		expect(deletePrompt(draft, 9)).toEqual({ ok: false, reason: errors.promptGone });
	});
});

describe("the answer edits", () => {
	const withGames = (): PendingOnboardingDraft => {
		const draft = starterDraft();
		return { ...draft, prompts: draft.prompts.map((prompt, index) => (index === 0 ? { ...prompt, options: [gamesOption, plainOption("Chat")] } : prompt)) };
	};

	it("adds an answer with several roles at the end of its question", () => {
		const next = applied(saveAnswer(withGames(), 0, null, { title: "Art", description: "", roleIds: [ARTIST_ROLE, GAMER_ROLE] }));
		expect(next.prompts[0]!.options.at(-1)).toEqual({ ...plainOption("Art"), roleIds: [ARTIST_ROLE, GAMER_ROLE] });
	});

	it("edits an answer in place: new title, description and roles, keeping its id, channels and emoji", () => {
		const next = applied(saveAnswer(withGames(), 0, 0, { title: "Chess club", description: "", roleIds: [ARTIST_ROLE] }));
		expect(next.prompts[0]!.options[0]).toEqual({ ...gamesOption, title: "Chess club", description: null, roleIds: [ARTIST_ROLE] });
	});

	it("refuses a duplicate title, an empty title, a long description, the final question and a missing answer", () => {
		const draft = withGames();
		expect(saveAnswer(draft, 0, null, { title: "chat", description: "", roleIds: [] })).toEqual({ ok: false, reason: errors.duplicateOption("chat") });
		expect(saveAnswer(draft, 0, 1, { title: "Chat", description: "", roleIds: [] }).ok).toBe(true);
		expect(saveAnswer(draft, 0, null, { title: String.fromCharCode(0x200b), description: "", roleIds: [] })).toEqual({ ok: false, reason: errors.emptyOptionTitle });
		expect(saveAnswer(draft, 0, null, { title: "Long", description: "d".repeat(101), roleIds: [] })).toEqual({ ok: false, reason: errors.descriptionTooLong("Long", 100) });
		expect(saveAnswer(draft, 2, null, { title: "Sneaky", description: "", roleIds: [] })).toEqual({ ok: false, reason: errors.finalPromptFixed });
		expect(saveAnswer(draft, 0, 7, { title: "Gone", description: "", roleIds: [] })).toEqual({ ok: false, reason: errors.optionGone });
	});

	it("deletes an answer in one call, but never a question's last answer or the final question's", () => {
		const draft = withGames();
		const next = applied(deleteAnswer(draft, 0, 0));
		expect(next.prompts[0]!.options).toEqual([plainOption("Chat")]);
		expect(deleteAnswer(next, 0, 0)).toEqual({ ok: false, reason: errors.lastOption });
		expect(deleteAnswer(draft, 2, 0)).toEqual({ ok: false, reason: errors.finalPromptFixed });
	});

	it("checks every picked role the way the member role is checked: never @everyone, still there, below Dero", () => {
		const guild = makeGuild() as never;
		expect(refuseAnswerRoles(guild, [GAMER_ROLE, ARTIST_ROLE])).toBeNull();
		expect(refuseAnswerRoles(guild, [GAMER_ROLE, HIGH_ROLE])).toBe(errors.roleAboveBot("Moderator"));
		expect(refuseAnswerRoles(guild, [EVERYONE])).toBe(errors.roleIsEveryone);
		expect(refuseAnswerRoles(guild, ["role-deleted"])).toBe(errors.roleGone);
	});

	it("finds a role given by answers in more than one question, but not one given twice inside a single question", () => {
		const draft = withGames();
		expect(rolesReusedAcrossPrompts(draft.prompts)).toEqual([]);
		const twiceInOne = applied(saveAnswer(draft, 0, 1, { title: "Chat", description: "", roleIds: [GAMER_ROLE] }));
		expect(rolesReusedAcrossPrompts(twiceInOne.prompts)).toEqual([]);
		const acrossTwo = applied(saveAnswer(draft, 1, 0, { title: "Play games", description: "", roleIds: [GAMER_ROLE] }));
		expect(rolesReusedAcrossPrompts(acrossTwo.prompts)).toEqual([GAMER_ROLE]);
	});
});

// ── the modals ──

describe("the modals", () => {
	type LabelJson = { component: { custom_id: string; type: number; value?: string; max_length?: number; required?: boolean; min_values?: number; max_values?: number; default_values?: Array<{ id: string }> } };
	const componentsOf = (modal: { toJSON(): unknown }) => (modal.toJSON() as { components: LabelJson[] }).components.map((label) => label.component);

	it("edits an answer with its title, its description and a role select of several roles, preloaded", () => {
		const fields = componentsOf(buildAnswerModal("m", 1, gamesOption)!);
		expect(fields.map((field) => field.custom_id)).toEqual(["option_title", "option_description", "option_roles"]);
		expect(fields[0]).toMatchObject({ value: "Chess", max_length: 50, required: true });
		expect(fields[1]).toMatchObject({ value: "Board games", max_length: 100, required: false });
		expect(fields[2]).toMatchObject({ min_values: 0, max_values: 25, required: false, default_values: [expect.objectContaining({ id: GAMER_ROLE })] });
	});

	it("adds a question with its first answer in four of a modal's five components", () => {
		expect(componentsOf(buildAddPromptModal("m")).map((field) => field.custom_id)).toEqual(["prompt_title", "option_title", "option_description", "option_roles"]);
	});

	it("gives an optional question only its title, and the final question its title and its one answer's title", () => {
		const draft = starterDraft();
		expect(componentsOf(buildPromptEditModal("m", draft.prompts[0]!, 1)!).map((field) => field.custom_id)).toEqual(["prompt_title"]);
		const final = componentsOf(buildPromptEditModal("m", draft.prompts[2]!, 3)!);
		expect(final.map((field) => field.custom_id)).toEqual(["prompt_title", "final_option_title"]);
		expect(final[1]).toMatchObject({ value: "Glad to be here", max_length: 50, style: TextInputStyle.Short });
	});

	it("offers no modal for an answer longer than its edit box", () => {
		expect(buildAnswerModal("m", 1, { ...gamesOption, description: "d".repeat(101) })).toBeNull();
	});
});

// ── the round trip ──

describe("the review's editor", () => {
	it("shows a question's controls and its answer select once it is picked, and an answer's once that is picked", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await pick(guild, "pickPrompt", 0);
		const revision = currentRevision();
		expect(customIdsOf(latestReview!)).toEqual([
			`community:pickprompt:${revision}`,
			`community:editprompt:${revision}:0`,
			`community:deleteprompt:${revision}:0`,
			`community:addoption:${revision}:0`,
			`community:pickoption:${revision}:0`,
			`community:addprompt:${revision}`,
			COMMUNITY_CUSTOM_IDS.confirmOnboarding,
			COMMUNITY_CUSTOM_IDS.cancelOnboarding,
		]);
		await pick(guild, "pickOption", 2, 0);
		expect(customIdsOf(latestReview!)).toContain(`community:deleteoption:${revision}:0:2`);
		expect(latestReview!.components).toHaveLength(5);
	});

	it("gives the final question only Edit question, so its shape and member role cannot change", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await pick(guild, "pickPrompt", 2);
		const ids = customIdsOf(latestReview!);
		expect(ids.some((id) => id.startsWith("community:editprompt:") && id.endsWith(":2"))).toBe(true);
		expect(ids.some((id) => /deleteprompt|addoption|pickoption/.test(id))).toBe(false);
	});

	it("keeps an answer's roles through Confirm into the editOnboarding payload", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await pick(guild, "pickPrompt", 0);
		await pressControl(guild, controlId("addOption", 0), { submit: answer("Artist", [ARTIST_ROLE, GAMER_ROLE], "I draw") });
		await pick(guild, "pickOption", 0, 0);
		await pressControl(guild, controlId("editOption", 0, 0), { submit: answer("Friend", [GAMER_ROLE]) });

		const payload = await confirmPayload(guild);
		const options = payload.prompts[0]!.options;
		expect(options[0]).toMatchObject({ title: "Friend", roles: [GAMER_ROLE] });
		expect(options.at(-1)).toMatchObject({ title: "Artist", description: "I draw", roles: [ARTIST_ROLE, GAMER_ROLE] });
		expect(payload.prompts.at(-1)!.options).toEqual([expect.objectContaining({ roles: [MEMBER_ROLE] })]);
	});

	it("marks a role reused across two questions with ⚠️ and one warning line, and still lets Confirm write it", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await pick(guild, "pickPrompt", 0);
		await pressControl(guild, controlId("addOption", 0), { submit: answer("Gamer", [GAMER_ROLE]) });
		await pick(guild, "pickPrompt", 1);
		await pressControl(guild, controlId("addOption", 1), { submit: answer("Games night", [GAMER_ROLE]) });

		const embed = latestReview!.embeds![0]!.data;
		expect(embed.description!.split("\n").filter((line) => line.startsWith("⚠️"))).toEqual([
			`⚠️ <@&${GAMER_ROLE}> is given by answers in more than one question, so a member can get it from either.`,
		]);
		expect(embed.fields![0]!.value).toContain(`gives ⚠️ <@&${GAMER_ROLE}>`);
		expect(embed.fields![1]!.value).toContain(`gives ⚠️ <@&${GAMER_ROLE}>`);
		expect((await confirmPayload(guild)).prompts).toHaveLength(3);
	});

	it("deletes a question in one press, and the review and the write follow", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await pick(guild, "pickPrompt", 1);
		const { interaction } = await pressControl(guild, controlId("deletePrompt", 1));

		expect(interaction.update).toHaveBeenCalledOnce();
		expect(interaction.showModal).not.toHaveBeenCalled();
		expect(fieldNames(latestReview!)).toEqual([`1. ${copy.draft.heardAbout.title}`, `2. ${copy.draft.final.title}`]);
		expect((await confirmPayload(guild)).prompts.map((prompt) => prompt.title)).toEqual([copy.draft.heardAbout.title, copy.draft.final.title]);
	});

	it("deletes an answer in one press", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await pick(guild, "pickPrompt", 0);
		await pick(guild, "pickOption", 0, 0);
		const { interaction } = await pressControl(guild, controlId("deleteOption", 0, 0));

		expect(interaction.update).toHaveBeenCalledOnce();
		expect((await confirmPayload(guild)).prompts[0]!.options.map((option) => option.title)).toEqual(copy.draft.heardAbout.options.slice(1));
	});

	it("adds a question before the final one, with its first answer's roles", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await pressControl(guild, controlId("addPrompt"), { submit: { text: { prompt_title: "What do you play?", option_title: "Chess" }, roles: [GAMER_ROLE] } });

		const payload = await confirmPayload(guild);
		expect(payload.prompts.map((prompt) => prompt.title)).toEqual([copy.draft.heardAbout.title, copy.draft.goals.title, "What do you play?", copy.draft.final.title]);
		expect(payload.prompts[2]!.options).toEqual([expect.objectContaining({ title: "Chess", roles: [GAMER_ROLE] })]);
	});

	it("renames the final question and keeps its member role through Confirm", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await pressControl(guild, controlId("editPrompt", 2), { submit: { text: { prompt_title: "Welcome to the crew", final_option_title: "Count me in" } } });

		const payload = await confirmPayload(guild);
		expect(payload.prompts[2]).toMatchObject({ title: "Welcome to the crew", singleSelect: true, required: true });
		expect(payload.prompts[2]!.options).toEqual([expect.objectContaining({ title: "Count me in", roles: [MEMBER_ROLE] })]);
	});

	it("refuses a role above Dero at submit, privately, and leaves the draft as it was", async () => {
		const guild = makeGuild();
		await openReview(guild);
		const { submitted } = await pressControl(guild, controlId("addOption", 0), { submit: answer("Mods", [HIGH_ROLE]) });

		expect(submitted.update).not.toHaveBeenCalled();
		expect(refusalText(submitted)).toBe(errors.roleAboveBot("Moderator"));
		expect((await confirmPayload(guild)).prompts[0]!.options.map((option) => option.title)).toEqual([...copy.draft.heardAbout.options]);
	});

	it("gates the submit again: an admin who lost the role while the modal was open changes nothing", async () => {
		const guild = makeGuild();
		await openReview(guild, ADMIN);
		const { interaction, submitted } = press(guild, ADMIN, controlId("editPrompt", 0), { submit: { text: { prompt_title: "Hijacked" } } });
		interaction.showModal.mockImplementationOnce(async () => {
			guild.members.cache.set(ADMIN, { roles: { cache: new Set<string>() } });
		});
		await handleCommunityButton(interaction);

		expect(submitted!.update).not.toHaveBeenCalled();
		expect(refusalText(submitted!)).toBe(rokCommanderCopy.responses.noWizardPowers);
	});

	it("refuses a submit after the draft moved on, such as after a fresh Configure Onboarding press", async () => {
		const guild = makeGuild();
		await openReview(guild);
		const { interaction, submitted } = press(guild, OWNER, controlId("editPrompt", 0), { submit: { text: { prompt_title: "Late edit" } } });
		interaction.showModal.mockImplementationOnce(async () => {
			await openReview(guild);
		});
		await handleCommunityButton(interaction);

		expect(submitted!.update).not.toHaveBeenCalled();
		expect(refusalText(submitted!)).toBe(errors.promptGone);
	});

	it("refuses a control from an older review, so it can never delete the wrong question", async () => {
		const guild = makeGuild();
		await openReview(guild);
		const staleDelete = controlId("deletePrompt", 0);
		await pressControl(guild, controlId("deletePrompt", 1));

		const { interaction } = await pressControl(guild, staleDelete);
		expect(interaction.update).not.toHaveBeenCalled();
		expect(refusalText(interaction)).toBe(errors.reviewOutdated);
		expect((await confirmPayload(guild)).prompts).toHaveLength(2);
	});

	it("answers a control with no draft as expired, and the old Edit button and a bare id as retired", async () => {
		const guild = makeGuild();
		const { interaction: noDraft } = press(guild, OWNER, reviewControlCustomId("deletePrompt", 1, 0));
		await handleCommunityButton(noDraft);
		expect(refusalText(noDraft)).toBe(copy.expired);

		await openReview(guild);
		for (const retired of ["community:editprompt:0", COMMUNITY_CUSTOM_IDS.editPrompt]) {
			const { interaction } = press(guild, OWNER, retired);
			await handleCommunityButton(interaction);
			expect(interaction.reply).not.toHaveBeenCalled();
			expect(refusalText(interaction)).toBe(communityCopy.errors.controlRetired);
		}
	});

	it("answers a select's action pressed as a button as retired", async () => {
		const guild = makeGuild();
		await openReview(guild);
		const { interaction } = press(guild, OWNER, controlId("pickPrompt"));
		await handleCommunityButton(interaction);
		expect(refusalText(interaction)).toBe(communityCopy.errors.controlRetired);
	});

	it("keeps a live answer's id, channels and emoji through an edit of its roles", async () => {
		const guild = makeGuild();
		guild.fetchOnboarding.mockResolvedValueOnce({
			enabled: true,
			prompts: new Collection([
				[
					"prompt-live",
					{
						id: "prompt-live",
						title: "Games",
						singleSelect: false,
						required: false,
						inOnboarding: true,
						type: GuildOnboardingPromptType.Dropdown,
						options: new Collection([
							[
								"option-chess",
								{ id: "option-chess", title: "Chess", description: "Board games", roles: new Collection([[GAMER_ROLE, undefined]]), channels: new Collection([["a", undefined]]), emoji: null },
							],
						]),
					},
				],
			]),
			defaultChannels: new Collection(),
		} as never);
		await openReview(guild);
		await pick(guild, "pickPrompt", 0);
		await pick(guild, "pickOption", 0, 0);
		const { interaction } = await pressControl(guild, controlId("editOption", 0, 0), { submit: answer("Chess", [GAMER_ROLE, ARTIST_ROLE], "Board games") });
		const modal = (interaction.showModal.mock.calls[0]![0] as { toJSON(): { components: Array<{ component: { custom_id: string; value?: string } }> } }).toJSON();
		expect(modal.components[0]!.component.value).toBe("Chess");

		const payload = await confirmPayload(guild);
		expect(payload.prompts[0]!.options).toEqual([expect.objectContaining({ id: "option-chess", title: "Chess", roles: [GAMER_ROLE, ARTIST_ROLE], channels: ["a"] })]);
	});
});
