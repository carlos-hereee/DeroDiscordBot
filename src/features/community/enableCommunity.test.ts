import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	ChannelType,
	Collection,
	ComponentType,
	DiscordAPIError,
	GuildExplicitContentFilter,
	GuildVerificationLevel,
	MessageFlags,
	PermissionFlagsBits,
	Routes,
	type ButtonInteraction,
	type ModalBuilder,
	type ModalSubmitInteraction,
} from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";

// ── enableCommunity (2026-10 item 247 Phase 3) ──────────────────────────────
// The Enable Community round trip through the router, the way a press arrives:
// the already Community short circuit, the permission refusal, the modal, the
// review, and Confirm's one guild edit with the full payload, then the
// Membership Screening write when its checkbox is ticked. Refusals: a 50013 gets a
// plain line naming the permission, any other Discord refusal its own words.
// ONLY THE REQUEST SHAPE of the screening write is tested here; the endpoint is
// unstable in Discord's API and has never been called live from a test. A refusal
// to a button press is a notice modal (post-launch plan item 9); one to a modal
// submit is still a private reply, since a submit cannot open a modal. The review
// posts in 🧭onboarding, privately only where setup never stored that channel, and
// Confirm turns that review into the result (2026-10 item 257 Phase 5).

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
import {
	MEMBERSHIP_SCREENING_RULES_MAX_LENGTH,
	buildMembershipScreeningRequest,
	fitRulesToScreeningForm,
	handleChannelsPicked,
	raisedVerificationLevel,
} from "./enableCommunity.js";

const OWNER = "owner-1";
const ADMIN = "admin-1";
const MEMBER = "member-1";
const DEFAULT_RULES = rokCommanderCopy.channelContent.rules.defaultMarkdown;
const RULE_BREAK = "\n\n";

// The longest run of whole default rules that fits the screening form, worked out
// here block by block rather than by the code under test, so the test pins "the
// last full rule that fits" instead of repeating the implementation.
const DEFAULT_RULES_THAT_FIT = (() => {
	const blocks = DEFAULT_RULES.split(RULE_BREAK);
	let fitting = blocks[0]!;
	for (const block of blocks.slice(1)) {
		const next = `${fitting}${RULE_BREAK}${block}`;
		if (next.length > MEMBERSHIP_SCREENING_RULES_MAX_LENGTH) break;
		fitting = next;
	}
	return fitting;
})();

const storedRow = {
	adminRoleId: "role-admin",
	rulesChannelId: "dero-rules",
	adminChannelId: "inner-sanctum",
	customRulesMarkdown: null as string | null,
};

// Every test gets its own guild id: the picks wait in a module level map keyed by
// guild and user, so a shared id would let one test's leftover picks reach the next.
let guildCounter = 0;

interface IGuildOptions {
	features?: string[];
	verificationLevel?: GuildVerificationLevel;
	explicitContentFilter?: GuildExplicitContentFilter;
	permissions?: bigint[] | "administrator";
}

function makeGuild(options: IGuildOptions = {}) {
	guildCounter += 1;
	const granted = options.permissions ?? "administrator";
	const guild = {
		id: `g${guildCounter}`,
		ownerId: OWNER,
		features: options.features ?? ["NEWS"],
		verificationLevel: options.verificationLevel ?? GuildVerificationLevel.None,
		explicitContentFilter: options.explicitContentFilter ?? GuildExplicitContentFilter.Disabled,
		rulesChannelId: null as string | null,
		publicUpdatesChannelId: null as string | null,
		members: {
			me: { permissions: { has: (flag: bigint) => granted === "administrator" || granted.includes(flag) } },
			cache: new Map([[ADMIN, { roles: { cache: new Set(["role-admin"]) } }]]),
			fetch: vi.fn(async () => null),
			fetchMe: vi.fn(async () => null),
		},
		channels: {
			cache: new Map([
				["dero-rules", { type: ChannelType.GuildText }],
				["inner-sanctum", { type: ChannelType.GuildText }],
			]),
		},
		edit: vi.fn(async () => undefined),
		client: { rest: { patch: vi.fn(async () => ({})) } },
	};
	return guild;
}

type FakeGuild = ReturnType<typeof makeGuild>;

// 🧭onboarding, where the review posts once setup has stored its id.
const onboardingChannel = { id: "onboarding-ch", isSendable: () => true, send: vi.fn(async () => ({ id: "review-msg" })) };

function submission(guild: FakeGuild, userId: string, picks: { rules?: string; updates?: string; screening?: boolean }) {
	const channelsFor = (id: string | undefined) => (id ? new Collection([[id, { id }]]) : null);
	return {
		guild,
		client: { channels: { fetch: vi.fn(async (id: string) => (id === onboardingChannel.id ? onboardingChannel : null)) } },
		deferred: false,
		replied: false,
		isModalSubmit: () => true,
		isFromMessage: () => true,
		deferUpdate: vi.fn(async () => undefined),
		user: { id: userId },
		customId: "community:modal:int-1",
		fields: {
			getSelectedChannels: vi.fn((field: string) => channelsFor(field === "rules_channel" ? picks.rules : picks.updates)),
			getCheckbox: vi.fn(() => picks.screening ?? true),
		},
		reply: vi.fn(async () => undefined),
	} as unknown as ModalSubmitInteraction & { reply: ReturnType<typeof vi.fn> };
}

function press(guild: FakeGuild, userId: string, customId: string, awaited: ModalSubmitInteraction | null = null) {
	return {
		id: "int-1",
		customId,
		guild,
		user: { id: userId },
		showModal: vi.fn(async () => undefined),
		awaitModalSubmit: vi.fn(async () => {
			if (!awaited) throw new Error("Collector received no interactions before ending with reason: time");
			return awaited;
		}),
		reply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	} as unknown as ButtonInteraction & {
		showModal: ReturnType<typeof vi.fn>;
		awaitModalSubmit: ReturnType<typeof vi.fn>;
		reply: ReturnType<typeof vi.fn>;
		deferReply: ReturnType<typeof vi.fn>;
		deferUpdate: ReturnType<typeof vi.fn>;
		editReply: ReturnType<typeof vi.fn>;
	};
}

interface ISentMessage {
	content?: string;
	embeds?: Array<{ data: { title?: string; description?: string } }>;
	components?: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>;
}

const sent = (fn: ReturnType<typeof vi.fn>, call = 0): ISentMessage => fn.mock.calls[call]![0] as ISentMessage;

type ModalJson = { custom_id: string; title: string; components: Array<{ content?: string }> };
const modalsOf = (interaction: { showModal: ReturnType<typeof vi.fn> }): ModalJson[] =>
	interaction.showModal.mock.calls.map((call) => (call[0] as ModalBuilder).toJSON() as unknown as ModalJson);
// The notice modal a button press is answered with, or undefined when none opened.
const noticeOf = (interaction: { showModal: ReturnType<typeof vi.fn> }): ModalJson | undefined =>
	modalsOf(interaction).find((modal) => modal.custom_id.startsWith("notice:"));
const noticeText = (interaction: { showModal: ReturnType<typeof vi.fn> }): string | undefined =>
	noticeOf(interaction)
		?.components.map((component) => component.content)
		.join("\n");
const customIdsOf = (message: ISentMessage): Array<string | undefined> =>
	(message.components ?? []).flatMap((row) => row.toJSON().components.map((component) => component.custom_id));

// Press Enable Community, submit the modal with these picks, and return the review.
async function pickChannels(guild: FakeGuild, userId: string, picks: { rules?: string; updates?: string; screening?: boolean } = {}) {
	const submit = submission(guild, userId, { rules: "rules-ch", updates: "mods-ch", ...picks });
	const enable = press(guild, userId, COMMUNITY_CUSTOM_IDS.enable, submit);
	await handleCommunityButton(enable);
	return { enable, submit };
}

async function confirm(guild: FakeGuild, userId: string) {
	const interaction = press(guild, userId, COMMUNITY_CUSTOM_IDS.confirm);
	await handleCommunityButton(interaction);
	return interaction;
}

const auditRows = (event: string): Array<Record<string, unknown>> =>
	mocks.log.mock.calls.filter((call) => call[1] === event).map((call) => call[2] as Record<string, unknown>);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId.mockResolvedValue({ ...storedRow });
	mocks.log.mockResolvedValue(undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("pressing Enable Community", () => {
	it("short circuits on a guild that is already Community: a status notice, no picks modal, no edit", async () => {
		const guild = makeGuild({ features: ["COMMUNITY"], verificationLevel: GuildVerificationLevel.High });
		guild.rulesChannelId = "rules-ch";
		const interaction = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.enable);
		await handleCommunityButton(interaction);

		expect(interaction.showModal).toHaveBeenCalledOnce();
		expect(guild.edit).not.toHaveBeenCalled();
		expect(interaction.reply).not.toHaveBeenCalled();
		expect(noticeOf(interaction)?.title).toBe(communityCopy.alreadyOn.title);
		expect(noticeText(interaction)).toContain("<#rules-ch>");
		expect(noticeText(interaction)).toContain("High");
	});

	it("falls back to the private status reply with the Configure Onboarding offer when Discord refuses the notice", async () => {
		const guild = makeGuild({ features: ["COMMUNITY"] });
		const interaction = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.enable);
		interaction.showModal.mockRejectedValueOnce(new Error("Invalid Form Body"));
		await handleCommunityButton(interaction);

		const reply = interaction.reply.mock.calls[0]![0] as ISentMessage & { flags: number };
		expect(reply.flags).toBe(MessageFlags.Ephemeral);
		expect(reply.embeds![0]!.data.title).toBe(communityCopy.alreadyOn.title);
		expect(customIdsOf(reply)).toEqual([COMMUNITY_CUSTOM_IDS.configure]);
	});

	it("refuses with the missing permissions named when Dero is not an Administrator and lacks them", async () => {
		const guild = makeGuild({ permissions: [PermissionFlagsBits.ManageChannels] });
		const interaction = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.enable);
		await handleCommunityButton(interaction);

		expect(modalsOf(interaction).filter((modal) => !modal.custom_id.startsWith("notice:"))).toEqual([]);
		expect(noticeText(interaction)).toBe(communityCopy.errors.missingPermissions(["Manage Server", "Manage Roles"]));
	});

	it("lets a Dero with Manage Server, Manage Roles and Manage Channels through without Administrator", async () => {
		const guild = makeGuild({ permissions: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels] });
		const interaction = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.enable);
		await handleCommunityButton(interaction);
		expect(interaction.showModal).toHaveBeenCalledOnce();
	});

	it("opens one modal: two text channel picks, pre-picked where Dero has the channel, and the screening checkbox ticked", async () => {
		const guild = makeGuild();
		const interaction = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.enable);
		await handleCommunityButton(interaction);

		const modal = (interaction.showModal.mock.calls[0]![0] as { toJSON(): { custom_id: string; components: Array<{ component: Record<string, unknown> }> } }).toJSON();
		const [rules, updates, screening] = modal.components.map((label) => label.component);
		expect(rules).toMatchObject({ type: ComponentType.ChannelSelect, custom_id: "rules_channel", channel_types: [ChannelType.GuildText], required: true });
		expect(rules!.default_values).toEqual([{ id: "dero-rules", type: "channel" }]);
		expect(updates).toMatchObject({ type: ComponentType.ChannelSelect, custom_id: "public_updates_channel", channel_types: [ChannelType.GuildText] });
		expect(updates!.default_values).toEqual([{ id: "inner-sanctum", type: "channel" }]);
		expect(screening).toMatchObject({ type: ComponentType.Checkbox, custom_id: "membership_screening", default: true });

		// The wait hears only this clicker's own modal.
		const { filter } = interaction.awaitModalSubmit.mock.calls[0]![0] as { filter: (submit: unknown) => boolean };
		expect(filter({ user: { id: OWNER }, customId: modal.custom_id })).toBe(true);
		expect(filter({ user: { id: ADMIN }, customId: modal.custom_id })).toBe(false);
	});

	it("offers no default for a stored channel that no longer exists, since Discord would reject the whole modal", async () => {
		const guild = makeGuild();
		guild.channels.cache.clear();
		const interaction = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.enable);
		await handleCommunityButton(interaction);
		const modal = (interaction.showModal.mock.calls[0]![0] as { toJSON(): { components: Array<{ component: Record<string, unknown> }> } }).toJSON();
		expect(modal.components[0]!.component.default_values).toBeUndefined();
	});
});

describe("the review", () => {
	it("posts what will change in 🧭onboarding, with Confirm, and changes nothing yet", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...storedRow, onboardingConfigChannelId: onboardingChannel.id });
		const guild = makeGuild();
		const { submit } = await pickChannels(guild, OWNER);

		expect(guild.edit).not.toHaveBeenCalled();
		expect(submit.reply).not.toHaveBeenCalled();
		const review = sent(onboardingChannel.send) as ISentMessage & { content: string };
		expect(review.content).toBe(`<@${OWNER}>`);
		expect(review.embeds![0]!.data.title).toBe(communityCopy.review.title);
		expect(customIdsOf(review)).toEqual([COMMUNITY_CUSTOM_IDS.confirm]);
	});

	it("lists what will change privately, with Confirm, where setup never stored 🧭onboarding, and changes nothing yet", async () => {
		const guild = makeGuild();
		const { submit } = await pickChannels(guild, OWNER);

		expect(guild.edit).not.toHaveBeenCalled();
		const review = submit.reply.mock.calls[0]![0] as ISentMessage & { flags: number };
		expect(review.flags).toBe(MessageFlags.Ephemeral);
		expect(review.embeds![0]!.data.title).toBe(communityCopy.review.title);
		const description = review.embeds![0]!.data.description!;
		expect(description).toContain("<#rules-ch>");
		expect(description).toContain("<#mods-ch>");
		expect(description).toContain("Verification level: None to Medium");
		expect(description).toContain("Explicit content filter: Off to All members");
		expect(description).toContain("Membership Screening: on");
		expect(customIdsOf(review)).toEqual([COMMUNITY_CUSTOM_IDS.confirm]);
	});

	it("re-checks the submitter, who may have lost the admin role while the modal was open, and shows no Confirm", async () => {
		const guild = makeGuild();
		const submit = submission(guild, MEMBER, { rules: "rules-ch", updates: "mods-ch" });
		await handleChannelsPicked(submit);
		const reply = sent(submit.reply);
		// since Phase 1c a refused Submit's private fallback is the notice's plain text (owner rule 1)
		expect(reply.content).toBe(rokCommanderCopy.responses.noWizardPowers);
		expect(customIdsOf(reply)).toEqual([]);
		expect(guild.edit).not.toHaveBeenCalled();
	});

	it("refuses a submit missing a channel", async () => {
		const guild = makeGuild();
		const { submit } = await pickChannels(guild, OWNER, { updates: "" });
		expect(sent(submit.reply).content).toBe(communityCopy.errors.channelsMissing);
	});

	it("warns before Confirm when the rules are longer than the screening form takes", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...storedRow, customRulesMarkdown: "r".repeat(2000) });
		const guild = makeGuild();
		const { submit } = await pickChannels(guild, OWNER);
		expect(sent(submit.reply).embeds![0]!.data.description).toContain(communityCopy.rulesCutNotice(MEMBERSHIP_SCREENING_RULES_MAX_LENGTH));
	});

	it("says nothing about a cut when the rules fit", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...storedRow, customRulesMarkdown: "**1. Be kind**" });
		const guild = makeGuild();
		const { submit } = await pickChannels(guild, OWNER);
		expect(sent(submit.reply).embeds![0]!.data.description).not.toContain(communityCopy.rulesCutNotice(MEMBERSHIP_SCREENING_RULES_MAX_LENGTH));
	});
});

describe("Confirm", () => {
	it("calls guild.edit once with the full payload: COMMUNITY added, both channels, Medium, All members, the reason", async () => {
		const guild = makeGuild();
		await pickChannels(guild, OWNER);
		const interaction = await confirm(guild, OWNER);

		// An update: the review becomes the result, so no new private reply is opened.
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(guild.edit).toHaveBeenCalledOnce();
		expect(guild.edit).toHaveBeenCalledWith({
			features: ["NEWS", "COMMUNITY"],
			rulesChannel: "rules-ch",
			publicUpdatesChannel: "mods-ch",
			verificationLevel: GuildVerificationLevel.Medium,
			explicitContentFilter: GuildExplicitContentFilter.AllMembers,
			reason: "Enabled by Dero via Enable Community",
		});
	});

	it("never lowers a verification level that is already above Medium", async () => {
		const guild = makeGuild({ verificationLevel: GuildVerificationLevel.High, explicitContentFilter: GuildExplicitContentFilter.MembersWithoutRoles });
		await pickChannels(guild, ADMIN);
		await confirm(guild, ADMIN);
		expect(guild.edit).toHaveBeenCalledWith(
			expect.objectContaining({ verificationLevel: GuildVerificationLevel.High, explicitContentFilter: GuildExplicitContentFilter.AllMembers })
		);
	});

	it("with the checkbox ticked, writes the screening form from the server's rules after the edit", async () => {
		const guild = makeGuild();
		await pickChannels(guild, OWNER, { screening: true });
		const interaction = await confirm(guild, OWNER);

		expect(guild.client.rest.patch).toHaveBeenCalledOnce();
		const [route, request] = guild.client.rest.patch.mock.calls[0]! as unknown as [string, { body: { enabled: boolean; form_fields: string; description: string }; reason: string }];
		expect(route).toBe(Routes.guildMemberVerification(guild.id));
		expect(request.reason).toBe("Enabled by Dero via Enable Community");
		expect(request.body.enabled).toBe(true);
		expect(request.body.description).toBe("Please read and accept the server rules.");
		// The pack default is longer than the form takes, so it arrives as whole rules.
		expect(JSON.parse(request.body.form_fields)).toEqual([{ field_type: "TERMS", label: "Server Rules", values: [DEFAULT_RULES_THAT_FIT], required: true }]);
		// The edit ran first: Membership Screening needs Community on.
		expect(guild.edit.mock.invocationCallOrder[0]!).toBeLessThan(guild.client.rest.patch.mock.invocationCallOrder[0]!);

		const reply = sent(interaction.editReply);
		expect(reply.embeds![0]!.data.title).toBe(communityCopy.success.title);
		expect(reply.embeds![0]!.data.description).toContain("Membership Screening: on");
		expect(reply.embeds![0]!.data.description).toContain(communityCopy.rulesCutNotice(MEMBERSHIP_SCREENING_RULES_MAX_LENGTH));
		expect(customIdsOf(reply)).toEqual([COMMUNITY_CUSTOM_IDS.configure]);
	});

	it("sends the default rules as whole rules: the longest run that fits, never a rule cut mid sentence", async () => {
		// Guards the reason the cut exists: the default really is longer than the form.
		expect(DEFAULT_RULES.length).toBeGreaterThan(MEMBERSHIP_SCREENING_RULES_MAX_LENGTH);
		const guild = makeGuild();
		await pickChannels(guild, OWNER);
		await confirm(guild, OWNER);

		const request = guild.client.rest.patch.mock.calls[0]![1] as unknown as { body: { form_fields: string } };
		const sentRules = (JSON.parse(request.body.form_fields) as Array<{ values: string[] }>)[0]!.values[0]!;
		const sentBlocks = sentRules.split(RULE_BREAK);
		const defaultBlocks = DEFAULT_RULES.split(RULE_BREAK);
		expect(sentRules.length).toBeLessThanOrEqual(MEMBERSHIP_SCREENING_RULES_MAX_LENGTH);
		expect(sentBlocks).toEqual(defaultBlocks.slice(0, sentBlocks.length));
		// One more whole rule would not have fit.
		expect(`${sentRules}${RULE_BREAK}${defaultBlocks[sentBlocks.length]}`.length).toBeGreaterThan(MEMBERSHIP_SCREENING_RULES_MAX_LENGTH);
	});

	it("with the checkbox cleared, switches Community on and skips the screening write", async () => {
		const guild = makeGuild();
		await pickChannels(guild, OWNER, { screening: false });
		const interaction = await confirm(guild, OWNER);

		expect(guild.edit).toHaveBeenCalledOnce();
		expect(guild.client.rest.patch).not.toHaveBeenCalled();
		expect(sent(interaction.editReply).embeds![0]!.data.description).toContain("Membership Screening: off");
		expect(auditRows(BOT_LOG_EVENTS.MEMBERSHIP_SCREENING_ENABLED_BY_BOT)).toEqual([]);
	});

	it("cuts one rule longer than the whole limit at the limit, the only cut that lands mid rule, and says so", async () => {
		const longRules = "r".repeat(2000);
		mocks.findByGuildId.mockResolvedValue({ ...storedRow, customRulesMarkdown: longRules });
		const guild = makeGuild();
		await pickChannels(guild, OWNER);
		const interaction = await confirm(guild, OWNER);

		const request = guild.client.rest.patch.mock.calls[0]![1] as unknown as { body: { form_fields: string } };
		expect((JSON.parse(request.body.form_fields) as Array<{ values: string[] }>)[0]!.values[0]).toHaveLength(MEMBERSHIP_SCREENING_RULES_MAX_LENGTH);
		expect(sent(interaction.editReply).embeds![0]!.data.description).toContain(communityCopy.rulesCutNotice(MEMBERSHIP_SCREENING_RULES_MAX_LENGTH));
		expect(auditRows(BOT_LOG_EVENTS.MEMBERSHIP_SCREENING_ENABLED_BY_BOT)[0]).toMatchObject({ rulesLength: 2000, truncated: true });
	});

	it("routes a 50013 to a plain line naming Manage Server, writes no screening form, and keeps the picks for a retry", async () => {
		const guild = makeGuild();
		guild.edit.mockRejectedValueOnce(new DiscordAPIError({ code: 50013, message: "Missing Permissions" }, 50013, 403, "PATCH", "url", {}));
		await pickChannels(guild, OWNER);
		const refused = await confirm(guild, OWNER);

		expect(sent(refused.editReply).embeds![0]!.data.description).toBe(communityCopy.failures.missingPermission);
		expect(guild.client.rest.patch).not.toHaveBeenCalled();
		expect(auditRows(BOT_LOG_EVENTS.COMMUNITY_ENABLED_BY_BOT)[0]).toMatchObject({ outcome: "refused-permissions", discordCode: 50013 });

		// The owner grants the permission and presses Confirm again: the same picks apply.
		await confirm(guild, OWNER);
		expect(guild.edit).toHaveBeenCalledTimes(2);
	});

	it("surfaces a Discord 400 to the owner in Discord's own words", async () => {
		const guild = makeGuild();
		const discordMessage = "Invalid Form Body\nrules_channel_id[GUILD_RULES_CHANNEL_INVALID]: Rules channel must be visible to everyone";
		guild.edit.mockRejectedValueOnce(new DiscordAPIError({ code: 50035, message: discordMessage }, 50035, 400, "PATCH", "url", {}));
		await pickChannels(guild, OWNER);
		const interaction = await confirm(guild, OWNER);

		expect(sent(interaction.editReply).embeds![0]!.data.description).toContain("Rules channel must be visible to everyone");
		expect(auditRows(BOT_LOG_EVENTS.COMMUNITY_ENABLED_BY_BOT)[0]).toMatchObject({ outcome: "refused-discord", discordCode: 50035 });
	});

	it("keeps Community on when Discord refuses the screening form, and tells the owner to switch it on by hand", async () => {
		const guild = makeGuild();
		guild.client.rest.patch.mockRejectedValueOnce(new DiscordAPIError({ code: 50035, message: "Invalid Form Body" }, 50035, 400, "PATCH", "url", {}));
		await pickChannels(guild, OWNER);
		const interaction = await confirm(guild, OWNER);

		const reply = sent(interaction.editReply);
		expect(reply.embeds![0]!.data.title).toBe(communityCopy.success.title);
		expect(reply.embeds![0]!.data.description).toContain("Switch it on by hand in Server Settings");
		expect(auditRows(BOT_LOG_EVENTS.COMMUNITY_ENABLED_BY_BOT)[0]).toMatchObject({ outcome: "enabled" });
		expect(auditRows(BOT_LOG_EVENTS.MEMBERSHIP_SCREENING_ENABLED_BY_BOT)[0]).toMatchObject({ outcome: "refused-discord" });
	});

	it("audits ids, outcomes and a length, never the rules text", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...storedRow, customRulesMarkdown: "**1. Be kind to everyone here**" });
		const guild = makeGuild();
		await pickChannels(guild, OWNER);
		await confirm(guild, OWNER);

		expect(auditRows(BOT_LOG_EVENTS.COMMUNITY_ENABLED_BY_BOT)).toEqual([
			{
				actorId: OWNER,
				outcome: "enabled",
				discordCode: null,
				rulesChannelId: "rules-ch",
				publicUpdatesChannelId: "mods-ch",
				verificationLevel: GuildVerificationLevel.Medium,
				explicitContentFilter: GuildExplicitContentFilter.AllMembers,
				membershipScreening: true,
			},
		]);
		const screeningRow = auditRows(BOT_LOG_EVENTS.MEMBERSHIP_SCREENING_ENABLED_BY_BOT)[0]!;
		expect(screeningRow).toMatchObject({ actorId: OWNER, outcome: "enabled", rulesLength: "**1. Be kind to everyone here**".length, truncated: false });
		expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("Be kind");
	});

	it("answers expired, and edits nothing, when there are no picks to confirm", async () => {
		const guild = makeGuild();
		const interaction = await confirm(guild, OWNER);
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
		expect(guild.edit).not.toHaveBeenCalled();
		expect(noticeText(interaction)).toBe(communityCopy.errors.expired);
	});

	it("answers expired once the picks have waited past their window", async () => {
		const guild = makeGuild();
		const start = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);
		await pickChannels(guild, OWNER);
		clock.mockReturnValue(start + 2 * 60_000 + 1);
		const interaction = await confirm(guild, OWNER);
		expect(guild.edit).not.toHaveBeenCalled();
		expect(noticeText(interaction)).toBe(communityCopy.errors.expired);
	});

	it("does not edit twice when Confirm is pressed twice", async () => {
		const guild = makeGuild();
		await pickChannels(guild, OWNER);
		await confirm(guild, OWNER);
		const second = await confirm(guild, OWNER);
		expect(guild.edit).toHaveBeenCalledOnce();
		expect(noticeText(second)).toBe(communityCopy.errors.expired);
	});

	it("re-checks the live guild: Community switched on since the review means a status reply and no edit", async () => {
		const guild = makeGuild();
		await pickChannels(guild, OWNER);
		guild.features.push("COMMUNITY");
		const interaction = await confirm(guild, OWNER);
		expect(guild.edit).not.toHaveBeenCalled();
		expect(sent(interaction.editReply).embeds![0]!.data.title).toBe(communityCopy.alreadyOn.title);
	});
});

describe("the pure builders", () => {
	it("raise the verification level to Medium and never lower it", () => {
		expect(raisedVerificationLevel(GuildVerificationLevel.None)).toBe(GuildVerificationLevel.Medium);
		expect(raisedVerificationLevel(GuildVerificationLevel.Low)).toBe(GuildVerificationLevel.Medium);
		expect(raisedVerificationLevel(GuildVerificationLevel.Medium)).toBe(GuildVerificationLevel.Medium);
		expect(raisedVerificationLevel(GuildVerificationLevel.VeryHigh)).toBe(GuildVerificationLevel.VeryHigh);
	});

	it("serialize the screening field list as a JSON string, the shape the endpoint takes", () => {
		const request = buildMembershipScreeningRequest("short rules");
		expect(typeof request.body.form_fields).toBe("string");
		expect(request).toMatchObject({ truncated: false, rulesLength: "short rules".length });
	});
});

describe("fitRulesToScreeningForm", () => {
	const limit = MEMBERSHIP_SCREENING_RULES_MAX_LENGTH;

	it("leaves rules within the limit whole, the exact limit included", () => {
		const atLimit = "a".repeat(limit);
		expect(fitRulesToScreeningForm("**1. Be kind**")).toEqual({ rules: "**1. Be kind**", truncated: false });
		expect(fitRulesToScreeningForm(atLimit)).toEqual({ rules: atLimit, truncated: false });
	});

	it("cuts blank line separated rules after the last whole rule that fits", () => {
		const first = `**1.** ${"a".repeat(700)}`;
		const second = `**2.** ${"b".repeat(700)}`;
		const third = `**3.** ${"c".repeat(700)}`;
		expect(fitRulesToScreeningForm([first, second, third].join(RULE_BREAK))).toEqual({ rules: `${first}${RULE_BREAK}${second}`, truncated: true });
	});

	it("keeps a rule whose last character lands exactly on the limit", () => {
		const first = "a".repeat(limit - 10);
		const second = "b".repeat(8);
		const fits = `${first}${RULE_BREAK}${second}`;
		expect(fits).toHaveLength(limit);
		expect(fitRulesToScreeningForm(`${fits}${RULE_BREAK}**3.** more`).rules).toBe(fits);
	});

	it("falls back to the last line break for rules written one per line", () => {
		const lines = Array.from({ length: 40 }, (_, index) => `${index + 1}. ${"x".repeat(60)}`);
		const { rules, truncated } = fitRulesToScreeningForm(lines.join("\n"));
		expect(truncated).toBe(true);
		expect(rules.length).toBeLessThanOrEqual(limit);
		const kept = rules.split("\n");
		expect(kept).toEqual(lines.slice(0, kept.length));
		expect(`${rules}\n${lines[kept.length]}`.length).toBeGreaterThan(limit);
	});
});
