import { describe, it, expect, vi, beforeEach } from "vitest";
import { CategoryChannel, Collection, PermissionFlagsBits, TextChannel, type ButtonInteraction, type Guild, type ModalSubmitInteraction } from "discord.js";

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn(), update: vi.fn() } }));
vi.mock("./adminLog.js", () => ({ adminLog: { emit: vi.fn(), emitFor: vi.fn(), write: vi.fn() } }));
vi.mock("./headquartersCards.js", () => ({ refreshHeadquartersCards: vi.fn() }));

import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { adminLog } from "./adminLog.js";
import { setupCopy } from "./setupCopy.js";
import { choosableAdoptedChannels, handleChoiceSubmit, handleChooseButton, offerAdoptionChoice } from "./adoptionChoice.js";

// ── adoptionChoice (2026-10 item 257 Phase 1a) ──────────────────────────────
// Owner decision 5: a channel the server already had moves into the notice board only
// when an admin picks Move, a channel Discord Onboarding uses stays readable by
// everyone either way, and a refused move leaves the channel where it was.

const store = guildConfigStore as unknown as Record<"findByGuildId" | "update", ReturnType<typeof vi.fn>>;
const copy = setupCopy.adoptionChoice;
const { ViewChannel } = PermissionFlagsBits;

function textChannel(id: string, name: string, parentId: string | null = "cat-lobby") {
	const channel = Object.create(TextChannel.prototype) as TextChannel & Record<"send" | "setParent", ReturnType<typeof vi.fn>>;
	Object.assign(channel, {
		id,
		name,
		parentId,
		send: vi.fn(async () => ({ id: `post-${id}` })),
		setParent: vi.fn(async () => channel),
		permissionOverwrites: { cache: new Map(), set: vi.fn(async () => channel) },
	});
	return channel;
}

function rig(options: { systemChannelId?: string | null; onboardingDefaults?: string[] } = {}) {
	const ownRules = textChannel("own-rules", "guidelines");
	const ownWelcome = textChannel("own-welcome", "welcome");
	const general = textChannel("general", "general");
	const adminChannel = textChannel("ch-admin", "inner-sanctum", "cat-1");
	const category = Object.assign(Object.create(CategoryChannel.prototype) as CategoryChannel, { id: "cat-1" });
	const fetchable = new Map<string, unknown>([["cat-1", category], ["ch-admin", adminChannel]]);
	const guild = {
		id: "guild-1",
		ownerId: "owner-1",
		features: ["COMMUNITY"],
		rulesChannelId: "own-rules",
		systemChannelId: options.systemChannelId ?? null,
		fetchOnboarding: vi.fn(async () => ({ enabled: true, prompts: new Collection(), defaultChannels: new Collection((options.onboardingDefaults ?? ["own-rules"]).map((id) => [id, undefined])) })),
		roles: { everyone: { id: "everyone" } },
		client: { user: { id: "bot-1" } },
		members: { cache: new Map(), fetch: vi.fn(async () => null) },
		channels: {
			cache: new Map<string, unknown>([["own-rules", ownRules], ["own-welcome", ownWelcome], ["general", general]]),
			fetch: vi.fn(async (id: string) => fetchable.get(id) ?? null),
		},
	} as unknown as Guild;
	return { guild, ownRules, ownWelcome, general, adminChannel };
}

function row(overrides: Record<string, unknown> = {}) {
	return {
		categoryId: "cat-1",
		adminChannelId: "ch-admin",
		adminRoleId: null,
		memberRoleId: "role-member",
		welcomeChannelId: "own-welcome",
		rulesChannelId: "own-rules",
		adoptedChannelIds: ["own-welcome", "own-rules"],
		adoptedChannelChoices: new Map(),
		...overrides,
	};
}

function press(guild: Guild, userId = "owner-1") {
	return { id: "press-1", guild, user: { id: userId }, deferred: false, replied: false, showModal: vi.fn(async () => undefined), reply: vi.fn(async () => undefined) } as unknown as ButtonInteraction & {
		showModal: ReturnType<typeof vi.fn>;
	};
}

// `fromTitle` is the title of the message the modal was opened from: the choice card by
// default, or the 🧭onboarding steps card, whose step 2 opens the same modal.
function submit(guild: Guild, picks: Record<string, string>, fromTitle: string = setupCopy.adoptionChoice.cardTitle) {
	return {
		message: { embeds: [{ title: fromTitle }] },
		id: "submit-1",
		guild,
		user: { id: "owner-1" },
		client: {},
		deferred: false,
		replied: false,
		isFromMessage: () => true,
		deferUpdate: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		fields: {
			getStringSelectValues: (id: string) => {
				if (!(id in picks)) throw new Error(`no field ${id}`);
				return [picks[id]];
			},
		},
	} as unknown as ModalSubmitInteraction & { editReply: ReturnType<typeof vi.fn> };
}

const choiceWrites = () => store.update.mock.calls.map((call) => call[1] as Record<string, unknown>);
const resultText = (interaction: { editReply: ReturnType<typeof vi.fn> }) =>
	String((interaction.editReply.mock.calls[0]![0] as { embeds: Array<{ data: { description?: string } }> }).embeds[0]!.data.description);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	store.update.mockResolvedValue(undefined);
});

describe("choosableAdoptedChannels", () => {
	it("lists the adopted welcome and rules channels, and never the server's main chat taken in place", () => {
		const { guild } = rig({ systemChannelId: "general" });
		expect(choosableAdoptedChannels(guild, row()).map((entry) => entry.channel.id)).toEqual(["own-welcome", "own-rules"]);
		expect(choosableAdoptedChannels(guild, row({ welcomeChannelId: "general", adoptedChannelIds: ["general", "own-rules"] })).map((entry) => entry.channel.id)).toEqual(["own-rules"]);
	});
});

describe("the card", () => {
	it("posts once in the admin channel, listing each channel nobody has placed, with the Choose button", async () => {
		const { guild, adminChannel } = rig();
		store.findByGuildId.mockResolvedValue(row({ adoptedChannelChoices: new Map([["own-welcome", "stay"]]) }));

		await offerAdoptionChoice(guild);

		const sent = adminChannel.send.mock.calls[0]![0] as { embeds: Array<{ data: { description: string } }>; components: Array<{ toJSON(): { components: Array<{ custom_id: string }> } }> };
		expect(sent.embeds[0]!.data.description).toContain("<#own-rules>");
		expect(sent.embeds[0]!.data.description).not.toContain("<#own-welcome>");
		expect(sent.components[0]!.toJSON().components[0]!.custom_id).toBe("adoption:choose");
	});

	it("posts nothing when every adopted channel already has an answer", async () => {
		const { guild, adminChannel } = rig();
		store.findByGuildId.mockResolvedValue(row({ adoptedChannelChoices: { "own-welcome": "stay", "own-rules": "move" } }));
		await offerAdoptionChoice(guild);
		expect(adminChannel.send).not.toHaveBeenCalled();
	});
});

describe("the Choose button", () => {
	it("opens one select per channel, preset to Leave where it is when nobody chose", async () => {
		const { guild } = rig();
		store.findByGuildId.mockResolvedValue(row());
		const interaction = press(guild);

		await handleChooseButton(interaction);

		const modal = (interaction.showModal.mock.calls[0]![0] as { toJSON(): { custom_id: string; components: Array<{ type: number; component?: { custom_id: string; options: Array<{ value: string; default?: boolean }> } }> } }).toJSON();
		expect(modal.custom_id).toBe("adoption:submit");
		const selects = modal.components.flatMap((component) => (component.component ? [component.component] : []));
		expect(selects.map((select) => select.custom_id)).toEqual(["own-welcome", "own-rules"]);
		expect(selects[0]!.options.find((option) => option.default)?.value).toBe("stay");
	});

	it("refuses anyone but the owner or an admin, and opens no choice", async () => {
		const { guild } = rig();
		store.findByGuildId.mockResolvedValue(row());
		const interaction = press(guild, "member-1");

		await handleChooseButton(interaction);

		const opened = interaction.showModal.mock.calls.map((call) => (call[0] as { toJSON(): { custom_id: string } }).toJSON().custom_id);
		expect(opened).not.toContain("adoption:submit");
	});
});

describe("the Submit", () => {
	// 2026-10 item 257 Phase 2b: the steps card's step 2 opens this modal too, and an
	// update from there would overwrite the steps card with the choice result.
	it("answers privately when the modal came from the 🧭onboarding steps card, never updating that card", async () => {
		const { guild } = rig();
		store.findByGuildId.mockResolvedValue(row());
		const interaction = submit(guild, { "own-welcome": "stay", "own-rules": "stay" }, setupCopy.headquarters.onboarding.title) as unknown as {
			deferUpdate: ReturnType<typeof vi.fn>;
			deferReply: ReturnType<typeof vi.fn>;
		};

		await handleChoiceSubmit(interaction as unknown as ModalSubmitInteraction);

		expect(interaction.deferUpdate).not.toHaveBeenCalled();
		expect(interaction.deferReply).toHaveBeenCalledOnce();
	});

	it("Move on a channel Onboarding uses: overwrite first and readable by everyone, then the parent, and the answer is stored", async () => {
		const { guild, ownRules } = rig();
		store.findByGuildId.mockResolvedValue(row());
		const interaction = submit(guild, { "own-welcome": "stay", "own-rules": "move" });

		await handleChoiceSubmit(interaction);

		const [written] = ownRules.permissionOverwrites.set.mock.calls[0] as unknown as [Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>];
		const everyone = written.find((entry) => entry.id === "everyone")!;
		expect(everyone.allow).toContain(ViewChannel);
		expect(everyone.deny ?? []).not.toContain(ViewChannel);
		expect(ownRules.setParent).toHaveBeenCalledWith("cat-1", expect.objectContaining({ lockPermissions: false }));
		expect(ownRules.permissionOverwrites.set.mock.invocationCallOrder[0]!).toBeLessThan(ownRules.setParent.mock.invocationCallOrder[0]!);
		expect(choiceWrites()).toEqual([{ "adoptedChannelChoices.own-welcome": "stay", "adoptedChannelChoices.own-rules": "move" }]);
		expect(resultText(interaction)).toContain(copy.results.moved("own-rules"));
		expect(adminLog.emitFor).toHaveBeenCalledTimes(2);
	});

	it("Leave where it is: nothing moves and no overwrite is written", async () => {
		const { guild, ownRules, ownWelcome } = rig();
		store.findByGuildId.mockResolvedValue(row());
		const interaction = submit(guild, { "own-welcome": "stay", "own-rules": "stay" });

		await handleChoiceSubmit(interaction);

		for (const channel of [ownRules, ownWelcome]) {
			expect(channel.setParent).not.toHaveBeenCalled();
			expect(channel.permissionOverwrites.set).not.toHaveBeenCalled();
		}
		expect(resultText(interaction)).toContain(copy.results.stayed("own-rules"));
	});

	it("a refused overwrite leaves the channel where it was and stores what happened: stay", async () => {
		const { guild, ownRules } = rig();
		ownRules.permissionOverwrites.set = vi.fn(async () => {
			throw Object.assign(new Error("Onboarding channels must be readable by everyone"), { code: 350003 });
		});
		store.findByGuildId.mockResolvedValue(row());
		const interaction = submit(guild, { "own-rules": "move" });

		await handleChoiceSubmit(interaction);

		expect(ownRules.setParent).not.toHaveBeenCalled();
		expect(ownRules.parentId).toBe("cat-lobby");
		expect(choiceWrites()).toEqual([{ "adoptedChannelChoices.own-rules": "stay" }]);
		expect(resultText(interaction)).toContain(copy.results.refused("own-rules"));
	});
});
