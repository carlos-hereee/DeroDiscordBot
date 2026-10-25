import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, Collection, GuildOnboardingPromptType, PermissionFlagsBits, TextInputStyle, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

// ── promptEditModal (2026-10 item 247 Phase 4) ──────────────────────────────
// The answers box format and its checks, the edit applied to the draft (a changed
// question, a removed one, and the final question whose shape and member role no
// edit can change), the modal each Edit button opens, and the round trip the way
// it arrives: Edit, submit, and the review redrawn in place, then Confirm writing
// what the owner edited.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: vi.fn() }));

import { handleCommunityButton } from "./communityButtons.js";
import { COMMUNITY_CUSTOM_IDS, editPromptCustomId } from "./communityControls.js";
import { communityCopy } from "./communityCopy.js";
import { buildOnboardingDraft, plainOption, type IDraftOption, type IDraftPrompt, type PendingOnboardingDraft } from "./onboardingDraft.js";
import { applyPromptEdit, buildPromptEditModal, parseOptionLines, serializeOptions } from "./promptEditModal.js";

const OWNER = "owner-1";
const ADMIN = "admin-1";
const EVERYONE = "everyone-role";
const MEMBER_ROLE = "role-member";
const GAMER_ROLE = "role-gamer";
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
			]),
		},
		members: {
			me: { permissions: { has: () => true }, roles: { highest: { position: 5 } } },
			cache: new Map([[ADMIN, { roles: { cache: new Set(["role-admin"]) } }]]),
			fetch: vi.fn(async () => null),
		},
		channels: { cache: channels },
		fetchOnboarding: vi.fn(async () => ({ enabled: false, prompts: new Collection(), defaultChannels: new Collection() })),
		editOnboarding: vi.fn(async () => ({})),
		fetchOwner: vi.fn(async () => ({ send: vi.fn(async () => undefined) })),
	};
}

type FakeGuild = ReturnType<typeof makeGuild>;

function submission(guild: FakeGuild, userId: string, customId: string, values: Record<string, string>) {
	return {
		guild,
		user: { id: userId },
		customId,
		fields: { fields: new Map(Object.keys(values).map((key) => [key, {}])), getTextInputValue: (key: string) => values[key] ?? "" },
		isFromMessage: () => true,
		update: vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
	} as unknown as ModalSubmitInteraction & { update: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> };
}

// A press whose modal, if it opens one, is submitted with these values. The fake
// collector applies the real filter, so a submit for another modal is not heard.
function press(guild: FakeGuild, userId: string, customId: string, submitValues: Record<string, string> | null = null, submitter = userId) {
	interactionCounter += 1;
	const id = `int-${interactionCounter}`;
	const submitted = submitValues ? submission(guild, submitter, `community:promptmodal:${id}`, submitValues) : null;
	const interaction = {
		id,
		customId,
		guild,
		user: { id: userId },
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
	return { interaction: interaction as unknown as ButtonInteraction & Record<keyof typeof interaction, ReturnType<typeof vi.fn>>, submitted };
}

interface ISentMessage {
	content?: string;
	embeds?: Array<{ data: { title?: string; description?: string; fields?: Array<{ name: string; value: string }> } }>;
	components?: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>;
}

const sent = (fn: ReturnType<typeof vi.fn>, call = 0): ISentMessage => fn.mock.calls[call]![0] as ISentMessage;
// What a refused press was told: the notice modal's text (post-launch plan item 9),
// or the private reply's when no notice opened, as after a modal submit.
type NoticeJson = { custom_id: string; components: Array<{ content?: string }> };
const noticeModals = (interaction: { showModal?: ReturnType<typeof vi.fn> }): NoticeJson[] =>
	(interaction.showModal?.mock.calls ?? [])
		.map((call) => (call[0] as { toJSON(): unknown }).toJSON() as NoticeJson)
		.filter((modal) => modal.custom_id.startsWith("notice:"));
const refusalText = (interaction: { showModal?: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> }): string | undefined => {
	const [notice] = noticeModals(interaction);
	if (notice) return notice.components.map((component) => component.content).join("\n");
	return sent(interaction.reply).embeds?.[0]?.data.description;
};
const fieldNames = (message: ISentMessage): string[] => message.embeds![0]!.data.fields!.map((field) => field.name);
const customIdsOf = (message: ISentMessage): Array<string | undefined> =>
	(message.components ?? []).flatMap((row) => row.toJSON().components.map((component) => component.custom_id));

interface IModalInput {
	custom_id: string;
	style: TextInputStyle;
	value?: string;
	max_length?: number;
	required?: boolean;
}
const modalInputs = (fn: ReturnType<typeof vi.fn>): IModalInput[] =>
	(fn.mock.calls[0]![0] as { toJSON(): { components: Array<{ component: IModalInput }> } }).toJSON().components.map((label) => label.component);

async function openReview(guild: FakeGuild, userId = OWNER) {
	const { interaction } = press(guild, userId, COMMUNITY_CUSTOM_IDS.configure);
	await handleCommunityButton(interaction);
	return interaction;
}

async function edit(guild: FakeGuild, index: number, values: Record<string, string>, userId = OWNER, submitter = userId) {
	const { interaction, submitted } = press(guild, userId, editPromptCustomId(index), values, submitter);
	await handleCommunityButton(interaction);
	return { interaction, submitted: submitted! };
}

async function confirmPayload(guild: FakeGuild) {
	const { interaction } = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.confirmOnboarding);
	await handleCommunityButton(interaction);
	return guild.editOnboarding.mock.calls[0]![0] as { prompts: Array<{ title: string; singleSelect: boolean; required: boolean; options: Array<{ title: string; description: string | null; roles: string[] }> }> };
}

function starterDraft(): PendingOnboardingDraft {
	const result = buildOnboardingDraft({ guild: makeGuild() as never, stored: { memberRoleId: MEMBER_ROLE, introChannelId: "intro" }, copy, current: null });
	if (!result.ok) throw new Error(result.reason);
	return result.draft;
}

const gamesOption: IDraftOption = { ...plainOption("Chess", "Board games"), id: "option-chess", roleIds: [GAMER_ROLE], channelIds: ["a"], emoji: "♟️" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId.mockResolvedValue({ adminRoleId: "role-admin", memberRoleId: MEMBER_ROLE, introChannelId: "intro" });
	mocks.log.mockResolvedValue(undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the answers box", () => {
	it("round trips: serialized answers parse back to the same answers, attachments kept", () => {
		const options = [gamesOption, plainOption("Chat")];
		const text = serializeOptions(options);
		expect(text).toBe("Chess | Board games\nChat");
		expect(parseOptionLines(text, options)).toEqual({ ok: true, options });
	});

	it("matches answers by title, ignoring case, so removing a line never moves a role onto another answer", () => {
		const previous = [plainOption("Lurk"), gamesOption, plainOption("Chat")];
		const parsed = parseOptionLines("chess | Still board games\n\nChat", previous);
		expect(parsed).toEqual({ ok: true, options: [{ ...gamesOption, title: "chess", description: "Still board games" }, plainOption("Chat")] });
	});

	it("gives a renamed or new answer nothing", () => {
		const parsed = parseOptionLines("Checkers | Board games", [gamesOption]);
		expect(parsed).toEqual({ ok: true, options: [plainOption("Checkers", "Board games")] });
	});

	it("reads an answer with no spaces around the bar, and keeps later bars in the description", () => {
		expect(parseOptionLines("Lurk|Just reading | for now", [])).toEqual({ ok: true, options: [plainOption("Lurk", "Just reading | for now")] });
	});

	it("refuses an answer with no title, too long a title or description, a duplicate, or too many answers", () => {
		expect(parseOptionLines("| only a description", [])).toEqual({ ok: false, reason: errors.emptyOptionTitle });
		const zeroWidth = String.fromCharCode(0x200b);
		expect(parseOptionLines(`${zeroWidth}${zeroWidth} | invisible`, [])).toEqual({ ok: false, reason: errors.emptyOptionTitle });
		expect(parseOptionLines("x".repeat(51), [])).toEqual({ ok: false, reason: errors.optionTitleTooLong("x".repeat(51), 50) });
		expect(parseOptionLines(`Chat | ${"y".repeat(101)}`, [])).toEqual({ ok: false, reason: errors.descriptionTooLong("Chat", 100) });
		expect(parseOptionLines("Chat\nchat", [])).toEqual({ ok: false, reason: errors.duplicateOption("chat") });
		const tooMany = Array.from({ length: 51 }, (_, index) => `Answer ${index}`).join("\n");
		expect(parseOptionLines(tooMany, [])).toEqual({ ok: false, reason: errors.tooManyOptions(50) });
	});
});

describe("applyPromptEdit", () => {
	it("changes an optional question's title and answers and leaves every other question the same object", () => {
		const draft = starterDraft();
		const result = applyPromptEdit(draft, 0, { title: "How did you find us?", optionsText: "Friend | Someone invited me\nSearch" });
		if (!result.ok) throw new Error(result.reason);
		expect(result.draft.prompts[0]).toMatchObject({ title: "How did you find us?", singleSelect: false, required: false });
		expect(result.draft.prompts[0]!.options).toEqual([{ ...draft.prompts[0]!.options[0]!, description: "Someone invited me" }, plainOption("Search")]);
		expect(result.draft.prompts[1]).toBe(draft.prompts[1]);
		expect(result.draft.prompts[2]).toBe(draft.prompts[2]);
		expect(draft.prompts[0]!.title).toBe(copy.draft.heardAbout.title);
	});

	it("removes an optional question when every answer is cleared, even with the title cleared too", () => {
		const draft = starterDraft();
		const result = applyPromptEdit(draft, 1, { title: "", optionsText: "\n  \n" });
		expect(result.ok && result.draft.prompts.map((prompt) => prompt.title)).toEqual([copy.draft.heardAbout.title, copy.draft.final.title]);
	});

	it("refuses an empty or too long question title", () => {
		const draft = starterDraft();
		expect(applyPromptEdit(draft, 0, { title: "  ", optionsText: "Friend" })).toEqual({ ok: false, reason: errors.emptyTitle });
		expect(applyPromptEdit(draft, 0, { title: "q".repeat(101), optionsText: "Friend" })).toEqual({ ok: false, reason: errors.titleTooLong(100) });
	});

	it("changes only the final question's two titles: still required, pick one, one answer giving the member role", () => {
		const draft = starterDraft();
		const result = applyPromptEdit(draft, 2, { title: "Welcome in!", finalOptionTitle: "I'm in", optionsText: "Sneaky | extra answer" });
		if (!result.ok) throw new Error(result.reason);
		const final = result.draft.prompts[2]!;
		expect(final).toMatchObject({ title: "Welcome in!", singleSelect: true, required: true, isFinal: true });
		expect(final.options).toEqual([{ id: null, title: "I'm in", description: null, roleIds: [MEMBER_ROLE], channelIds: [], emoji: null }]);
	});

	it("refuses an empty final answer title, and a question that is no longer in the draft", () => {
		const draft = starterDraft();
		expect(applyPromptEdit(draft, 2, { title: "Welcome", finalOptionTitle: " " })).toEqual({ ok: false, reason: errors.emptyOptionTitle });
		expect(applyPromptEdit(draft, 7, { title: "Anything", optionsText: "A" })).toEqual({ ok: false, reason: errors.promptGone });
	});
});

describe("buildPromptEditModal", () => {
	const inputsOf = (prompt: IDraftPrompt, position: number) => {
		const modal = buildPromptEditModal("community:promptmodal:x", prompt, position)!;
		return { json: modal.toJSON(), inputs: modal.toJSON().components.map((label) => (label as unknown as { component: IModalInput }).component) };
	};

	it("preloads an optional question's title and its answers, one a line", () => {
		const draft = starterDraft();
		const { json, inputs } = inputsOf(draft.prompts[0]!, 1);
		expect(json.title).toBe("Edit question 1");
		expect(inputs).toEqual([
			expect.objectContaining({ custom_id: "prompt_title", style: TextInputStyle.Short, value: copy.draft.heardAbout.title, max_length: 100, required: true }),
			expect.objectContaining({ custom_id: "prompt_options", style: TextInputStyle.Paragraph, value: "Friend\nTwitter\nReddit\nYouTube\nOther", required: false }),
		]);
	});

	it("gives the final question only its title and its one answer's title, so no answer can be added or unhooked", () => {
		const draft = starterDraft();
		const { json, inputs } = inputsOf(draft.prompts[2]!, 3);
		expect(json.title).toBe(copy.modal.finalTitle);
		expect(inputs.map((input) => input.custom_id)).toEqual(["prompt_title", "final_option_title"]);
		expect(inputs[1]).toMatchObject({ value: "Glad to be here", max_length: 50, style: TextInputStyle.Short });
	});

	it("offers no modal for a question whose answers would not fit one edit box", () => {
		const long = { ...starterDraft().prompts[0]!, options: Array.from({ length: 50 }, (_, index) => plainOption(`Answer number ${index} with a long name`, "d".repeat(80))) };
		expect(buildPromptEditModal("id", long, 1)).toBeNull();
	});
});

describe("the edit round trip", () => {
	it("Edit on the final question, then submit: the review redraws in place and Confirm writes the new titles with the member role", async () => {
		const guild = makeGuild();
		await openReview(guild);
		const { interaction, submitted } = await edit(guild, 2, { prompt_title: "Welcome to the crew", final_option_title: "Count me in" });

		expect(interaction.showModal).toHaveBeenCalledOnce();
		expect(modalInputs(interaction.showModal).map((input) => input.custom_id)).toEqual(["prompt_title", "final_option_title"]);
		expect(submitted.update).toHaveBeenCalledOnce();
		const review = sent(submitted.update);
		expect(fieldNames(review)).toEqual([`1. ${copy.draft.heardAbout.title}`, `2. ${copy.draft.goals.title}`, "3. Welcome to the crew"]);
		expect(review.embeds![0]!.data.fields![2]!.value).toContain("Count me in");

		const payload = await confirmPayload(guild);
		expect(payload.prompts[2]).toMatchObject({ title: "Welcome to the crew", singleSelect: true, required: true });
		expect(payload.prompts[2]!.options).toEqual([expect.objectContaining({ title: "Count me in", roles: [MEMBER_ROLE] })]);
	});

	it("Edit on an optional question changes its answers; clearing one removes it and the Edit buttons follow", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await edit(guild, 0, { prompt_title: "Where from?", prompt_options: "Friend | Someone invited me\nSearch" });
		const { submitted } = await edit(guild, 1, { prompt_title: copy.draft.goals.title, prompt_options: "" });

		const review = sent(submitted.update);
		expect(fieldNames(review)).toEqual(["1. Where from?", `2. ${copy.draft.final.title}`]);
		expect(customIdsOf(review)).toEqual(["community:editprompt:0", "community:editprompt:1", COMMUNITY_CUSTOM_IDS.confirmOnboarding, COMMUNITY_CUSTOM_IDS.cancelOnboarding]);

		const payload = await confirmPayload(guild);
		expect(payload.prompts.map((prompt) => prompt.title)).toEqual(["Where from?", copy.draft.final.title]);
		expect(payload.prompts[0]!.options.map((option) => [option.title, option.description])).toEqual([
			["Friend", "Someone invited me"],
			["Search", null],
		]);
	});

	it("a refused submit answers privately and leaves the draft as it was", async () => {
		const guild = makeGuild();
		await openReview(guild);
		const { submitted } = await edit(guild, 0, { prompt_title: "Where from?", prompt_options: "Chat\nchat" });
		expect(submitted.update).not.toHaveBeenCalled();
		expect(refusalText(submitted)).toBe(errors.duplicateOption("chat"));

		const payload = await confirmPayload(guild);
		expect(payload.prompts[0]!.title).toBe(copy.draft.heardAbout.title);
	});

	it("gates the submit again: an admin who lost the role while the modal was open changes nothing", async () => {
		const guild = makeGuild();
		await openReview(guild, ADMIN);
		const { interaction, submitted } = press(guild, ADMIN, editPromptCustomId(0), { prompt_title: "Hijacked", prompt_options: "A" });
		interaction.showModal.mockImplementationOnce(async () => {
			guild.members.cache.set(ADMIN, { roles: { cache: new Set<string>() } });
		});
		await handleCommunityButton(interaction);

		expect(submitted!.update).not.toHaveBeenCalled();
		expect(refusalText(submitted!)).toBe(rokCommanderCopy.responses.noWizardPowers);
	});

	it("refuses a submit for a question the draft has moved past, such as after a fresh Configure Onboarding press", async () => {
		const guild = makeGuild();
		await openReview(guild);
		const { interaction, submitted } = press(guild, OWNER, editPromptCustomId(0), { prompt_title: "Late edit", prompt_options: "A" });
		interaction.showModal.mockImplementationOnce(async () => {
			await openReview(guild);
		});
		await handleCommunityButton(interaction);

		expect(submitted!.update).not.toHaveBeenCalled();
		expect(refusalText(submitted!)).toBe(errors.promptGone);
	});

	it("answers an Edit with no draft as expired, an Edit past the last question as gone, and a bare Edit id as retired", async () => {
		const guild = makeGuild();
		const { interaction: noDraft } = press(guild, OWNER, editPromptCustomId(0));
		await handleCommunityButton(noDraft);
		expect(refusalText(noDraft)).toBe(copy.expired);

		await openReview(guild);
		const { interaction: past } = press(guild, OWNER, editPromptCustomId(9));
		await handleCommunityButton(past);
		expect(past.showModal.mock.calls).toHaveLength(noticeModals(past).length);
		expect(refusalText(past)).toBe(errors.promptGone);

		const { interaction: bare } = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.editPrompt);
		await handleCommunityButton(bare);
		expect(bare.reply).not.toHaveBeenCalled();
		expect(refusalText(bare)).toBe(communityCopy.errors.controlRetired);
	});

	it("keeps a live question's own answers and attachments through an edit that only renames it", async () => {
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
		const { interaction } = await edit(guild, 0, { prompt_title: "Your games", prompt_options: "Chess | Board games" });
		expect(modalInputs(interaction.showModal)[1]!.value).toBe("Chess | Board games");

		const payload = await confirmPayload(guild);
		expect(payload.prompts[0]).toMatchObject({ title: "Your games", options: [expect.objectContaining({ id: "option-chess", title: "Chess", roles: [GAMER_ROLE], channels: ["a"] })] });
	});
});
