import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, Collection, PermissionFlagsBits, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";

// ── onboardingChannelGap (2026-11 item 367) ─────────────────────────────
// The channel gap flow the way Discord delivers it: the Configure Onboarding press on a
// server short of channels everyone can post in opens the modal through the router, its
// Submit posts the review, Confirm opens and creates channels and drafts Onboarding in
// the same press. Plus the pure pieces: the names parser, which channels and categories
// may be offered, the shortfall rule, the modal's caps, and both copy packs' suggestions.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	log: vi.fn(),
	emitFor: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: vi.fn() } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log, has: vi.fn(async () => false) } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: vi.fn(), registerModal: vi.fn(), registerSelectMenu: vi.fn() }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emitFor: mocks.emitFor, emit: vi.fn(), write: vi.fn() } }));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";
import { matchesAdoptionPattern } from "@features/setup/adoption.js";
import { handleCommunityButton } from "./communityButtons.js";
import { COMMUNITY_CUSTOM_IDS } from "./communityControls.js";
import { communityCopy } from "./communityCopy.js";
import {
	GAP_NEW_CHANNELS_MAX,
	SELECT_OPTIONS_MAX,
	buildChannelGapModal,
	categoryOptions,
	channelShortfall,
	openableChannels,
	parseChannelNames,
	readChannelGapView,
	suggestedChannelNames,
} from "./onboardingChannelGap.js";

const OWNER = "owner-1";
const ADMIN = "admin-1";
const BOT = "bot-1";
const EVERYONE = "everyone-role";
const MEMBER_ROLE = "role-member";
const ADMIN_ROLE = "role-admin";
const ONBOARDING_CHANNEL = "hq-onboarding";
const { ViewChannel, SendMessages } = PermissionFlagsBits;
const gap = communityCopy.onboardingGap;

// The stored row: Dero's three managed categories, an adopted channel, and 🧭onboarding.
const baseRow = {
	adminRoleId: ADMIN_ROLE,
	memberRoleId: MEMBER_ROLE,
	introChannelId: "intro",
	categoryId: "cat-notice",
	gamesCategoryId: "cat-arcade",
	headquartersCategoryId: "cat-hq",
	announcementsChannelId: "dero-announcements",
	adoptedChannelIds: ["adopted"],
	onboardingConfigChannelId: ONBOARDING_CHANNEL,
};

let guildCounter = 0;
let interactionCounter = 0;

interface IChannelSpec {
	id: string;
	name?: string;
	type?: ChannelType;
	parentId?: string | null;
	position?: number;
	view?: boolean;
	send?: boolean;
	/** Whether Dero holds View, Manage Roles and Send in the channel. */
	deroCan?: boolean;
}

// A channel whose resolved permissions answer for @everyone and for Dero's own member,
// and whose @everyone edit really opens it, so the recount after Confirm sees the change.
function fakeChannel(spec: IChannelSpec) {
	const state = { view: spec.view ?? true, send: spec.send ?? false };
	return {
		id: spec.id,
		name: spec.name ?? spec.id,
		type: spec.type ?? ChannelType.GuildText,
		parentId: spec.parentId ?? null,
		position: spec.position ?? 0,
		permissionsFor: (target: { id: string }) => ({
			has: (flags: bigint | bigint[]) => {
				const asked = Array.isArray(flags) ? flags : [flags];
				if (target.id === BOT) return spec.deroCan ?? true;
				if (target.id !== EVERYONE) return false;
				return asked.every((flag) => (flag === ViewChannel ? state.view : flag === SendMessages ? state.send : false));
			},
		}),
		permissionOverwrites: {
			edit: vi.fn(async (_role: unknown, options: { ViewChannel?: boolean; SendMessages?: boolean }) => {
				if (options.ViewChannel) state.view = true;
				if (options.SendMessages) state.send = true;
			}),
		},
	};
}

type FakeChannel = ReturnType<typeof fakeChannel>;

// Three channels everyone can post in (two short of Discord's five), plus whatever a test adds.
function makeGuild(extra: IChannelSpec[] = [], options: { manageChannels?: boolean } = {}) {
	guildCounter += 1;
	const specs: IChannelSpec[] = [{ id: "intro", send: true }, { id: "chat-1", send: true }, { id: "chat-2", send: true }, ...extra];
	const cache = new Map<string, FakeChannel>(specs.map((spec) => [spec.id, fakeChannel(spec)]));
	let created = 0;
	const owner = { send: vi.fn(async () => undefined) };
	return {
		id: `gap-g${guildCounter}`,
		ownerId: OWNER,
		features: ["COMMUNITY"],
		client: { user: { id: BOT } },
		roles: { everyone: { id: EVERYONE }, cache: new Map([[MEMBER_ROLE, { id: MEMBER_ROLE, name: "Member", position: 2 }]]) },
		members: {
			me: { id: BOT, permissions: { has: (flag: bigint) => (flag === PermissionFlagsBits.ManageChannels ? options.manageChannels ?? true : true) }, roles: { highest: { position: 5 } } },
			cache: new Map([[ADMIN, { roles: { cache: new Set([ADMIN_ROLE]) } }]]),
			fetch: vi.fn(async () => null),
		},
		channels: {
			cache,
			create: vi.fn(async (input: { name: string; type: ChannelType; parent?: string | null }) => {
				created += 1;
				const channel = fakeChannel({ id: `created-${created}`, name: input.name, type: input.type, parentId: input.parent ?? null, send: input.type === ChannelType.GuildText });
				cache.set(channel.id, channel);
				return channel;
			}),
		},
		fetchOnboarding: vi.fn(async () => ({ enabled: false, prompts: new Collection(), defaultChannels: new Collection() })),
		editOnboarding: vi.fn(async () => ({})),
		fetchOwner: vi.fn(async () => owner),
	};
}

type FakeGuild = ReturnType<typeof makeGuild>;

// 🧭onboarding as the client resolves it; every post there is recorded.
const onboardingChannel = { id: ONBOARDING_CHANNEL, isSendable: () => true, send: vi.fn(async () => ({ id: "posted" })) };
const client = { channels: { fetch: vi.fn(async (id: string) => (id === ONBOARDING_CHANNEL ? onboardingChannel : null)) } };

function press(guild: FakeGuild, userId: string, customId: string, submission: unknown = null) {
	interactionCounter += 1;
	// The acknowledgements flip `deferred` as discord.js does, which is what tells
	// answerInChannel that a press was already answered.
	const state = { deferred: false };
	const acknowledge = vi.fn(async () => {
		state.deferred = true;
	});
	return {
		get deferred() {
			return state.deferred;
		},
		id: `gap-int-${interactionCounter}`,
		customId,
		guild,
		guildId: guild.id,
		user: { id: userId },
		client,
		replied: false,
		isModalSubmit: () => false,
		isMessageComponent: () => true,
		reply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => {
			state.deferred = true;
		}),
		deleteReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		deferUpdate: acknowledge,
		update: vi.fn(async () => undefined),
		showModal: vi.fn(async () => undefined),
		awaitModalSubmit: vi.fn(async () => (submission ? submission : Promise.reject(new Error("dismissed")))),
	} as unknown as ButtonInteraction & Record<"reply" | "followUp" | "deferReply" | "editReply" | "deferUpdate" | "update" | "showModal" | "awaitModalSubmit", ReturnType<typeof vi.fn>>;
}

// A Submit carrying the open picks (left out when the modal had no open select), the
// category value and the names box.
function submit(guild: FakeGuild, userId: string, picks: { open?: string[]; category?: string; names?: string }) {
	interactionCounter += 1;
	const present = new Set(["gap_category", "gap_names", ...(picks.open ? ["gap_open"] : [])]);
	return {
		id: `gap-sub-${interactionCounter}`,
		customId: "community:gapmodal:any",
		guild,
		guildId: guild.id,
		user: { id: userId },
		client,
		deferred: false,
		replied: false,
		isModalSubmit: () => true,
		isMessageComponent: () => false,
		isFromMessage: () => true,
		fields: {
			fields: present,
			getStringSelectValues: (id: string) => (id === "gap_open" ? (picks.open ?? []) : [picks.category ?? "new"]),
			getTextInputValue: () => picks.names ?? "",
		},
		reply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		deleteReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	} as unknown as ModalSubmitInteraction & Record<"reply" | "followUp" | "deferUpdate", ReturnType<typeof vi.fn>>;
}

interface IPosted {
	content?: string;
	embeds?: Array<{ data: { title?: string; description?: string } }>;
	components?: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>;
}
const posted = (fn: ReturnType<typeof vi.fn>, call: number): IPosted => fn.mock.calls[call]![0] as IPosted;
const customIdsOf = (message: IPosted): Array<string | undefined> => (message.components ?? []).flatMap((row) => row.toJSON().components.map((component) => component.custom_id));
const textOf = (message: IPosted): string => [message.content ?? "", ...(message.embeds ?? []).map((embed) => `${embed.data.title ?? ""}\n${embed.data.description ?? ""}`)].join("\n");
type NoticeJson = { custom_id: string; components: Array<{ content?: string }> };
const noticeText = (interaction: { showModal: ReturnType<typeof vi.fn> }): string | undefined =>
	interaction.showModal.mock.calls
		.map((call) => (call[0] as { toJSON(): NoticeJson }).toJSON())
		.find((modal) => modal.custom_id.startsWith("notice:"))
		?.components.map((component) => component.content)
		.join("\n");
const auditRows = (): Array<Record<string, unknown>> =>
	mocks.log.mock.calls.filter((call) => call[1] === BOT_LOG_EVENTS.ONBOARDING_CHANNELS_FILLED).map((call) => call[2] as Record<string, unknown>);

// Press Configure Onboarding with a Submit waiting, so the review posts; then Confirm.
async function pressAndSubmit(guild: FakeGuild, picks: { open?: string[]; category?: string; names?: string }, userId = OWNER) {
	const submission = submit(guild, userId, picks);
	await handleCommunityButton(press(guild, userId, COMMUNITY_CUSTOM_IDS.configure, submission));
	return submission;
}
async function confirm(guild: FakeGuild, userId = OWNER) {
	const interaction = press(guild, userId, COMMUNITY_CUSTOM_IDS.gapConfirm);
	await handleCommunityButton(interaction);
	return interaction;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId.mockResolvedValue({ ...baseRow });
	mocks.log.mockResolvedValue(undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ── the names box ────────────────────────────────────────────────────

describe("parseChannelNames", () => {
	const none = new Set<string>();

	it("keeps the leading emoji attached and slugs the rest, one channel per line", () => {
		expect(parseChannelNames("💬 Off Topic!!\n\n 🎬clips \n👩‍💻 dev talk\n3️⃣ three", none)).toEqual({ ok: true, names: ["💬off-topic", "🎬clips", "👩‍💻dev-talk", "3️⃣three"] });
	});

	it("accepts a name with no emoji, and an empty box as no new channels", () => {
		expect(parseChannelNames("general two", none)).toEqual({ ok: true, names: ["general-two"] });
		expect(parseChannelNames("  \n ", none)).toEqual({ ok: true, names: [] });
	});

	it("refuses a sixth line, a server emoji, an empty slug, a duplicate and an existing name, each with one sentence", () => {
		const six = Array.from({ length: GAP_NEW_CHANNELS_MAX + 1 }, (_, index) => `room ${index}`).join("\n");
		expect(parseChannelNames(six, none)).toEqual({ ok: false, reason: gap.names.tooManyLines(GAP_NEW_CHANNELS_MAX) });
		expect(parseChannelNames("ok\n<:pog:123456> hype", none)).toEqual({ ok: false, reason: gap.names.customEmoji(2) });
		expect(parseChannelNames("💬 !!!", none)).toEqual({ ok: false, reason: gap.names.emptyName(1) });
		expect(parseChannelNames("💬 chat\n💬 Chat", none)).toEqual({ ok: false, reason: gap.names.duplicate(2, "💬chat") });
		expect(parseChannelNames("💬 chat", new Set(["💬chat"]))).toEqual({ ok: false, reason: gap.names.exists(1, "💬chat") });
	});

	it("refuses a name past Discord's 100 characters and one Dero reserves for its welcome or rules channel", () => {
		expect(parseChannelNames(`💬 ${"a".repeat(100)}`, none)).toEqual({ ok: false, reason: gap.names.tooLong(1, 100) });
		expect(parseChannelNames("👋 welcome", none)).toEqual({ ok: false, reason: gap.names.reserved(1, "👋welcome") });
		expect(parseChannelNames("📘 Rules", none)).toEqual({ ok: false, reason: gap.names.reserved(1, "📘rules") });
	});
});

describe("the packs' suggestions", () => {
	it.each([
		["rok-commander", rokCommanderCopy],
		["general-events", generalEventsCopy],
	])("%s has at least 6 emoji first suggestions that parse as written and are never reserved", (_id, pack) => {
		const { suggestions } = pack.onboardingChannelGap;
		expect(suggestions.length).toBeGreaterThanOrEqual(6);
		expect(parseChannelNames(suggestions.slice(0, GAP_NEW_CHANNELS_MAX).join("\n"), new Set())).toEqual({ ok: true, names: suggestions.slice(0, GAP_NEW_CHANNELS_MAX) });
		for (const name of suggestions) {
			expect(matchesAdoptionPattern(name, [...BOT_CONSTANTS.WELCOME_ADOPTION_PATTERNS, ...BOT_CONSTANTS.RULES_ADOPTION_PATTERNS])).toBe(false);
		}
	});

	it("prefills exactly the count needed, skipping a suggestion the server already has", () => {
		expect(suggestedChannelNames(["💬chat", "🎬clips", "🎮gaming"], new Set(["💬chat"]), 2)).toEqual(["🎬clips", "🎮gaming"]);
	});
});

describe("channelShortfall", () => {
	it("counts opened and created channels against the number needed", () => {
		expect(channelShortfall(2, { openChannelIds: ["a"], newChannelNames: [] })).toBe(1);
		expect(channelShortfall(2, { openChannelIds: ["a"], newChannelNames: ["b"] })).toBe(0);
	});
});

// ── what may be opened, and where new channels go ────────────────────

describe("openableChannels", () => {
	it("offers only the server's own visible, not yet sendable channels Dero can change, in channel order", () => {
		const guild = makeGuild([
			{ id: "eligible-b", position: 4 },
			{ id: "eligible-a", position: 1 },
			{ id: "hidden", view: false },
			{ id: "already-open", send: true },
			{ id: "dero-announcements" },
			{ id: "adopted" },
			{ id: "notice-child", parentId: "cat-notice" },
			{ id: "hq-child", parentId: "cat-hq" },
			{ id: "spectator-room", parentId: "cat-arcade" },
			{ id: "locked-from-dero", deroCan: false },
			{ id: "rules-like", name: "📜server-rules" },
			{ id: "voice", type: ChannelType.GuildVoice },
		]);
		expect(openableChannels(guild as never, baseRow).map((channel) => channel.id)).toEqual(["eligible-a", "eligible-b"]);
	});

	it("keeps the first 25", () => {
		const guild = makeGuild(Array.from({ length: 30 }, (_, index) => ({ id: `ro-${index}`, position: index })));
		expect(openableChannels(guild as never, baseRow)).toHaveLength(SELECT_OPTIONS_MAX);
	});
});

describe("categoryOptions", () => {
	const category = (id: string, name: string, position = 0): IChannelSpec => ({ id, name, type: ChannelType.GuildCategory, position });

	it("leads with the new pack category, then No category, then the server's own, leaving out Dero's three", () => {
		const guild = makeGuild([category("cat-notice", "🪧 NOTICE BOARD"), category("cat-arcade", "🎮 ARCADE GAMES"), category("cat-hq", "🏰 DERO HEADQUARTERS"), category("own", "Lounge", 3)]);
		expect(categoryOptions(guild as never, baseRow, "🍺 THE COMMONS")).toEqual([
			{ label: gap.modal.categoryNew("🍺 THE COMMONS"), value: "new", isDefault: true },
			{ label: gap.modal.categoryNone, value: "none", isDefault: false },
			{ label: "Lounge", value: "own", isDefault: false },
		]);
	});

	it("offers an existing category of the pack's name first instead of building a duplicate, and fits 25", () => {
		const guild = makeGuild([category("commons", "🍺 THE COMMONS", 9), ...Array.from({ length: 30 }, (_, index) => category(`c-${index}`, `C ${index}`, index))]);
		const options = categoryOptions(guild as never, baseRow, "🍺 THE COMMONS");
		expect(options[0]).toEqual({ label: "🍺 THE COMMONS", value: "commons", isDefault: true });
		expect(options.filter((option) => option.value === "commons")).toHaveLength(1);
		expect(options).toHaveLength(SELECT_OPTIONS_MAX);
	});
});

describe("buildChannelGapModal", () => {
	type ModalJson = { title: string; components: Array<{ type: number; component?: { custom_id: string; options?: unknown[]; max_values?: number; value?: string } }> };

	it("holds at most 5 components and no select over 25 options, prefilled with the needed suggestions", () => {
		const guild = makeGuild([
			...Array.from({ length: 30 }, (_, index) => ({ id: `ro-${index}`, position: index })),
			...Array.from({ length: 30 }, (_, index) => ({ id: `cat-${index}`, name: `Cat ${index}`, type: ChannelType.GuildCategory })),
		]);
		const view = readChannelGapView(guild as never, baseRow);
		const json = buildChannelGapModal("community:gapmodal:1", view).toJSON() as unknown as ModalJson;
		expect(json.title.length).toBeLessThanOrEqual(45);
		expect(json.components.length).toBeLessThanOrEqual(5);
		for (const { component } of json.components) expect(component?.options?.length ?? 0).toBeLessThanOrEqual(SELECT_OPTIONS_MAX);
		const open = json.components.find(({ component }) => component?.custom_id === "gap_open")?.component;
		expect(open?.max_values).toBe(2);
		expect(json.components.find(({ component }) => component?.custom_id === "gap_names")?.component?.value).toBe(rokCommanderCopy.onboardingChannelGap.suggestions.slice(0, 2).join("\n"));
	});

	it("leaves the open select out when nothing can be opened, and speaks the guild's pack", () => {
		const view = readChannelGapView(makeGuild() as never, { ...baseRow, pluginId: "general-events" });
		const json = buildChannelGapModal("community:gapmodal:2", view).toJSON() as unknown as ModalJson;
		expect(json.components.some(({ component }) => component?.custom_id === "gap_open")).toBe(false);
		expect(json.components.find(({ component }) => component?.custom_id === "gap_names")?.component?.value).toBe("💬chat\n🎬clips");
	});
});

// ── the flow, through the router ──────────────────────────────────────

describe("the Configure Onboarding press on a short server (routing branch)", () => {
	it("opens the gap modal instead of the notice, with 2 prefilled suggestions in the guild's pack voice", async () => {
		const guild = makeGuild();
		const interaction = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.configure);
		await handleCommunityButton(interaction);
		expect(noticeText(interaction)).toBeUndefined();
		const json = (interaction.showModal.mock.calls[0]![0] as { toJSON(): { custom_id: string; components: Array<{ component?: { custom_id: string; value?: string } }> } }).toJSON();
		expect(json.custom_id).toBe(`community:gapmodal:${interaction.id}`);
		expect(json.components.find(({ component }) => component?.custom_id === "gap_names")?.component?.value).toBe("🍺tavern\n🛡️alliance-chat");
	});

	it("without Manage Channels shows today's sentence plus the missing permission, and opens no gap modal", async () => {
		const interaction = press(makeGuild([], { manageChannels: false }), OWNER, COMMUNITY_CUSTOM_IDS.configure);
		await handleCommunityButton(interaction);
		expect(noticeText(interaction)).toBe(`${communityCopy.onboarding.preconditions.tooFewSendableChannels(3, 5)}\n\n${gap.missingManageChannels}`);
		expect(interaction.awaitModalSubmit).not.toHaveBeenCalled();
	});
});

describe("Submit, review and Confirm", () => {
	it("1 opened plus 1 created reaches 5, and the Onboarding review posts in 🧭onboarding without a second press", async () => {
		const guild = makeGuild([{ id: "announcements-ro", position: 1 }]);
		await pressAndSubmit(guild, { open: ["announcements-ro"], category: "none", names: "🎉 party time" });

		const review = posted(onboardingChannel.send, 0);
		expect(customIdsOf(review)).toEqual([COMMUNITY_CUSTOM_IDS.gapConfirm, COMMUNITY_CUSTOM_IDS.gapCancel]);
		expect(textOf(review)).toContain("<#announcements-ro>");
		expect(textOf(review)).toContain("🎉party-time");
		expect(textOf(review)).toContain("can see and post in these channels");
		expect(guild.channels.create).not.toHaveBeenCalled();

		const confirmPress = await confirm(guild);
		expect(guild.channels.cache.get("announcements-ro")!.permissionOverwrites.edit).toHaveBeenCalledWith(guild.roles.everyone, { ViewChannel: true, SendMessages: true }, expect.anything());
		expect(guild.channels.create).toHaveBeenCalledTimes(1);
		expect(guild.channels.create).toHaveBeenCalledWith(expect.objectContaining({ name: "🎉party-time", type: ChannelType.GuildText, parent: null }));
		// Acknowledged once, quietly, then the review became the result with no buttons.
		expect(confirmPress.deferUpdate).toHaveBeenCalledTimes(1);
		expect(confirmPress.deferReply).not.toHaveBeenCalled();
		expect(textOf(posted(confirmPress.editReply, 0))).toContain("Everyone can now post in 5 channels");
		expect(posted(confirmPress.editReply, 0).components).toEqual([]);
		// The draft's own review, posted below in 🧭onboarding.
		expect(guild.fetchOnboarding).toHaveBeenCalledTimes(1);
		expect(customIdsOf(posted(onboardingChannel.send, 1))).toContain(COMMUNITY_CUSTOM_IDS.confirmOnboarding);
		expect(auditRows()).toEqual([
			expect.objectContaining({ actorId: OWNER, outcome: "filled", openedChannelIds: ["announcements-ro"], createdChannelIds: ["created-1"], requestedCreateCount: 1 }),
		]);
		expect(JSON.stringify(auditRows())).not.toContain("party");
		expect(mocks.emitFor).toHaveBeenCalledWith(confirmPress, guild.id, "config.change", expect.objectContaining({ detail: gap.adminLogDetail(1, 1) }));
	});

	it("with no 🧭onboarding channel answers privately once, the result line leading the draft", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...baseRow, onboardingConfigChannelId: null });
		const guild = makeGuild();
		const submission = await pressAndSubmit(guild, { category: "new", names: "💬 chat\n🎬 clips" });
		expect(customIdsOf(posted(submission.reply, 0))).toEqual([COMMUNITY_CUSTOM_IDS.gapConfirm, COMMUNITY_CUSTOM_IDS.gapCancel]);

		const confirmPress = await confirm(guild);
		expect(confirmPress.deferReply).toHaveBeenCalledTimes(1);
		expect(confirmPress.deferUpdate).not.toHaveBeenCalled();
		// The new pack category first, then both channels inside it.
		expect(guild.channels.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: "🍺 THE COMMONS", type: ChannelType.GuildCategory }));
		expect(guild.channels.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: "💬chat", parent: "created-1" }));
		expect(confirmPress.editReply).toHaveBeenCalledTimes(1);
		const answer = posted(confirmPress.editReply, 0);
		expect(answer.content).toBe(gap.result.line(0, 2, 5));
		expect(customIdsOf(answer)).toContain(COMMUNITY_CUSTOM_IDS.confirmOnboarding);
	});

	it("a shortfall review names the missing count, offers no Confirm and writes nothing", async () => {
		const guild = makeGuild();
		await pressAndSubmit(guild, { category: "none", names: "💬 chat" });
		const review = posted(onboardingChannel.send, 0);
		expect(customIdsOf(review)).toEqual([COMMUNITY_CUSTOM_IDS.gapCancel]);
		expect(textOf(review)).toContain(gap.review.shortfall(1));

		const confirmPress = await confirm(guild);
		expect(noticeText(confirmPress)).toBe(gap.expired);
		expect(guild.channels.create).not.toHaveBeenCalled();
	});

	it("a refused name posts a review with that sentence and Cancel only", async () => {
		const guild = makeGuild();
		await pressAndSubmit(guild, { category: "none", names: "💬 chat\n<:pog:1> hype" });
		const review = posted(onboardingChannel.send, 0);
		expect(customIdsOf(review)).toEqual([COMMUNITY_CUSTOM_IDS.gapCancel]);
		expect(textOf(review)).toContain(gap.names.customEmoji(2));
	});

	it("a double Confirm writes once", async () => {
		const guild = makeGuild();
		await pressAndSubmit(guild, { category: "none", names: "💬 chat\n🎬 clips" });
		await confirm(guild);
		const second = await confirm(guild);
		expect(guild.channels.create).toHaveBeenCalledTimes(2);
		expect(noticeText(second)).toBe(gap.expired);
	});

	it("refuses a submitter who lost the admin role while the modal was open, and keeps no picks", async () => {
		const guild = makeGuild();
		const submission = submit(guild, ADMIN, { category: "none", names: "💬 chat\n🎬 clips" });
		const interaction = press(guild, ADMIN, COMMUNITY_CUSTOM_IDS.configure, submission);
		// The router gates the press while the role is still there; it goes while the modal is open.
		interaction.awaitModalSubmit.mockImplementation(async () => {
			guild.members.cache.get(ADMIN)!.roles.cache.delete(ADMIN_ROLE);
			return submission;
		});
		await handleCommunityButton(interaction);
		expect(textOf(posted(submission.reply, 0))).toContain(rokCommanderCopy.responses.noWizardPowers);
		expect(onboardingChannel.send).not.toHaveBeenCalled();
	});

	it("refuses a Confirm from a member who lost the admin role, and writes nothing", async () => {
		const guild = makeGuild();
		await pressAndSubmit(guild, { category: "none", names: "💬 chat\n🎬 clips" }, ADMIN);
		guild.members.cache.get(ADMIN)!.roles.cache.delete(ADMIN_ROLE);
		const confirmPress = await confirm(guild, ADMIN);
		expect(noticeText(confirmPress)).toBe(rokCommanderCopy.responses.noWizardPowers);
		expect(guild.channels.create).not.toHaveBeenCalled();
	});

	it("rechecks at Confirm: a name taken since the review is refused, nothing is written, and the picks go back", async () => {
		const guild = makeGuild();
		await pressAndSubmit(guild, { category: "none", names: "💬 chat\n🎬 clips" });
		guild.channels.cache.set("someone-else", fakeChannel({ id: "someone-else", name: "🎬clips", send: true }));
		const first = await confirm(guild);
		expect(textOf(posted(first.editReply, 0))).toContain(gap.recheck.nameTaken("🎬clips"));
		expect(posted(first.editReply, 0).components).toBeUndefined();
		expect(guild.channels.create).not.toHaveBeenCalled();
		expect(auditRows()).toEqual([expect.objectContaining({ outcome: "refused-recheck" })]);

		guild.channels.cache.delete("someone-else");
		await confirm(guild);
		expect(guild.channels.create).toHaveBeenCalledTimes(2);
	});

	it("Cancel forgets the picks and changes nothing", async () => {
		const guild = makeGuild();
		await pressAndSubmit(guild, { category: "none", names: "💬 chat\n🎬 clips" });
		const cancel = press(guild, OWNER, COMMUNITY_CUSTOM_IDS.gapCancel);
		await handleCommunityButton(cancel);
		expect(posted(cancel.update, 0).content).toBe(gap.cancelled);
		expect(noticeText(await confirm(guild))).toBe(gap.expired);
		expect(guild.channels.create).not.toHaveBeenCalled();
	});
});
