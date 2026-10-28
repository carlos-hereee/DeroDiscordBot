import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, TextChannel, type ButtonInteraction, type Message, type ModalSubmitInteraction } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";

// ── rulesEdit (2026-10 item 247 Phase 2) ────────────────────────────────────
// The Edit rules round trip: who may open the modal, what it is preloaded with,
// what a submit saves, how the rules post re-renders in place, and that the audit
// row carries a length and never the rules text. The submitter is re-checked on
// the submit itself, because a role can be taken away while the modal is open. A
// saved edit is answered in 🧭onboarding (2026-10 item 257 Phase 5), and privately
// only where setup never stored that channel.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	log: vi.fn(),
	registerButton: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: mocks.registerButton }));

import { handleRulesEditButton, handleRulesEditSubmit, registerRulesEditHandlers } from "./rulesEdit.js";
import { RULES_EDIT_CUSTOM_ID } from "./rulesContent.js";

const OWNER = "owner-1";
const ADMIN = "admin-1";
const MEMBER = "member-1";
const DEFAULT_RULES = rokCommanderCopy.channelContent.rules.defaultMarkdown;
const editCopy = rokCommanderCopy.responses.rulesEdit;

const storedRow = {
	guildId: "g1",
	adminRoleId: "role-admin",
	rulesChannelId: "rules-ch",
	introMessageIds: { rulesChannelId: "rules-msg" },
	customRulesMarkdown: null as string | null,
	onboardingConfigChannelId: "onboarding-ch" as string | null,
};

function rig(options: { trackedPost?: boolean } = {}) {
	const trackedPost = { id: "rules-msg", edit: vi.fn(async () => undefined) };
	const buttonMessage = { id: "button-msg", edit: vi.fn(async () => undefined) } as unknown as Message & { edit: ReturnType<typeof vi.fn> };
	const rulesChannel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
		id: "rules-ch",
		messages: {
			fetch: vi.fn(async (id: string) => {
				if (options.trackedPost === false || id !== "rules-msg") throw new Error("Unknown Message");
				return trackedPost;
			}),
		},
	});
	const guild = {
		id: "g1",
		ownerId: OWNER,
		members: { cache: new Map([[ADMIN, { roles: { cache: new Set(["role-admin"]) } }]]), fetch: vi.fn(async () => null) },
	};
	const onboarding = { id: "onboarding-ch", isSendable: () => true, send: vi.fn(async () => ({ id: "answer-msg" })) };
	const channels: Record<string, unknown> = { "rules-ch": rulesChannel, "onboarding-ch": onboarding };
	const client = { channels: { fetch: vi.fn(async (id: string) => channels[id] ?? null) } };

	const submission = (userId: string, text: string) =>
		({
			guild,
			client,
			user: { id: userId },
			customId: "rules:modal:int-1",
			fields: { getTextInputValue: vi.fn(() => text) },
			deferred: false,
			replied: false,
			isModalSubmit: () => true,
			isFromMessage: () => true,
			deferUpdate: vi.fn(async () => undefined),
			reply: vi.fn(async () => undefined),
		}) as unknown as ModalSubmitInteraction & { reply: ReturnType<typeof vi.fn>; deferUpdate: ReturnType<typeof vi.fn> };

	const button = (userId: string, awaited: ModalSubmitInteraction | null, customId = RULES_EDIT_CUSTOM_ID) =>
		({
			id: "int-1",
			customId,
			guild,
			client,
			user: { id: userId },
			message: buttonMessage,
			showModal: vi.fn(async () => undefined),
			awaitModalSubmit: vi.fn(async () => {
				if (!awaited) throw new Error("Collector received no interactions before ending with reason: time");
				return awaited;
			}),
			reply: vi.fn(async () => undefined),
		}) as unknown as ButtonInteraction & {
			showModal: ReturnType<typeof vi.fn>;
			awaitModalSubmit: ReturnType<typeof vi.fn>;
			reply: ReturnType<typeof vi.fn>;
		};

	return { trackedPost, buttonMessage, submission, button, onboarding };
}

// The answer a saved edit posted in 🧭onboarding, naming the submitter without a ping.
const postedAnswer = (onboarding: { send: ReturnType<typeof vi.fn> }): string => (onboarding.send.mock.calls[0]![0] as { content: string }).content;

// The modals a press opened, and the text of its notice: a refusal or a short answer now
// opens a notice modal instead of a private reply (2026-10 item 254 Phase 5b).
const shownModals = (interaction: { showModal: unknown }) =>
	(interaction.showModal as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { toJSON(): { custom_id: string; components: { content?: string }[] } }).toJSON());
const noticeText = (interaction: { showModal: unknown }): string =>
	shownModals(interaction)
		.filter((modal) => modal.custom_id.startsWith("notice:"))
		.flatMap((modal) => modal.components.map((component) => component.content ?? ""))
		.join("\n");
// True when every modal the press opened is a notice, so no form or game modal opened.
const onlyNoticesShown = (interaction: { showModal: unknown }): boolean => shownModals(interaction).every((modal) => modal.custom_id.startsWith("notice:"));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId.mockResolvedValue({ ...storedRow });
	mocks.update.mockImplementation(async (_guildId: string, data: Record<string, unknown>) => ({ ...storedRow, ...data }));
	mocks.log.mockResolvedValue(undefined);
});

describe("the Edit rules button", () => {
	it("refuses a member who is neither the owner nor an admin, and opens no modal", async () => {
		const { button } = rig();
		const press = button(MEMBER, null);
		await handleRulesEditButton(press);
		expect(onlyNoticesShown(press)).toBe(true);
		expect(noticeText(press)).not.toBe("");
		expect(press.reply).not.toHaveBeenCalled();
	});

	it("answers a stale customId as expired", async () => {
		const { button } = rig();
		const press = button(OWNER, null, "rules:somethingold");
		await handleRulesEditButton(press);
		expect(onlyNoticesShown(press)).toBe(true);
		expect(noticeText(press)).toBe(editCopy.expired);
	});

	it("opens a modal preloaded with the rules as they stand, capped at Discord's input limit", async () => {
		const { button } = rig();
		const press = button(OWNER, null);
		await handleRulesEditButton(press);

		const modal = (press.showModal.mock.calls[0]![0] as { toJSON(): { custom_id: string; title: string; components: Array<{ components: Array<Record<string, unknown>> }> } }).toJSON();
		const input = modal.components[0]!.components[0]!;
		expect(modal.title).toBe(editCopy.modalTitle);
		expect(input.value).toBe(DEFAULT_RULES);
		expect(input.max_length).toBe(BOT_CONSTANTS.RULES_MARKDOWN_MAX_LENGTH);
		expect(input.required).toBe(true);

		// The wait hears only this clicker's own modal.
		const { filter, time } = press.awaitModalSubmit.mock.calls[0]![0] as { filter: (submit: unknown) => boolean; time: number };
		expect(time).toBe(BOT_CONSTANTS.RULES_EDIT_MODAL_TIMEOUT_MS);
		expect(filter({ user: { id: OWNER }, customId: modal.custom_id })).toBe(true);
		expect(filter({ user: { id: ADMIN }, customId: modal.custom_id })).toBe(false);
		expect(filter({ user: { id: OWNER }, customId: "rules:modal:someone-else" })).toBe(false);
	});

	it("preloads the owner's saved rules when there are some", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...storedRow, customRulesMarkdown: "**1. Be kind**" });
		const { button } = rig();
		const press = button(ADMIN, null);
		await handleRulesEditButton(press);
		const modal = (press.showModal.mock.calls[0]![0] as { toJSON(): { components: Array<{ components: Array<{ value?: string }> }> } }).toJSON();
		expect(modal.components[0]!.components[0]!.value).toBe("**1. Be kind**");
	});

	it("saves nothing when the modal times out", async () => {
		const { button } = rig();
		await handleRulesEditButton(button(OWNER, null));
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("round trips: an admin's submit saves the text and re-renders the rules post in place", async () => {
		const { button, submission, trackedPost, onboarding } = rig();
		const submit = submission(ADMIN, "  **1. Be kind**\n**2. No spam**  ");
		await handleRulesEditButton(button(ADMIN, submit));

		expect(mocks.update).toHaveBeenCalledWith("g1", { customRulesMarkdown: "**1. Be kind**\n**2. No spam**" });
		const edit = trackedPost.edit.mock.calls[0]![0] as { embeds: Array<{ data: { description?: string } }>; components: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }> };
		expect(edit.embeds[0]!.data.description).toBe("**1. Be kind**\n**2. No spam**");
		expect(edit.components[0]!.toJSON().components[0]!.custom_id).toBe(RULES_EDIT_CUSTOM_ID);
		expect(postedAnswer(onboarding)).toBe(`<@${ADMIN}> ${editCopy.saved}`);
		expect(submit.deferUpdate).toHaveBeenCalledOnce();
		expect(submit.reply).not.toHaveBeenCalled();
	});

	it("answers privately where setup never stored the 🧭onboarding channel", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...storedRow, onboardingConfigChannelId: null });
		mocks.update.mockImplementation(async (_guildId: string, data: Record<string, unknown>) => ({ ...storedRow, onboardingConfigChannelId: null, ...data }));
		const { button, submission, onboarding } = rig();
		const submit = submission(ADMIN, "**1. Be kind**");
		await handleRulesEditButton(button(ADMIN, submit));
		expect(onboarding.send).not.toHaveBeenCalled();
		expect(submit.reply).toHaveBeenCalledWith(expect.objectContaining({ content: editCopy.saved, flags: MessageFlags.Ephemeral }));
	});

	it("audits the edit with ids and a length, never the rules text", async () => {
		const { button, submission } = rig();
		await handleRulesEditButton(button(OWNER, submission(OWNER, "**1. Be kind**")));
		expect(mocks.log).toHaveBeenCalledOnce();
		const [guildId, event, metadata] = mocks.log.mock.calls[0]! as [string, string, Record<string, unknown>];
		expect(guildId).toBe("g1");
		expect(event).toBe(BOT_LOG_EVENTS.RULES_EDITED);
		expect(metadata).toMatchObject({ actorId: OWNER, length: "**1. Be kind**".length, reset: false });
		expect(JSON.stringify(metadata)).not.toContain("Be kind");
	});
});

describe("an Edit rules submit", () => {
	it("stores null when the text is the default again, so the pack's wording keeps applying", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...storedRow, customRulesMarkdown: "old" });
		const { submission, onboarding } = rig();
		const submit = submission(OWNER, DEFAULT_RULES);
		await handleRulesEditSubmit(submit, null);
		expect(mocks.update).toHaveBeenCalledWith("g1", { customRulesMarkdown: null });
		expect(postedAnswer(onboarding)).toBe(`<@${OWNER}> ${editCopy.reset}`);
	});

	it("refuses a submit made only of whitespace and zero width characters", async () => {
		const { submission } = rig();
		const submit = submission(OWNER, " \u200B\u200D\uFEFF ");
		await handleRulesEditSubmit(submit, null);
		expect(mocks.update).not.toHaveBeenCalled();
		// since Phase 1c a refused Submit's private fallback is the notice's plain text (owner rule 1)
		expect((submit.reply.mock.calls[0]![0] as { content?: string }).content).toBe(editCopy.empty);
	});

	it("re-checks the submitter, who may have lost the admin role while the modal was open", async () => {
		const { submission } = rig();
		const submit = submission(MEMBER, "**1. Be kind**");
		await handleRulesEditSubmit(submit, null);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(submit.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
	});

	it("falls back to the post the button sat on when the tracked anchor is gone", async () => {
		const { submission, buttonMessage, onboarding } = rig({ trackedPost: false });
		const submit = submission(OWNER, "**1. Be kind**");
		await handleRulesEditSubmit(submit, buttonMessage);
		expect(buttonMessage.edit).toHaveBeenCalledOnce();
		expect(postedAnswer(onboarding)).toBe(`<@${OWNER}> ${editCopy.saved}`);
	});

	it("says the save landed but the post did not when no rules post can be found", async () => {
		const { submission, onboarding } = rig({ trackedPost: false });
		const submit = submission(OWNER, "**1. Be kind**");
		await handleRulesEditSubmit(submit, null);
		expect(mocks.update).toHaveBeenCalledOnce();
		expect(postedAnswer(onboarding)).toBe(`<@${OWNER}> ${editCopy.savedNotRefreshed}`);
	});

	it("tells the admin nothing changed when the save fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.update.mockRejectedValueOnce(new Error("Mongo down"));
		const { submission, trackedPost } = rig();
		const submit = submission(OWNER, "**1. Be kind**");
		await handleRulesEditSubmit(submit, null);
		expect(trackedPost.edit).not.toHaveBeenCalled();
		const embed = (submit.reply.mock.calls[0]![0] as { embeds: Array<{ data: { description?: string } }> }).embeds[0]!;
		expect(embed.data.description).toBe(editCopy.failed);
		expect(mocks.log).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});

describe("registerRulesEditHandlers", () => {
	it("routes on the bare prefix the registry slices customIds to", () => {
		registerRulesEditHandlers();
		expect(mocks.registerButton).toHaveBeenCalledWith("rules", handleRulesEditButton);
	});
});
