import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	ChannelType,
	Collection,
	DiscordAPIError,
	GuildOnboardingMode,
	GuildOnboardingPromptType,
	MessageFlags,
	PermissionFlagsBits,
	type ButtonInteraction,
	type ModalSubmitInteraction,
} from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";

// ── configureOnboarding (2026-10 item 247 Phase 4) ──────────────────────────
// The Configure Onboarding round trip through the router, the way a press arrives:
// a precondition refusal with its exact sentence and audit row, the review with
// one Edit button per question, the already configured path that shows the
// server's own questions instead of overwriting them, Confirm's one
// guild.editOnboarding call with the full payload, the checks Confirm runs again,
// a 50013 and a 400 keeping the draft for a retry, Cancel, and the owner DM.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: vi.fn() }));

import { handleCommunityButton } from "./communityButtons.js";
import { COMMUNITY_CUSTOM_IDS } from "./communityControls.js";
import { communityCopy } from "./communityCopy.js";
import { ONBOARDING_DRAFT_TTL_MS } from "./configureOnboarding.js";

const OWNER = "owner-1";
const ADMIN = "admin-1";
const MEMBER = "member-1";
const EVERYONE = "everyone-role";
const MEMBER_ROLE = "role-member";
const copy = communityCopy.onboarding;

const storedRow = { adminRoleId: "role-admin", memberRoleId: MEMBER_ROLE, introChannelId: "intro" };

// Every test gets its own guild id: drafts wait in a module level map keyed by guild
// and user, so a shared id would let one test's leftover draft reach the next.
let guildCounter = 0;
let interactionCounter = 0;

interface IGuildOptions {
	features?: string[];
	sendableChannels?: number;
	memberRolePosition?: number;
	live?: unknown;
	/** Channels or categories @everyone cannot send in, each with whether a new member can open it. */
	extraChannels?: Array<{ id: string; name: string; type: ChannelType; viewable: boolean }>;
}

// A channel whose resolved @everyone permissions are read through permissionsFor: a
// single flag asks about viewing, a list about viewing and sending together.
function fakeChannel(id: string, name: string, type: ChannelType, viewable: boolean, sendable: boolean) {
	return {
		id,
		name,
		type,
		permissionsFor: (role: { id: string }) => ({
			has: (flags: bigint | bigint[]) => {
				if (role.id !== EVERYONE) return false;
				const asked = Array.isArray(flags) ? flags : [flags];
				return asked.every((flag) => (flag === PermissionFlagsBits.ViewChannel ? viewable : sendable));
			},
		}),
	};
}

// A live config with no questions and no defaults: a Community server that never
// set up Onboarding.
const emptyOnboarding = () => ({ enabled: false, prompts: new Collection(), defaultChannels: new Collection() });

function makeGuild(options: IGuildOptions = {}) {
	guildCounter += 1;
	const channelIds = ["intro", ...Array.from({ length: (options.sendableChannels ?? 6) - 1 }, (_, index) => `open-${index}`)];
	const channels = new Map<string, ReturnType<typeof fakeChannel>>(channelIds.map((id) => [id, fakeChannel(id, id, ChannelType.GuildText, true, true)]));
	for (const extra of options.extraChannels ?? []) channels.set(extra.id, fakeChannel(extra.id, extra.name, extra.type, extra.viewable, false));
	const owner = { send: vi.fn(async () => undefined) };
	return {
		id: `g${guildCounter}`,
		ownerId: OWNER,
		features: options.features ?? ["COMMUNITY"],
		roles: { everyone: { id: EVERYONE }, cache: new Map([[MEMBER_ROLE, { id: MEMBER_ROLE, name: "Member", position: options.memberRolePosition ?? 2 }]]) },
		members: {
			me: { permissions: { has: () => true }, roles: { highest: { position: 5 } } },
			cache: new Map([[ADMIN, { roles: { cache: new Set(["role-admin"]) } }]]),
			fetch: vi.fn(async () => null),
		},
		channels: { cache: channels },
		fetchOnboarding: vi.fn(async () => options.live ?? emptyOnboarding()),
		editOnboarding: vi.fn(async () => ({})),
		fetchOwner: vi.fn(async () => owner),
		owner,
	};
}

type FakeGuild = ReturnType<typeof makeGuild>;

function press(guild: FakeGuild, userId: string, customId: string) {
	interactionCounter += 1;
	return {
		id: `int-${interactionCounter}`,
		customId,
		guild,
		user: { id: userId },
		reply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
		update: vi.fn(async () => undefined),
		showModal: vi.fn(async () => undefined),
	} as unknown as ButtonInteraction & Record<"reply" | "deferReply" | "editReply" | "deferUpdate" | "update" | "showModal", ReturnType<typeof vi.fn>>;
}

interface ISentMessage {
	content?: string;
	embeds?: Array<{ data: { title?: string; description?: string; fields?: Array<{ name: string; value: string }> } }>;
	components?: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>;
	flags?: number;
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
const customIdsOf = (message: ISentMessage): Array<string | undefined> =>
	(message.components ?? []).flatMap((row) => row.toJSON().components.map((component) => component.custom_id));
const auditRows = (event: string): Array<Record<string, unknown>> =>
	mocks.log.mock.calls.filter((call) => call[1] === event).map((call) => call[2] as Record<string, unknown>);

async function openReview(guild: FakeGuild, userId = OWNER) {
	const interaction = press(guild, userId, COMMUNITY_CUSTOM_IDS.configure);
	await handleCommunityButton(interaction);
	return interaction;
}

// The review's Confirm: it opens the confirm modal (2026-10 item 263 R3-20) and writes nothing.
async function pressConfirm(guild: FakeGuild, userId = OWNER) {
	const interaction = press(guild, userId, COMMUNITY_CUSTOM_IDS.confirmOnboarding);
	await handleCommunityButton(interaction);
	return interaction;
}

// The confirm modal's Submit, opened from the review message, so it updates that message.
async function submitConfirm(guild: FakeGuild, userId = OWNER) {
	interactionCounter += 1;
	const interaction = {
		id: `int-${interactionCounter}`,
		customId: COMMUNITY_CUSTOM_IDS.writeOnboarding,
		guild,
		user: { id: userId },
		fields: { getTextInputValue: vi.fn() },
		isFromMessage: () => true,
		reply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
	} as unknown as ModalSubmitInteraction & Record<"reply" | "followUp" | "editReply" | "deferUpdate", ReturnType<typeof vi.fn>>;
	await handleCommunityButton(interaction);
	return interaction;
}

// Confirm, then the confirm's Submit: the one path that writes.
async function confirmAndSubmit(guild: FakeGuild, userId = OWNER) {
	await pressConfirm(guild, userId);
	return submitConfirm(guild, userId);
}

type ConfirmModalJson = { custom_id: string; title: string; components: Array<{ content?: string }> };
const confirmModalOf = (interaction: { showModal: ReturnType<typeof vi.fn> }): ConfirmModalJson | undefined =>
	interaction.showModal.mock.calls
		.map((call) => (call[0] as { toJSON(): unknown }).toJSON() as ConfirmModalJson)
		.find((modal) => modal.custom_id === COMMUNITY_CUSTOM_IDS.writeOnboarding);
const confirmTextOf = (interaction: { showModal: ReturnType<typeof vi.fn> }): string =>
	(confirmModalOf(interaction)?.components ?? []).map((component) => component.content ?? "").join("\n");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId.mockResolvedValue({ ...storedRow });
	mocks.log.mockResolvedValue(undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("pressing Configure Onboarding", () => {
	it("refuses a member who is neither the owner nor an admin, before any read of Onboarding", async () => {
		const guild = makeGuild();
		const interaction = await openReview(guild, MEMBER);
		expect(guild.fetchOnboarding).not.toHaveBeenCalled();
		expect(refusalText(interaction)).toBe(rokCommanderCopy.responses.noWizardPowers);
	});

	it("refuses a server with only 3 sendable channels with the exact count, audits it, and reads nothing", async () => {
		const guild = makeGuild({ sendableChannels: 3 });
		const interaction = await openReview(guild);

		expect(guild.fetchOnboarding).not.toHaveBeenCalled();
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(interaction.reply).not.toHaveBeenCalled();
		expect(refusalText(interaction)).toBe(copy.preconditions.tooFewSendableChannels(3, 5));
		expect(refusalText(interaction)).toContain("You currently have 3; please add 2 more");
		expect(auditRows(BOT_LOG_EVENTS.ONBOARDING_PRECONDITION_FAILED)).toEqual([
			{ actorId: OWNER, step: "open", code: "too-few-sendable-channels", reason: copy.preconditions.tooFewSendableChannels(3, 5) },
		]);
	});

	it("refuses when the member role sits above Dero's role, naming the role to move", async () => {
		const interaction = await openReview(makeGuild({ memberRolePosition: 9 }));
		expect(refusalText(interaction)).toBe("My role must sit above the member role in Server Settings → Roles. Please move me above Member.");
	});

	it("refuses on a server without Community", async () => {
		const interaction = await openReview(makeGuild({ features: [] }));
		expect(refusalText(interaction)).toBe(copy.preconditions.communityOff);
	});

	it("shows the drafted review privately: 2 optional questions and the final one, a question select, then Add question, Confirm and Cancel", async () => {
		const guild = makeGuild();
		const interaction = await openReview(guild);

		expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		expect(guild.fetchOnboarding).toHaveBeenCalledOnce();
		expect(guild.editOnboarding).not.toHaveBeenCalled();
		const review = sent(interaction.editReply);
		const embed = review.embeds![0]!.data;
		expect(embed.title).toBe(copy.review.title);
		expect(embed.fields!.map((field) => field.name)).toEqual([`1. ${copy.draft.heardAbout.title}`, `2. ${copy.draft.goals.title}`, `3. ${copy.draft.final.title}`]);
		expect(embed.fields![2]!.value).toContain(`gives <@&${MEMBER_ROLE}>`);
		expect(embed.description).toContain("<#intro>");
		expect(embed.description).toContain("Default channels** (6)");
		expect(customIdsOf(review)).toEqual([
			expect.stringMatching(/^community:pickprompt:\d+$/),
			expect.stringMatching(/^community:addprompt:\d+$/),
			COMMUNITY_CUSTOM_IDS.confirmOnboarding,
			COMMUNITY_CUSTOM_IDS.cancelOnboarding,
		]);
	});

	it("on a server that already has Onboarding, shows its own questions for review and writes nothing", async () => {
		const live = {
			enabled: true,
			prompts: new Collection([
				[
					"prompt-live",
					{
						id: "prompt-live",
						title: "Pick your region",
						singleSelect: true,
						required: false,
						inOnboarding: true,
						type: GuildOnboardingPromptType.Dropdown,
						options: new Collection([
							["option-eu", { id: "option-eu", title: "Europe", description: null, roles: new Collection(), channels: new Collection(), emoji: null }],
						]),
					},
				],
			]),
			defaultChannels: new Collection([["open-0", undefined]]),
		};
		const guild = makeGuild({ live });
		const interaction = await openReview(guild);

		const embed = sent(interaction.editReply).embeds![0]!.data;
		expect(embed.fields!.map((field) => field.name)).toEqual(["1. Pick your region", `2. ${copy.draft.final.title}`]);
		expect(embed.fields![0]!.value).toContain("Europe");
		expect(embed.description).toContain("already has Onboarding questions");
		expect(embed.fields!.map((field) => field.name).join()).not.toContain(copy.draft.heardAbout.title);
		expect(guild.editOnboarding).not.toHaveBeenCalled();
	});

	it("drafts nothing over a config it could not read, so a later Confirm finds no draft", async () => {
		const guild = makeGuild();
		guild.fetchOnboarding.mockRejectedValueOnce(new DiscordAPIError({ code: 50013, message: "Missing Permissions" }, 50013, 403, "GET", "url", {}));
		const interaction = await openReview(guild);
		expect(sent(interaction.editReply).embeds![0]!.data.description).toBe(copy.readFailed("Missing Permissions"));

		const confirm = await pressConfirm(guild);
		expect(guild.editOnboarding).not.toHaveBeenCalled();
		expect(refusalText(confirm)).toBe(copy.expired);
	});
});

describe("Confirm", () => {
	it("calls editOnboarding once with the full payload, replaces the review with the result, and DMs the owner", async () => {
		const guild = makeGuild();
		await openReview(guild);
		const confirm = await confirmAndSubmit(guild);

		expect(confirm.deferUpdate).toHaveBeenCalledOnce();
		expect(guild.editOnboarding).toHaveBeenCalledOnce();
		expect(guild.editOnboarding).toHaveBeenCalledWith({
			enabled: true,
			mode: GuildOnboardingMode.OnboardingAdvanced,
			defaultChannels: ["intro", "open-0", "open-1", "open-2", "open-3", "open-4"],
			reason: "Configured by Dero via Configure Onboarding",
			prompts: [
				{
					id: undefined,
					title: "Where did you hear about us?",
					singleSelect: false,
					required: false,
					inOnboarding: true,
					type: GuildOnboardingPromptType.MultipleChoice,
					options: ["Friend", "Twitter", "Reddit", "YouTube", "Other"].map((title) => ({ id: null, title, description: null, roles: [], channels: [], emoji: null })),
				},
				{
					id: undefined,
					title: "What do you want to do here?",
					singleSelect: false,
					required: false,
					inOnboarding: true,
					type: GuildOnboardingPromptType.MultipleChoice,
					options: ["Play games", "Chat", "Lurk", "Build things"].map((title) => ({ id: null, title, description: null, roles: [], channels: [], emoji: null })),
				},
				{
					id: undefined,
					title: "✨ You're officially part of the community! Thanks for being here and supporting the journey.",
					singleSelect: true,
					required: true,
					inOnboarding: true,
					type: GuildOnboardingPromptType.MultipleChoice,
					options: [{ id: null, title: "Glad to be here", description: null, roles: [MEMBER_ROLE], channels: [], emoji: null }],
				},
			],
		});

		const result = sent(confirm.editReply);
		expect(result.embeds![0]!.data.title).toBe(copy.success.title);
		expect(result.components).toEqual([]);

		await vi.waitFor(() => expect(auditRows(BOT_LOG_EVENTS.ONBOARDING_CONFIGURED_BY_BOT)).toHaveLength(1));
		expect(guild.owner.send).toHaveBeenCalledWith({
			content:
				"Onboarding configured. Members who already completed Onboarding stay in; if any of them need to retake, point them to Channels & Roles → Retake Onboarding.",
			allowedMentions: { parse: [] },
		});
		expect(auditRows(BOT_LOG_EVENTS.ONBOARDING_CONFIGURED_BY_BOT)[0]).toEqual({
			actorId: OWNER,
			outcome: "configured",
			discordCode: null,
			ownerDm: "sent",
			memberRoleId: MEMBER_ROLE,
			promptCount: 3,
			optionCount: 10,
			defaultChannelCount: 6,
			startedFromExisting: false,
			finalPromptAdded: false,
		});
	});

	it("writes once on a double Submit: the second finds the draft taken, and so does a later Confirm", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await confirmAndSubmit(guild);
		const secondSubmit = await submitConfirm(guild);
		const second = await pressConfirm(guild);
		expect(guild.editOnboarding).toHaveBeenCalledOnce();
		expect(secondSubmit.deferUpdate).not.toHaveBeenCalled();
		expect(refusalText(second)).toBe(copy.expired);
	});

	it("runs the preconditions again: Community switched off since the review refuses, keeps the draft, writes nothing", async () => {
		const guild = makeGuild();
		await openReview(guild);
		guild.features = [];
		const refused = await pressConfirm(guild);

		expect(guild.editOnboarding).not.toHaveBeenCalled();
		expect(refusalText(refused)).toBe(copy.preconditions.communityOff);
		expect(auditRows(BOT_LOG_EVENTS.ONBOARDING_PRECONDITION_FAILED).at(-1)).toMatchObject({ step: "confirm", code: "community-off" });

		guild.features = ["COMMUNITY"];
		await confirmAndSubmit(guild);
		expect(guild.editOnboarding).toHaveBeenCalledOnce();
	});

	it("refuses when the member role moved above Dero since the review", async () => {
		const guild = makeGuild();
		await openReview(guild);
		guild.roles.cache.get(MEMBER_ROLE)!.position = 8;
		const refused = await pressConfirm(guild);
		expect(guild.editOnboarding).not.toHaveBeenCalled();
		expect(refusalText(refused)).toContain("Please move me above Member.");
	});

	it("on a 50013 shows a plain line under the review, audits it, DMs nobody, and keeps the draft for a retry", async () => {
		const guild = makeGuild();
		guild.editOnboarding.mockRejectedValueOnce(new DiscordAPIError({ code: 50013, message: "Missing Permissions" }, 50013, 403, "PUT", "url", {}));
		await openReview(guild);
		const refused = await confirmAndSubmit(guild);

		const reply = sent(refused.editReply);
		expect(reply.embeds!.map((embed) => embed.data.title)).toEqual([copy.review.title, rokCommanderCopy.error.title]);
		expect(reply.embeds![1]!.data.description).toBe(copy.failures.missingPermission);
		expect(customIdsOf(reply)).toContain(COMMUNITY_CUSTOM_IDS.confirmOnboarding);
		expect(auditRows(BOT_LOG_EVENTS.ONBOARDING_CONFIGURED_BY_BOT)).toEqual([expect.objectContaining({ outcome: "refused-permissions", discordCode: 50013, ownerDm: null })]);
		expect(guild.fetchOwner).not.toHaveBeenCalled();

		await confirmAndSubmit(guild);
		expect(guild.editOnboarding).toHaveBeenCalledTimes(2);
	});

	it("on a 400 surfaces Discord's own message verbatim and changes nothing else", async () => {
		const guild = makeGuild();
		const discordMessage = "Invalid Form Body\ndefault_channel_ids: Onboarding requires at least 7 default channels";
		guild.editOnboarding.mockRejectedValueOnce(new DiscordAPIError({ code: 50035, message: discordMessage }, 50035, 400, "PUT", "url", {}));
		await openReview(guild);
		const refused = await confirmAndSubmit(guild);

		expect(sent(refused.editReply).embeds![1]!.data.description).toBe(copy.failures.rejected(discordMessage));
		expect(sent(refused.editReply).embeds![1]!.data.description).toContain("Onboarding requires at least 7 default channels");
		expect(auditRows(BOT_LOG_EVENTS.ONBOARDING_CONFIGURED_BY_BOT)[0]).toMatchObject({ outcome: "refused-discord", discordCode: 50035 });
	});

	it("still answers the owner when the DM fails, and audits the failed DM", async () => {
		const guild = makeGuild();
		guild.owner.send.mockRejectedValueOnce(new Error("Cannot send messages to this user"));
		await openReview(guild);
		const confirm = await confirmAndSubmit(guild);

		expect(sent(confirm.editReply).embeds![0]!.data.title).toBe(copy.success.title);
		await vi.waitFor(() => expect(auditRows(BOT_LOG_EVENTS.ONBOARDING_CONFIGURED_BY_BOT)[0]).toMatchObject({ outcome: "configured", ownerDm: "failed" }));
	});

	it("answers expired once the draft's ten minutes are up", async () => {
		const guild = makeGuild();
		await openReview(guild);
		// Read after the draft is stored, which stamps its own Date.now(): read before,
		// a full suite run under load let more than 1 ms pass, and the "late" press
		// still landed inside the window.
		const start = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(start + ONBOARDING_DRAFT_TTL_MS + 1);
		const late = await pressConfirm(guild);
		expect(guild.editOnboarding).not.toHaveBeenCalled();
		expect(refusalText(late)).toBe(copy.expired);
	});

	it("keeps two admins' drafts apart", async () => {
		const guild = makeGuild();
		await openReview(guild, OWNER);
		const adminConfirm = await pressConfirm(guild, ADMIN);
		expect(guild.editOnboarding).not.toHaveBeenCalled();
		expect(refusalText(adminConfirm)).toBe(copy.expired);
	});
});

// R3-20 (2026-10 item 263 Phase 4b, owner decision 18): Confirm opens a confirm modal of
// the summary, so nothing changes on Discord until its Submit.
describe("the confirm modal", () => {
	it("opens on Confirm with the summary as its text, and writes nothing until its Submit", async () => {
		const guild = makeGuild();
		await openReview(guild);
		const confirm = await pressConfirm(guild);

		expect(confirmModalOf(confirm)?.title).toBe(copy.review.confirmTitle);
		const text = confirmTextOf(confirm);
		expect(text).toContain("Questions: 3, ending with the one that gives @Member");
		expect(text).toContain("Default channels (6): #intro, #open-0");
		expect(guild.editOnboarding).not.toHaveBeenCalled();

		// Closing the modal sends nothing, so the draft waits: a second Confirm opens it again.
		const again = await pressConfirm(guild);
		expect(confirmModalOf(again)).toBeDefined();
		await submitConfirm(guild);
		expect(guild.editOnboarding).toHaveBeenCalledOnce();
	});

	it("re-checks on Submit: Community switched off after the modal opened writes nothing and keeps the draft", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await pressConfirm(guild);
		guild.features = [];
		const refused = await submitConfirm(guild);
		expect(guild.editOnboarding).not.toHaveBeenCalled();
		expect(refused.deferUpdate).not.toHaveBeenCalled();

		guild.features = ["COMMUNITY"];
		await confirmAndSubmit(guild);
		expect(guild.editOnboarding).toHaveBeenCalledOnce();
	});

	it("refuses a Submit from a member who is neither the owner nor an admin", async () => {
		const guild = makeGuild();
		await openReview(guild);
		await pressConfirm(guild);
		await submitConfirm(guild, MEMBER);
		expect(guild.editOnboarding).not.toHaveBeenCalled();
	});
});

// R3-20 (2026-10 item 263 Phase 4b): the review lists only what a new member would see.
describe("the review's default channels", () => {
	it("names a category among the server's defaults as a category, counts channels only, and lists no channel a new member cannot open", async () => {
		const live = { ...emptyOnboarding(), defaultChannels: new Collection([["entrance", undefined], ["staff", undefined]]) };
		const guild = makeGuild({
			live,
			extraChannels: [
				{ id: "entrance", name: "entrance", type: ChannelType.GuildCategory, viewable: true },
				{ id: "staff", name: "staff", type: ChannelType.GuildText, viewable: false },
			],
		});
		const review = await openReview(guild);
		const description = sent(review.editReply).embeds![0]!.data.description!;

		expect(description).toContain("Default channels** (6)");
		expect(description).toContain("everything in the **entrance** category");
		expect(description).not.toContain("<#entrance>");
		expect(description).not.toContain("<#staff>");
		// Every listed channel is a link.
		expect(description.match(/<#[^>]+>/g)).toHaveLength(6);

		const confirm = await pressConfirm(guild);
		const text = confirmTextOf(confirm);
		expect(text).toContain("Default channels (6)");
		expect(text).toContain("everything in the **entrance** category");
		await submitConfirm(guild);
		const written = guild.editOnboarding.mock.calls[0]![0] as { defaultChannels: string[] };
		expect(written.defaultChannels).toContain("entrance");
		expect(written.defaultChannels).not.toContain("staff");
	});
});

describe("Cancel", () => {
	it("closes the review with Cancelled. and forgets the draft", async () => {
		const guild = makeGuild();
		await openReview(guild);
		const cancel = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.cancelOnboarding);
		await handleCommunityButton(cancel);

		expect(cancel.update).toHaveBeenCalledWith({ content: "Cancelled.", embeds: [], components: [] });
		const confirm = await pressConfirm(guild);
		expect(guild.editOnboarding).not.toHaveBeenCalled();
		expect(refusalText(confirm)).toBe(copy.expired);
	});
});
