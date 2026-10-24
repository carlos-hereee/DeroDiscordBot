import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	CategoryChannel,
	ChannelType,
	Collection,
	DiscordAPIError,
	GuildExplicitContentFilter,
	GuildOnboardingPromptType,
	GuildVerificationLevel,
	PermissionFlagsBits,
	PermissionsBitField,
	TextChannel,
	TextInputStyle,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type Client,
	type Guild,
	type GuildMember,
	type ModalSubmitInteraction,
} from "discord.js";

// ── Dero Community Onboarding failure matrix (2026-10 item 247 Phase 5) ────
// One describe per row of the master plan's Risk Register, each driving the REAL
// module that row's mitigation lives in, with Mongo (the two stores) and Discord
// (guilds, channels, interactions) faked. A row asserts what the owner or a member
// actually sees when the risk fires, and that nothing is left half written.
//
// Coverage, row by row (the plan is companyuno-growth/product-planning/TODO-PLANS/
// dero-community-onboarding-master-plan-2026-10-23.md, section 4):
//   R1  two overwrite shapes          tested: one helper, both branches, the rollback
//   R2  adoption false positive       tested: no Dero name adopts, Discord's audit reason
//   R3  Community edit refused        tested: Discord's words, one edit, one press retry
//   R4  invalid Onboarding prompts    tested: refused before the write, and the verbatim
//                                     path for what only Discord knows (Gate 4 facts 1, 2)
//   R5  screening text too long       tested: whole rules under 1500, the owner told
//   R6  self destruct and adoption    tested: an adopted channel survives either way
//   R7  announcement double post      tested: one post, a bounded retry, no loop
//   R8  50013 on the admin role grant tested AS BUILT: /setup fails plainly and a rerun
//                                     grants again; applyAdminRole does not tolerate a
//                                     refused grant (accepted as built by the owner)
//   R9  rules modal over 4000         tested AS BUILT: Discord's own input cap, preload cut
//   R10 hand set rulesChannelId       NOT covered: the boot sweep has no parent check to
//                                     test; a stored id that resolves is used where it
//                                     sits (accepted as built by the owner, in the runbook)
//   R11 welcome log flood             tested: the greeter's throttle in its own bucket
// Owner manual (no seam a test can reach): Discord's live answers to the screening
// PATCH and to editOnboarding, Onboarding off as the R4 rollback, and Gates 1 to 4.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	has: vi.fn(),
	log: vi.fn(),
	registerButton: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { has: mocks.has, log: mocks.log } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: mocks.registerButton }));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";
import { greetAllowed } from "@features/greeter/welcomeNewMember.js";
import { execute as runSetupCommand } from "@commands/admin/setup.js";
import { GuildSetupManager } from "@features/setup/GuildSetupManager.js";
import { CommunityGatingAnnouncement } from "@features/setup/CommunityGatingAnnouncement.js";
import { matchesAdoptionPattern, moveIntoNoticeBoard, scanAndClaim } from "@features/setup/adoption.js";
import { communityOverwritesFor, reconcileChannelOverwrite, type IOverwriteEntry, type ManagedOverwriteKind } from "@features/setup/communityOverwrites.js";
import { RULES_EDIT_CUSTOM_ID } from "@features/setup/rulesContent.js";
import { handleRulesEditButton } from "@features/setup/rulesEdit.js";
import { HOMEBASE_CHANNEL_FIELDS, registerSelfDestructHandlers } from "@features/setup/selfDestruct.js";
import { postWelcomeLogEntry } from "@features/setup/welcomeLog.js";
import { handleCommunityButton } from "./communityButtons.js";
import { COMMUNITY_CUSTOM_IDS } from "./communityControls.js";
import { communityCopy } from "./communityCopy.js";
import { MEMBERSHIP_SCREENING_RULES_MAX_LENGTH, buildMembershipScreeningRequest } from "./enableCommunity.js";
import { buildOnboardingDraft, toOnboardingEditOptions, validateOnboardingDraft } from "./onboardingDraft.js";
import { applyPromptEdit } from "./promptEditModal.js";

// ── shared fixtures ──────────────────────────────────────────────────

const OWNER = "owner-1";
const BOT = "bot-1";
const EVERYONE = "everyone";
const MEMBER_ROLE = "role-member";
const ADMIN_ROLE = "role-admin";
const { ViewChannel, SendMessages } = PermissionFlagsBits;
const RULE_BREAK = "\n\n";

// Discord's refusals as discord.js raises them: a 50013 and a 400 with its message.
const missingPermissions = () => new DiscordAPIError({ code: 50013, message: "Missing Permissions" }, 50013, 403, "PATCH", "url", {});
const formRefusal = (message: string) => new DiscordAPIError({ code: 50035, message }, 50035, 400, "PATCH", "url", {});

// Every flow keeps pending picks or drafts in a module map keyed by guild and user,
// so each test takes a fresh guild id and no leftover reaches the next.
let guildCounter = 0;
const nextGuildId = (row: string): string => `${row}-g${++guildCounter}`;

interface ISentMessage {
	content?: string;
	embeds?: Array<{ data: { title?: string; description?: string } }>;
	allowedMentions?: { parse?: string[] };
}
const sent = (fn: ReturnType<typeof vi.fn>, call = 0): ISentMessage => fn.mock.calls[call]![0] as ISentMessage;
const descriptionOf = (fn: ReturnType<typeof vi.fn>, call = 0): string | undefined => sent(fn, call).embeds?.[0]?.data.description;
const auditRows = (event: string): Array<Record<string, unknown>> =>
	mocks.log.mock.calls.filter((call) => call[1] === event).map((call) => call[2] as Record<string, unknown>);

function textChannel<T extends object>(fields: T): TextChannel & T {
	return Object.assign(Object.create(TextChannel.prototype) as TextChannel, fields);
}

function category(id: string, children: Array<{ id: string }>): CategoryChannel & { delete: ReturnType<typeof vi.fn> } {
	const made = Object.create(CategoryChannel.prototype) as CategoryChannel & { delete: ReturnType<typeof vi.fn> };
	Object.defineProperty(made, "id", { value: id });
	Object.defineProperty(made, "children", { value: { cache: new Map(children.map((child) => [child.id, child])) } });
	Object.defineProperty(made, "delete", { value: vi.fn(async () => undefined) });
	return made;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.update.mockResolvedValue(undefined);
	mocks.has.mockResolvedValue(false);
	mocks.log.mockResolvedValue(undefined);
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ── R1: two overwrite shapes maintained forever ─────────────────────────────
// Mitigation: communityOverwrites.ts is the one helper both branches share.
// Rollback: the plan's ladder says a code revert plus a boot cycles guilds back;
// it cannot, because the reconcile is the code a revert removes. What does move a
// gated channel back is Community switched off, read by the next boot's reconcile.

describe("R1: one helper holds both overwrite shapes", () => {
	function overwriteGuild(features: string[]): Guild {
		return { features, ownerId: OWNER, roles: { everyone: { id: EVERYONE } }, client: { user: { id: BOT } } } as unknown as Guild;
	}

	// A channel whose cache already holds these entries, plus one role the owner
	// added by hand, the overwrite a careless set() would delete.
	function channelWith(entries: IOverwriteEntry[]) {
		const foreign = { id: "role-owner-picked", allow: new PermissionsBitField([ViewChannel]), deny: new PermissionsBitField() };
		const cache = new Map<string, { id: string; allow: PermissionsBitField; deny: PermissionsBitField }>(
			entries.map((entry) => [entry.id, { id: entry.id, allow: new PermissionsBitField(entry.allow ?? []), deny: new PermissionsBitField(entry.deny ?? []) }])
		);
		cache.set(foreign.id, foreign);
		return { permissionOverwrites: { cache, set: vi.fn(async () => undefined) }, foreign };
	}

	const roles = { memberRoleId: MEMBER_ROLE, adminRoleId: ADMIN_ROLE };
	const owner = { ownerId: OWNER };
	const stored = { memberRoleId: MEMBER_ROLE, adminRoleId: ADMIN_ROLE };

	it("moves only the public and voice shapes with the Community branch; introductions and the admin channels read the same either way", () => {
		const community = overwriteGuild(["COMMUNITY"]);
		const plain = overwriteGuild([]);
		const kinds: ManagedOverwriteKind[] = ["public", "intro", "admin", "voice"];
		for (const kind of kinds) {
			const gated = communityOverwritesFor(kind, community, owner, roles);
			const open = communityOverwritesFor(kind, plain, owner, roles);
			if (kind === "public" || kind === "voice") expect(gated, kind).not.toEqual(open);
			else expect(gated, kind).toEqual(open);
		}
		// On the open branch @everyone still sees every public channel and both rooms.
		const everyoneOf = (kind: ManagedOverwriteKind) => communityOverwritesFor(kind, plain, owner, roles).find((entry) => entry.id === EVERYONE)!;
		expect(everyoneOf("public").allow).toEqual([ViewChannel]);
		expect(everyoneOf("voice").allow).toEqual([ViewChannel]);
	});

	it("never locks a Community server out of its own channels: no member role, or a member role that is @everyone, keeps the open shape", () => {
		const community = overwriteGuild(["COMMUNITY"]);
		const open = communityOverwritesFor("public", overwriteGuild([]), owner, { memberRoleId: null, adminRoleId: null });
		expect(communityOverwritesFor("public", community, owner, { memberRoleId: null, adminRoleId: null })).toEqual(open);
		const everyoneAsMember = communityOverwritesFor("public", community, owner, { memberRoleId: EVERYONE, adminRoleId: null });
		expect(everyoneAsMember.find((entry) => entry.id === EVERYONE)!.allow).toEqual([ViewChannel]);
	});

	it("the boot reconcile writes exactly the shape the create path builds, keeping the owner's own overwrite", async () => {
		const community = overwriteGuild(["COMMUNITY"]);
		const { permissionOverwrites, foreign } = channelWith(communityOverwritesFor("public", overwriteGuild([]), owner, roles));

		const changed = await reconcileChannelOverwrite(community, { permissionOverwrites } as unknown as TextChannel, "public", stored);

		expect(changed).toBe(true);
		const written = permissionOverwrites.set.mock.calls[0]![0] as unknown[];
		expect(written).toEqual([...communityOverwritesFor("public", community, owner, roles), foreign]);
	});

	it("rollback: Community switched off reopens a gated channel at the next reconcile, once, and leaves it alone after", async () => {
		const plain = overwriteGuild([]);
		const gatedShape = communityOverwritesFor("public", overwriteGuild(["COMMUNITY"]), owner, roles);
		const { permissionOverwrites, foreign } = channelWith(gatedShape);

		expect(await reconcileChannelOverwrite(plain, { permissionOverwrites } as unknown as TextChannel, "public", stored)).toBe(true);
		const reopened = permissionOverwrites.set.mock.calls[0]![0] as IOverwriteEntry[];
		// The open shape has no member role entry, so the gated one's ViewChannel allow
		// is carried over like any overwrite Dero does not manage. It lingers, and it is
		// harmless: @everyone can see the channel again anyway.
		const lingeringMemberAllow = permissionOverwrites.cache.get(MEMBER_ROLE);
		expect(lingeringMemberAllow?.allow.has(ViewChannel)).toBe(true);
		expect(reopened).toEqual([...communityOverwritesFor("public", plain, owner, roles), lingeringMemberAllow, foreign]);
		expect(reopened.find((entry) => entry.id === EVERYONE)!.allow).toEqual([ViewChannel]);

		// The next boot reads the reopened channel and writes nothing.
		const after = channelWith(reopened.filter((entry) => entry.id !== foreign.id));
		expect(await reconcileChannelOverwrite(plain, { permissionOverwrites: after.permissionOverwrites } as unknown as TextChannel, "public", stored)).toBe(false);
		expect(after.permissionOverwrites.set).not.toHaveBeenCalled();
	});
});

// ── R2: adoption takes an unrelated channel ─────────────────────────────────
// Mitigation: exact base name after the leading emoji, never a substring; the move
// keeps every overwrite Dero does not manage and carries a reason Discord's own
// Audit Log shows the owner, which is what makes a wrong move findable and reversible.

describe("R2: adoption never takes a channel it should not", () => {
	const PATTERN_LISTS = { welcomeChannelId: BOT_CONSTANTS.WELCOME_ADOPTION_PATTERNS, rulesChannelId: BOT_CONSTANTS.RULES_ADOPTION_PATTERNS } as const;
	const channelNameSets = { "rok-commander": rokCommanderCopy.setup.channels, "general-events": generalEventsCopy.setup.channels };

	it("no channel name Dero builds, in either pack, matches an adoption list other than its own slot's", () => {
		for (const [pack, names] of Object.entries(channelNameSets)) {
			for (const [slot, name] of Object.entries(names)) {
				const ownList = slot === "welcome" ? "welcomeChannelId" : slot === "rules" ? "rulesChannelId" : null;
				for (const [listSlot, patterns] of Object.entries(PATTERN_LISTS)) {
					expect(matchesAdoptionPattern(name, patterns), `${pack} ${slot} "${name}" against ${listSlot}`).toBe(listSlot === ownList);
				}
			}
		}
	});

	it("passes over Dero's own 👋welcome and 📘rules outside the notice board, which belong to another Dero sharing the server", () => {
		const names = rokCommanderCopy.setup.channels;
		const welcome = textChannel({ id: "other-dero-welcome", name: names.welcome, parentId: "elsewhere", rawPosition: 0 });
		const rules = textChannel({ id: "other-dero-rules", name: names.rules, parentId: "elsewhere", rawPosition: 1 });
		const guild = { channels: { cache: new Map([[welcome.id, welcome], [rules.id, rules]]) } } as unknown as Pick<Guild, "channels">;

		expect(scanAndClaim(guild, { id: "cat-notice" }, BOT_CONSTANTS.WELCOME_ADOPTION_PATTERNS, { names: new Set([names.welcome]) })).toBeNull();
		expect(scanAndClaim(guild, { id: "cat-notice" }, BOT_CONSTANTS.RULES_ADOPTION_PATTERNS, { names: new Set([names.rules]) })).toBeNull();
	});

	it("a move names itself in Discord's Audit Log and keeps the owner's own overwrites, so a wrong one is findable and undoable by hand", async () => {
		const ownerRole = { id: "role-owner-picked" };
		const channel = textChannel({
			id: "server-welcome",
			parentId: "elsewhere",
			setParent: vi.fn(async () => undefined),
			permissionOverwrites: { cache: new Map([[ownerRole.id, ownerRole]]), set: vi.fn(async () => undefined) },
		});
		const shape: IOverwriteEntry[] = [{ id: EVERYONE, allow: [ViewChannel], deny: [SendMessages] }];

		expect(await moveIntoNoticeBoard(channel, { id: "cat-notice" }, shape)).toBe(true);

		const [, parentOptions] = channel.setParent.mock.calls[0] as unknown as [string, { lockPermissions: boolean; reason: string }];
		expect(parentOptions.lockPermissions).toBe(false);
		expect(parentOptions.reason).toMatch(/adopted/i);
		const [written, reason] = channel.permissionOverwrites.set.mock.calls[0] as unknown as [unknown[], string];
		expect(written).toEqual([...shape, ownerRole]);
		expect(reason).toBe(parentOptions.reason);
	});
});

// ── R3 and R5: Enable Community, and the screening form's length ────────────
// R3 mitigation: one guild edit carries COMMUNITY and its four companions, so a
// refusal leaves the guild as it was; Discord's own words reach the owner and the
// picks wait for one more press of Confirm. R5: the form takes whole rules under
// 1500 characters and the owner is told when some were left out.

function enableGuild() {
	return {
		id: nextGuildId("r3"),
		ownerId: OWNER,
		features: ["NEWS"],
		verificationLevel: GuildVerificationLevel.None,
		explicitContentFilter: GuildExplicitContentFilter.Disabled,
		rulesChannelId: null,
		publicUpdatesChannelId: null,
		members: { me: { permissions: { has: () => true } }, cache: new Map(), fetch: vi.fn(async () => null), fetchMe: vi.fn(async () => null) },
		channels: { cache: new Map() },
		edit: vi.fn(async () => undefined),
		client: { rest: { patch: vi.fn(async () => ({})) } },
	};
}

type EnableGuild = ReturnType<typeof enableGuild>;

function communityPress(guild: unknown, customId: string, awaited: unknown = null) {
	return {
		id: `int-${++guildCounter}`,
		customId,
		guild,
		user: { id: OWNER },
		showModal: vi.fn(async () => undefined),
		awaitModalSubmit: vi.fn(async () => {
			if (!awaited) throw new Error("Collector received no interactions before ending with reason: time");
			return awaited;
		}),
		reply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
		update: vi.fn(async () => undefined),
	} as unknown as ButtonInteraction & Record<"showModal" | "reply" | "deferReply" | "editReply" | "deferUpdate" | "update", ReturnType<typeof vi.fn>>;
}

async function pickChannelsAndConfirm(guild: EnableGuild) {
	const submission = {
		guild,
		user: { id: OWNER },
		customId: "community:modal",
		fields: {
			getSelectedChannels: (field: string) => new Collection([[field, { id: field === "rules_channel" ? "rules-ch" : "mods-ch" }]]),
			getCheckbox: () => true,
		},
		reply: vi.fn(async () => undefined),
	} as unknown as ModalSubmitInteraction & { reply: ReturnType<typeof vi.fn> };
	await handleCommunityButton(communityPress(guild, COMMUNITY_CUSTOM_IDS.enable, submission));
	const confirm = communityPress(guild, COMMUNITY_CUSTOM_IDS.confirm);
	await handleCommunityButton(confirm);
	return { submission, confirm };
}

describe("R3: Discord refuses to switch Community on", () => {
	beforeEach(() => {
		mocks.findByGuildId.mockResolvedValue({ adminRoleId: ADMIN_ROLE, customRulesMarkdown: null });
	});

	it("shows Discord's own words, made one edit, wrote no screening form, and keeps the picks for a one press retry", async () => {
		const guild = enableGuild();
		const unseen = "Invalid Form Body\nfeatures[COMMUNITY]: This server needs a prerequisite Dero did not know about";
		guild.edit.mockRejectedValueOnce(formRefusal(unseen));

		const { confirm } = await pickChannelsAndConfirm(guild);

		expect(guild.edit).toHaveBeenCalledOnce();
		expect(guild.client.rest.patch).not.toHaveBeenCalled();
		expect(descriptionOf(confirm.editReply)).toBe(communityCopy.failures.rejected(unseen));
		expect(auditRows(BOT_LOG_EVENTS.COMMUNITY_ENABLED_BY_BOT)[0]).toMatchObject({ outcome: "refused-discord", discordCode: 50035 });

		// The owner fixes the cause in Server Settings and presses Confirm once more.
		const retry = communityPress(guild, COMMUNITY_CUSTOM_IDS.confirm);
		await handleCommunityButton(retry);
		expect(guild.edit).toHaveBeenCalledTimes(2);
		expect(guild.edit.mock.calls[1]![0]).toEqual(guild.edit.mock.calls[0]![0]);
		expect(sent(retry.editReply).embeds![0]!.data.title).toBe(communityCopy.success.title);
	});
});

describe("R5: the rules are longer than the screening form takes", () => {
	const fieldOf = (rules: string) => {
		const request = buildMembershipScreeningRequest(rules);
		const [field] = JSON.parse(String(request.body.form_fields)) as Array<{ values: string[] }>;
		return { request, sentRules: field!.values[0]! };
	};

	it("sends whole rules only, never past 1500 characters, for the pack default and for an owner's long rules", () => {
		const ownerRules = Array.from({ length: 40 }, (_, index) => `**${index + 1}. Rule number ${index + 1}**\nKeep it kind and keep it on topic in every channel.`).join(RULE_BREAK);
		for (const rules of [rokCommanderCopy.channelContent.rules.defaultMarkdown, ownerRules]) {
			const { request, sentRules } = fieldOf(rules);
			expect(rules.length).toBeGreaterThan(MEMBERSHIP_SCREENING_RULES_MAX_LENGTH);
			expect(request.truncated).toBe(true);
			expect(request.rulesLength).toBe(rules.length);
			expect(sentRules.length).toBeLessThanOrEqual(MEMBERSHIP_SCREENING_RULES_MAX_LENGTH);
			// Every block sent is a whole block of the original, in order.
			expect(rules.startsWith(sentRules)).toBe(true);
			expect(rules.split(RULE_BREAK)).toEqual(expect.arrayContaining(sentRules.split(RULE_BREAK)));
		}
	});

	it("tells the owner in the review that some rules were left out of the form", async () => {
		mocks.findByGuildId.mockResolvedValue({ adminRoleId: ADMIN_ROLE, customRulesMarkdown: null });
		const { submission } = await pickChannelsAndConfirm(enableGuild());
		expect(descriptionOf(submission.reply)).toContain(communityCopy.rulesCutNotice(MEMBERSHIP_SCREENING_RULES_MAX_LENGTH));
	});
});

// ── R4: Configure Onboarding writes prompts Discord would refuse ────────────
// Mitigation: the draft's own checks (the final question's shape, every role an
// answer gives below Dero's highest) run at open and again at Confirm, before
// guild.editOnboarding. What only Discord can judge (its 7 default channel rule,
// answers that give nothing: the Phase 5 facts 1 and 2) comes back verbatim and the
// draft waits for a retry. The row's rollback, Onboarding off, is owner manual.

const ONBOARDING_SENDABLE = 6;

function onboardingGuild(options: { memberRolePosition?: number; extraRoles?: Array<{ id: string; name: string; position: number }>; live?: unknown } = {}) {
	const channelIds = ["intro", ...Array.from({ length: ONBOARDING_SENDABLE - 1 }, (_, index) => `open-${index}`)];
	const channels = new Map(
		channelIds.map((id) => [
			id,
			{ id, type: ChannelType.GuildText, permissionsFor: (role: { id: string }) => ({ has: (flags: bigint[]) => role.id === EVERYONE && flags.includes(SendMessages) }) },
		])
	);
	const roles = new Map([[MEMBER_ROLE, { id: MEMBER_ROLE, name: "Member", position: options.memberRolePosition ?? 2 }]]);
	for (const role of options.extraRoles ?? []) roles.set(role.id, role);
	return {
		id: nextGuildId("r4"),
		ownerId: OWNER,
		features: ["COMMUNITY"],
		roles: { everyone: { id: EVERYONE }, cache: roles },
		members: { me: { permissions: { has: () => true }, roles: { highest: { position: 5 } } }, cache: new Map(), fetch: vi.fn(async () => null) },
		channels: { cache: channels },
		fetchOnboarding: vi.fn(async () => options.live ?? { enabled: false, prompts: new Collection(), defaultChannels: new Collection() }),
		editOnboarding: vi.fn(async () => ({})),
		fetchOwner: vi.fn(async () => ({ send: vi.fn(async () => undefined) })),
	};
}

describe("R4: an Onboarding config Discord would refuse", () => {
	beforeEach(() => {
		mocks.findByGuildId.mockResolvedValue({ adminRoleId: ADMIN_ROLE, memberRoleId: MEMBER_ROLE, introChannelId: "intro" });
	});

	it("refuses at open a server question whose answer gives a role above Dero, and never writes", async () => {
		const live = {
			enabled: true,
			defaultChannels: new Collection(),
			prompts: new Collection([
				[
					"p-1",
					{
						id: "p-1",
						title: "Pick a side",
						singleSelect: false,
						required: false,
						inOnboarding: true,
						type: GuildOnboardingPromptType.MultipleChoice,
						options: new Collection([["o-1", { id: "o-1", title: "Mods", description: null, roles: new Collection([["role-mod", undefined]]), channels: new Collection(), emoji: null }]]),
					},
				],
			]),
		};
		const guild = onboardingGuild({ live, extraRoles: [{ id: "role-mod", name: "Mod", position: 9 }] });

		const press = communityPress(guild, COMMUNITY_CUSTOM_IDS.configure);
		await handleCommunityButton(press);

		expect(guild.editOnboarding).not.toHaveBeenCalled();
		expect(descriptionOf(press.editReply)).toBe(communityCopy.onboarding.draftErrors.roleAboveBot("Mod"));
	});

	it("refuses at Confirm when the member role was moved above Dero after the review, keeps the draft, and writes once it is fixed", async () => {
		const guild = onboardingGuild();
		await handleCommunityButton(communityPress(guild, COMMUNITY_CUSTOM_IDS.configure));

		guild.roles.cache.get(MEMBER_ROLE)!.position = 9;
		const refused = communityPress(guild, COMMUNITY_CUSTOM_IDS.confirmOnboarding);
		await handleCommunityButton(refused);
		expect(guild.editOnboarding).not.toHaveBeenCalled();
		expect(descriptionOf(refused.reply)).toBe(communityCopy.onboarding.preconditions.memberRoleAboveBot("Member"));

		guild.roles.cache.get(MEMBER_ROLE)!.position = 2;
		await handleCommunityButton(communityPress(guild, COMMUNITY_CUSTOM_IDS.confirmOnboarding));
		expect(guild.editOnboarding).toHaveBeenCalledOnce();
	});

	it("shows Discord's refusal verbatim at Confirm (its 7 default channel rule is one) and keeps the review for a retry", async () => {
		const guild = onboardingGuild();
		await handleCommunityButton(communityPress(guild, COMMUNITY_CUSTOM_IDS.configure));
		const discordMessage = "Invalid Form Body\ndefault_channel_ids: Onboarding requires at least 7 default channels";
		guild.editOnboarding.mockRejectedValueOnce(formRefusal(discordMessage));

		const confirm = communityPress(guild, COMMUNITY_CUSTOM_IDS.confirmOnboarding);
		await handleCommunityButton(confirm);

		const reply = confirm.editReply.mock.calls[0]![0] as { embeds: Array<{ data: { description?: string } }>; components: unknown[] };
		expect(reply.embeds.at(-1)!.data.description).toBe(communityCopy.onboarding.failures.rejected(discordMessage));
		expect(reply.components.length).toBeGreaterThan(0);
		expect(auditRows(BOT_LOG_EVENTS.ONBOARDING_CONFIGURED_BY_BOT)[0]).toMatchObject({ outcome: "refused-discord", discordCode: 50035 });

		await handleCommunityButton(communityPress(guild, COMMUNITY_CUSTOM_IDS.confirmOnboarding));
		expect(guild.editOnboarding).toHaveBeenCalledTimes(2);
	});

	it("lets the owner clear both optional questions and write the final one alone, if Discord refuses answers that give nothing", () => {
		const guild = onboardingGuild() as unknown as Guild;
		const built = buildOnboardingDraft({ guild, stored: { memberRoleId: MEMBER_ROLE, introChannelId: "intro" }, copy: communityCopy.onboarding, current: null });
		if (!built.ok) throw new Error(`the starter draft was refused: ${built.reason}`);

		let draft = built.draft;
		for (let cleared = 0; cleared < 2; cleared += 1) {
			const edit = applyPromptEdit(draft, 0, { title: draft.prompts[0]!.title, optionsText: "" });
			if (!edit.ok) throw new Error(`clearing a question was refused: ${edit.reason}`);
			draft = edit.draft;
		}

		expect(validateOnboardingDraft(guild, draft, communityCopy.onboarding)).toBeNull();
		const write = toOnboardingEditOptions(draft, communityCopy.onboarding.auditReason);
		expect(write.prompts).toHaveLength(1);
		const [final] = [...(write.prompts ?? [])] as Array<{ required: boolean; singleSelect: boolean; options: Array<{ roles: string[] }> }>;
		expect(final).toMatchObject({ required: true, singleSelect: true });
		expect(final!.options.map((option) => option.roles)).toEqual([[MEMBER_ROLE]]);
	});
});

// ── R6: /self-destruct loses track of an adopted channel ────────────────────
// Mitigation: both delete loops skip every id on adoptedChannelIds, so an adopted
// channel survives whether a slot still points at it or not.

describe("R6: an adopted channel survives /self-destruct", () => {
	it("keeps a slot's adopted channel and one no slot points at any more, deletes every channel Dero built, and releases the slot", async () => {
		const stored: Record<string, unknown> = Object.fromEntries(HOMEBASE_CHANNEL_FIELDS.map((field) => [field, `ch-${field}`]));
		stored.rulesChannelId = "own-rules";
		stored.categoryId = "cat-home";
		stored.gamesCategoryId = "cat-games";
		// "old-welcome" was adopted and later replaced in its slot; it still sits in the
		// notice board and still carries the owner's messages.
		stored.adoptedChannelIds = ["own-rules", "old-welcome"];
		mocks.findByGuildId.mockResolvedValue(stored);

		const deletable = (id: string) => ({ id, delete: vi.fn(async () => undefined) });
		const channels = new Map<string, { id: string; delete: ReturnType<typeof vi.fn> }>(HOMEBASE_CHANNEL_FIELDS.map((field) => [`ch-${field}`, deletable(`ch-${field}`)]));
		const ownRules = deletable("own-rules");
		const oldWelcome = deletable("old-welcome");
		channels.set(ownRules.id, ownRules);
		const home = category("cat-home", [ownRules, oldWelcome]);
		const games = category("cat-games", []);
		const fetchable = new Map<string, unknown>([...channels, ["cat-home", home], ["cat-games", games]]);
		const guild = { id: nextGuildId("r6"), ownerId: OWNER, channels: { fetch: vi.fn(async (id: string) => fetchable.get(id) ?? null) } };
		const interaction = {
			customId: "self_destruct:confirm",
			user: { id: OWNER },
			guild,
			client: {},
			update: vi.fn(async () => undefined),
			followUp: vi.fn(async () => undefined),
		} as unknown as ButtonInteraction;

		registerSelfDestructHandlers();
		const handler = mocks.registerButton.mock.calls.at(-1)![1] as (press: ButtonInteraction) => Promise<void>;
		await handler(interaction);

		expect(ownRules.delete).not.toHaveBeenCalled();
		expect(oldWelcome.delete).not.toHaveBeenCalled();
		for (const field of HOMEBASE_CHANNEL_FIELDS) {
			if (field === "rulesChannelId") continue;
			expect(channels.get(`ch-${field}`)!.delete, field).toHaveBeenCalledOnce();
		}
		expect(home.delete).toHaveBeenCalledOnce();
		expect(mocks.update).toHaveBeenCalledWith(guild.id, { homebaseDestroyed: true, setupComplete: false, rulesChannelId: null, adoptedChannelIds: [] });
	});
});

// ── R7: the one time gating announcement posts twice ────────────────────────
// Mitigation: the BotLog key is read before and written only after both posts, so
// a second boot posts nothing, and a failure between the two posts costs at most a
// repeated admin post on the retry, never a loop.

describe("R7: the gating announcement posts once", () => {
	function announcementRig(failPublicOnce = false) {
		const admin = textChannel({ id: "ch-admin", send: vi.fn(async () => ({})) });
		const announcements = textChannel({ id: "ch-announcements", send: vi.fn(async () => ({})) });
		if (failPublicOnce) announcements.send.mockRejectedValueOnce(missingPermissions());
		const byId = new Map<string, unknown>([[admin.id, admin], [announcements.id, announcements]]);
		const client = { channels: { fetch: vi.fn(async (id: string) => byId.get(id) ?? null) } } as unknown as Client;
		const guild = { id: nextGuildId("r7") } as Guild;
		const stored = { announcementsChannelId: announcements.id, adminChannelId: admin.id, memberRoleId: MEMBER_ROLE };
		// The key behaves like the real store: has() sees what log() wrote.
		const logged = new Set<string>();
		mocks.has.mockImplementation(async (guildId: string, event: string) => logged.has(`${guildId}:${event}`));
		mocks.log.mockImplementation(async (guildId: string, event: string) => void logged.add(`${guildId}:${event}`));
		return { admin, announcements, client, guild, stored };
	}

	it("posts both, with no pings, and a second boot posts nothing", async () => {
		const { admin, announcements, client, guild, stored } = announcementRig();

		expect(await CommunityGatingAnnouncement.post(client, guild, stored)).toBe("posted");
		expect(await CommunityGatingAnnouncement.post(client, guild, stored)).toBe("already-announced");

		expect(admin.send).toHaveBeenCalledOnce();
		expect(announcements.send).toHaveBeenCalledOnce();
		expect(sent(announcements.send).allowedMentions).toEqual({ parse: [] });
		expect(auditRows(BOT_LOG_EVENTS.MEMBER_ROLE_GATING_ANNOUNCED)).toHaveLength(1);
	});

	it("a public post that fails leaves the key unset; the retry repeats only the admin post and then stops", async () => {
		const { admin, announcements, client, guild, stored } = announcementRig(true);

		expect(await CommunityGatingAnnouncement.post(client, guild, stored)).toBe("failed");
		expect(auditRows(BOT_LOG_EVENTS.MEMBER_ROLE_GATING_ANNOUNCED)).toHaveLength(0);
		expect(await CommunityGatingAnnouncement.post(client, guild, stored)).toBe("posted");
		expect(await CommunityGatingAnnouncement.post(client, guild, stored)).toBe("already-announced");

		expect(admin.send).toHaveBeenCalledTimes(2);
		// Two calls, one of which Discord refused: members saw it once.
		expect(announcements.send).toHaveBeenCalledTimes(2);
	});
});

// ── R8: a 50013 while /setup grants the admin role ──────────────────────────
// AS BUILT, not as the row describes it. applyAdminRole does NOT tolerate a refused
// grant: the refusal propagates, the grants after it are not made, and setupComplete
// is never written. What protects the owner is /setup itself, which answers its
// plain failure line, and the unwritten flag, which lets a rerun grant every channel.

describe("R8: a refused grant during /setup", () => {
	const REFUSED_CHANNEL = "ch-welcomeChannelId";

	function setupRig() {
		const stored: Record<string, unknown> = Object.fromEntries(GuildSetupManager.CHANNEL_SPECS.map((spec) => [spec.configField, `ch-${spec.configField}`]));
		Object.assign(stored, { guildId: nextGuildId("r8"), categoryId: "cat-home", gamesCategoryId: "cat-games", setupComplete: false, homebaseDestroyed: false });
		mocks.findByGuildId.mockResolvedValue(stored);

		let refuse = true;
		const granted: string[] = [];
		const channelFor = (id: string) => ({
			id,
			isTextBased: () => false,
			permissionOverwrites: {
				create: vi.fn(async () => {
					if (refuse && id === REFUSED_CHANNEL) throw missingPermissions();
					granted.push(id);
				}),
			},
		});
		const guild = { id: stored.guildId, ownerId: OWNER, features: [], roles: { everyone: { id: EVERYONE } }, channels: { fetch: vi.fn(async (id: string) => channelFor(id)) } };
		const run = async () => {
			const interaction = {
				guildId: stored.guildId,
				guild,
				user: { id: OWNER },
				options: { getRole: (name: string) => ({ id: name === "admin-role" ? ADMIN_ROLE : MEMBER_ROLE }) },
				reply: vi.fn(async () => undefined),
				editReply: vi.fn(async () => undefined),
			};
			await runSetupCommand(interaction as unknown as ChatInputCommandInteraction);
			return interaction;
		};
		return { run, granted, allow: () => void (refuse = false) };
	}

	it("answers /setup's plain failure line, never marks setup complete, and a rerun grants every channel", async () => {
		const { run, granted, allow } = setupRig();

		const failed = await run();
		expect(descriptionOf(failed.editReply)).toBe(rokCommanderCopy.responses.setupFailed);
		expect(mocks.update).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ setupComplete: true }));
		expect(granted).not.toContain("ch-rulesChannelId");

		allow();
		const rerun = await run();
		expect(sent(rerun.editReply).embeds![0]!.data.title).toBe(rokCommanderCopy.responses.setupSuccess(ADMIN_ROLE).title);
		expect(granted).toContain(REFUSED_CHANNEL);
		expect(mocks.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ setupComplete: true }));
	});
});

// ── R9: the Edit rules submit is longer than Discord's input allows ─────────
// AS BUILT. The modal's paragraph input carries Discord's own 4000 character cap,
// which Discord enforces before a submit can exist, so nothing over it ever reaches
// Dero and there is no server side cut or notice. The preload is cut to the cap too,
// because a value longer than the input allows makes Discord reject the whole modal.

describe("R9: the Edit rules modal stays inside Discord's input cap", () => {
	it("opens with a paragraph input capped at 4000 and a preload cut to fit, even for stored rules longer than that", async () => {
		mocks.findByGuildId.mockResolvedValue({ adminRoleId: ADMIN_ROLE, customRulesMarkdown: "r".repeat(BOT_CONSTANTS.RULES_MARKDOWN_MAX_LENGTH + 1000) });
		const interaction = {
			id: "int-r9",
			customId: RULES_EDIT_CUSTOM_ID,
			guild: { id: nextGuildId("r9"), ownerId: OWNER },
			user: { id: OWNER },
			message: null,
			showModal: vi.fn(async () => undefined),
			awaitModalSubmit: vi.fn(async () => {
				throw new Error("Collector received no interactions before ending with reason: time");
			}),
			reply: vi.fn(async () => undefined),
		};

		await handleRulesEditButton(interaction as unknown as ButtonInteraction);

		const modal = (interaction.showModal.mock.calls[0] as unknown as [{ toJSON(): { components: Array<{ components: Array<{ style: number; max_length: number; value: string }> }> } }])[0].toJSON();
		const input = modal.components[0]!.components[0]!;
		expect(BOT_CONSTANTS.RULES_MARKDOWN_MAX_LENGTH).toBeLessThanOrEqual(4000);
		expect(input.style).toBe(TextInputStyle.Paragraph);
		expect(input.max_length).toBe(BOT_CONSTANTS.RULES_MARKDOWN_MAX_LENGTH);
		expect(input.value.length).toBe(BOT_CONSTANTS.RULES_MARKDOWN_MAX_LENGTH);
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

// ── R11: a raid floods the welcome log ──────────────────────────────────────
// Mitigation: the greeter's throttle (8 a minute per guild, GREET_BURST in
// features/greeter/welcomeNewMember.ts) in a bucket of its own, so the log never
// spends the welcome's budget and the welcome never spends the log's.

describe("R11: a raid on the welcome log", () => {
	const GREET_BURST = 8;

	it("posts at most 8 lines a minute, skips bots, pings nobody, and leaves the greeter's own budget untouched", async () => {
		const guildId = nextGuildId("r11");
		mocks.findByGuildId.mockResolvedValue({ welcomeChannelId: "ch-welcome" });
		const welcome = textChannel({ id: "ch-welcome", send: vi.fn(async () => ({})) });
		const client = { channels: { fetch: vi.fn(async () => welcome) } };
		const member = (index: number, bot = false) =>
			({ id: `m-${index}`, displayName: `Raider ${index}`, user: { bot }, guild: { id: guildId }, client }) as unknown as GuildMember;

		expect(await postWelcomeLogEntry(member(0, true), "join")).toBe(false);
		const posted = await Promise.all(Array.from({ length: 20 }, (_, index) => postWelcomeLogEntry(member(index + 1), "join")));

		expect(posted.filter(Boolean)).toHaveLength(GREET_BURST);
		expect(welcome.send).toHaveBeenCalledTimes(GREET_BURST);
		expect(sent(welcome.send).allowedMentions).toEqual({ parse: [] });
		expect(greetAllowed(guildId)).toBe(true);
	});
});
