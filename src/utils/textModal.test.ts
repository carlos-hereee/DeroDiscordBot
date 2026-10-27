import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbedBuilder, InteractionType, MessageFlags, type ButtonInteraction, type ModalBuilder, type ModalSubmitInteraction, type RepliableInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({ registerModal: vi.fn() }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerModal: mocks.registerModal }));

import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";
import {
	NOTICE_MODAL_PREFIX,
	acknowledgeConfirm,
	acknowledgeTextModal,
	buildConfirmModal,
	confirmFallback,
	confirmSelectValues,
	buildTextModal,
	noticeFromEmbed,
	registerNoticeModal,
	showEmbedNotice,
	showErrorNotice,
	showConfirm,
	showModalOrReply,
	showNotice,
	type ModalOpeningInteraction,
} from "./textModal.js";

// ── textModal (post-launch plan items 9 and 16) ──────────────────────────────
// The shared text modal: its shape within Discord's limits, the fallback when
// Discord refuses it, the notice that knows when a modal cannot be shown (after a
// modal submit, a defer or a reply), and the close that leaves no message behind.

type ModalJson = { custom_id: string; title: string; components: Array<{ type: number; content?: string }> };
const json = (modal: ModalBuilder): ModalJson => modal.toJSON() as unknown as ModalJson;

// A press that can open a modal, or, with showModal left out, a modal submit.
function interaction(options: { canShowModal?: boolean; deferred?: boolean; replied?: boolean; refuse?: boolean } = {}) {
	const fake: Record<string, unknown> = {
		id: "int-7",
		deferred: options.deferred ?? false,
		replied: options.replied ?? false,
		reply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
	};
	if (options.canShowModal ?? true) {
		fake.showModal = options.refuse ? vi.fn(async () => Promise.reject(new Error("Invalid Form Body"))) : vi.fn(async () => undefined);
	}
	return fake as unknown as RepliableInteraction & Record<"reply" | "followUp" | "showModal", ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("buildTextModal", () => {
	it("draws one text display per non empty section, at most five, each within 4000 characters", () => {
		const modal = json(buildTextModal("x:1", { title: "t", sections: ["one", " ", "x".repeat(5000), "three", "four", "five", "six"] }));
		expect(modal.custom_id).toBe("x:1");
		expect(modal.components).toHaveLength(5);
		// 10 is Discord's TextDisplay component type.
		expect(modal.components.every((component) => component.type === 10)).toBe(true);
		expect(modal.components[1]!.content).toHaveLength(4000);
	});

	it("cuts the title to Discord's 45 characters", () => {
		expect(json(buildTextModal("x:1", { title: "t".repeat(60), sections: ["s"] })).title).toHaveLength(45);
	});
});

describe("showNotice", () => {
	it("opens a notice modal keyed by the interaction id, and replies nothing", async () => {
		const press = interaction();
		const fallback = vi.fn(() => ({ content: "private" }));
		await showNotice(press, { title: "Heads up", sections: ["Nothing to do."] }, fallback);

		const modal = json(press.showModal.mock.calls[0]![0] as ModalBuilder);
		expect(modal.custom_id).toBe(`${NOTICE_MODAL_PREFIX}:int-7`);
		expect(modal.components[0]!.content).toBe("Nothing to do.");
		expect(fallback).not.toHaveBeenCalled();
		expect(press.reply).not.toHaveBeenCalled();
	});

	it("answers with the fallback when Discord refuses the modal", async () => {
		const press = interaction({ refuse: true });
		await showNotice(press, { title: "t", sections: ["s"] }, () => ({ content: "private", flags: MessageFlags.Ephemeral }));
		expect(press.reply).toHaveBeenCalledWith({ content: "private", flags: MessageFlags.Ephemeral });
	});

	it("replies privately to a modal submit, which cannot open a modal", async () => {
		const submit = interaction({ canShowModal: false });
		await showNotice(submit, { title: "t", sections: ["s"] }, () => ({ content: "private" }));
		expect(submit.reply).toHaveBeenCalledWith({ content: "private" });
	});

	it("follows up on an interaction already deferred or answered, since a modal can only come first", async () => {
		const deferred = interaction({ deferred: true });
		await showNotice(deferred, { title: "t", sections: ["s"] }, () => ({ content: "private" }));
		expect(deferred.showModal).not.toHaveBeenCalled();
		expect(deferred.followUp).toHaveBeenCalledWith({ content: "private" });
	});
});

describe("showErrorNotice", () => {
	it("titles the notice with the pack's error title, and falls back to the private error embed", async () => {
		const press = interaction();
		await showErrorNotice(press, "Not allowed.");
		const modal = json(press.showModal.mock.calls[0]![0] as ModalBuilder);
		expect(modal.title).toBe(rokCommanderCopy.error.title);
		expect(modal.components[0]!.content).toBe("Not allowed.");

		const submit = interaction({ canShowModal: false });
		await showErrorNotice(submit, "Not allowed.");
		const reply = submit.reply.mock.calls[0]![0] as { embeds: Array<{ data: { description?: string } }>; flags: number };
		expect(reply.embeds[0]!.data.description).toBe("Not allowed.");
		expect(reply.flags).toBe(MessageFlags.Ephemeral);
	});
});

// ── the private reply sweep (2026-10 item 254 Phase 5b) ──────────────────────
describe("showNotice with no fallback", () => {
	it("falls back to the notice's text as plain private content, the reply a text answer always gave", async () => {
		const submit = interaction({ canShowModal: false });
		await showNotice(submit, { title: "t", sections: ["Not your turn."] });
		expect(submit.reply).toHaveBeenCalledWith({ content: "Not your turn.", flags: MessageFlags.Ephemeral });
	});
});

describe("noticeFromEmbed and showEmbedNotice", () => {
	it("reads a text only embed as its title over its description, with its footer last", () => {
		const embed = new EmbedBuilder().setTitle("Channel visibility").setDescription("one\ntwo").setFooter({ text: "a footer" });
		expect(noticeFromEmbed(embed)).toEqual({ title: "Channel visibility", sections: ["one\ntwo", "a footer"] });
	});

	it("refuses an embed a modal cannot show: fields, an image, a thumbnail, or no title", () => {
		expect(noticeFromEmbed(new EmbedBuilder().setTitle("t").addFields({ name: "n", value: "v" }))).toBeNull();
		expect(noticeFromEmbed(new EmbedBuilder().setTitle("t").setImage("attachment://card.png"))).toBeNull();
		expect(noticeFromEmbed(new EmbedBuilder().setTitle("t").setThumbnail("https://example.com/a.png"))).toBeNull();
		expect(noticeFromEmbed(new EmbedBuilder().setDescription("no title"))).toBeNull();
	});

	it("opens a text only embed as a notice, and keeps the embed as its private fallback", async () => {
		const press = interaction({ refuse: true });
		const embed = new EmbedBuilder().setTitle("Saved").setDescription("Done.");
		await showEmbedNotice(press, embed);
		expect(json(press.showModal.mock.calls[0]![0] as ModalBuilder).title).toBe("Saved");
		expect(press.reply).toHaveBeenCalledWith({ embeds: [embed], flags: MessageFlags.Ephemeral });
	});

	it("answers an embed with fields as the private reply it always was, opening no modal", async () => {
		const press = interaction();
		const embed = new EmbedBuilder().setTitle("Standings").addFields({ name: "1", value: "Ana" });
		await showEmbedNotice(press, embed);
		expect(press.showModal).not.toHaveBeenCalled();
		expect(press.reply).toHaveBeenCalledWith({ embeds: [embed], flags: MessageFlags.Ephemeral });
	});
});

describe("showModalOrReply", () => {
	it("opens the modal it is given, and on a refusal answers with the fallback instead", async () => {
		const modal = buildTextModal("x:1", { title: "t", sections: ["s"] });
		const press = interaction();
		await showModalOrReply(press as unknown as ModalOpeningInteraction, modal, () => ({ content: "private" }));
		expect(press.showModal).toHaveBeenCalledWith(modal);
		expect(press.reply).not.toHaveBeenCalled();

		const refused = interaction({ refuse: true });
		await showModalOrReply(refused as unknown as ModalOpeningInteraction, modal, () => ({ content: "private" }));
		expect(refused.reply).toHaveBeenCalledWith({ content: "private" });
	});
});

describe("acknowledgeTextModal", () => {
	it("acknowledges a modal opened from a message with deferUpdate, and survives a failed acknowledgement", async () => {
		const deferUpdate = vi.fn(async () => Promise.reject(new Error("Unknown interaction")));
		await expect(acknowledgeTextModal({ isFromMessage: () => true, deferUpdate } as unknown as ModalSubmitInteraction)).resolves.toBeUndefined();
		expect(deferUpdate).toHaveBeenCalledOnce();
	});

	it("leaves no message behind for a modal opened from a slash command: a private defer, deleted at once", async () => {
		const deferReply = vi.fn(async () => undefined);
		const deleteReply = vi.fn(async () => undefined);
		await acknowledgeTextModal({ isFromMessage: () => false, deferReply, deleteReply } as unknown as ModalSubmitInteraction);
		expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		expect(deleteReply).toHaveBeenCalledOnce();
	});
});

describe("registerNoticeModal", () => {
	it("routes every notice close on the bare prefix", () => {
		registerNoticeModal();
		expect(mocks.registerModal).toHaveBeenCalledWith(NOTICE_MODAL_PREFIX, acknowledgeTextModal);
	});
});

// ── showConfirm (2026-10 item 257, owner item 12) ──
// A confirm only asks: its modal and its fallback button carry the caller's confirmId,
// and nothing in this helper ever performs the action.
describe("showConfirm", () => {
	const content = { title: "Archive?", sections: ["Submit to archive it."], confirmId: "gameroom:archiveok:room-1" };
	type FallbackReply = { content: string; flags: number; components: Array<{ toJSON(): { components: Array<{ custom_id: string; label: string }> } }> };
	const buttonOf = (reply: FallbackReply) => reply.components[0]!.toJSON().components[0]!;

	it("opens a text modal under the confirmId, so its Submit routes to the caller's handler", async () => {
		const press = interaction();
		await showConfirm(press, content);
		const modal = json(press.showModal.mock.calls[0]![0] as ModalBuilder);
		expect(modal.custom_id).toBe("gameroom:archiveok:room-1");
		expect(modal.components[0]!.content).toBe("Submit to archive it.");
		expect(press.reply).not.toHaveBeenCalled();
	});

	it.each([
		["Discord refuses the modal", { refuse: true }, "reply"],
		["the interaction is a modal submit", { canShowModal: false }, "reply"],
		["the interaction was already deferred", { deferred: true }, "followUp"],
	] as const)("falls back to a private reply with one confirm button when %s", async (_label, options, method) => {
		const press = interaction(options);
		await showConfirm(press, content);
		const reply = press[method].mock.calls[0]![0] as FallbackReply;
		expect(reply.flags).toBe(MessageFlags.Ephemeral);
		expect(reply.content).toContain("Submit to archive it.");
		expect(buttonOf(reply)).toMatchObject({ custom_id: "gameroom:archiveok:room-1", label: rokCommanderCopy.confirm.button });
	});

	it("labels the fallback button from the guild's pack", () => {
		const reply = confirmFallback(content, { pluginId: "general-events" }) as FallbackReply;
		expect(buttonOf(reply).label).toBe(generalEventsCopy.confirm.button);
	});
});

// A confirm may carry one select (a modal holds no button): the archive's Save this match to my profile.
describe("a confirm with a select", () => {
	const select = {
		fieldId: "choice",
		label: "Save it?",
		options: [
			{ label: "Yes", value: "yes" },
			{ label: "No", value: "no", isDefault: true },
		],
	};
	const content = { title: "Archive?", sections: ["Submit to archive it."], confirmId: "gameroom:archiveok:room-1", select };
	type LabelJson = { type: number; label: string; component: { custom_id: string; required?: boolean; options: Array<{ value: string; default?: boolean }> } };
	const labelOf = (modal: ModalBuilder): LabelJson => (modal.toJSON() as unknown as { components: LabelJson[] }).components.find((component) => component.type === 18)!;

	it("adds the select under the text, labelled, required and defaulting to the safe option", () => {
		const label = labelOf(buildConfirmModal(content));
		expect(label.label).toBe("Save it?");
		expect(label.component).toMatchObject({ custom_id: "choice", required: true });
		expect(label.component.options.map((option) => [option.value, option.default ?? false])).toEqual([
			["yes", false],
			["no", true],
		]);
	});

	it("keeps the whole modal within Discord's five components, cutting text rather than the select", () => {
		const modal = buildConfirmModal({ ...content, sections: ["1", "2", "3", "4", "5", "6"] });
		const components = (modal.toJSON() as unknown as { components: Array<{ type: number }> }).components;
		expect(components).toHaveLength(5);
		expect(components.filter((component) => component.type === 10)).toHaveLength(4);
		expect(components[4]!.type).toBe(18);
	});

	it("adds nothing to a confirm that has no select, and its fallback stays the one button", () => {
		const bare = { title: "Archive?", sections: ["Submit to archive it."], confirmId: "gameroom:archiveok:room-1" };
		expect((buildConfirmModal(bare).toJSON() as unknown as { components: Array<{ type: number }> }).components.map((component) => component.type)).toEqual([10]);
		const fallback = confirmFallback(content) as { components: Array<{ toJSON(): { components: unknown[] } }> };
		expect(fallback.components[0]!.toJSON().components).toHaveLength(1);
	});

	it("opens the modal with the select through showConfirm", async () => {
		const press = interaction();
		await showConfirm(press, content);
		expect(labelOf(press.showModal.mock.calls[0]![0] as ModalBuilder).component.custom_id).toBe("choice");
	});

	it("reads the select back from a modal submit, and reads empty for the fallback button or a missing field", () => {
		const submit = (read: () => string[]) => ({ type: InteractionType.ModalSubmit, fields: { getStringSelectValues: read } }) as unknown as ModalSubmitInteraction;
		expect(confirmSelectValues(submit(() => ["yes"]), "choice")).toEqual(["yes"]);
		expect(
			confirmSelectValues(
				submit(() => {
					throw new Error("Required field not found");
				}),
				"choice"
			)
		).toEqual([]);
		expect(confirmSelectValues({ type: InteractionType.MessageComponent } as unknown as ButtonInteraction, "choice")).toEqual([]);
	});
});

describe("acknowledgeConfirm", () => {
	it("closes a confirm modal the way a text modal closes", async () => {
		const deferUpdate = vi.fn(async () => undefined);
		await acknowledgeConfirm({ type: InteractionType.ModalSubmit, isFromMessage: () => true, deferUpdate } as unknown as ModalSubmitInteraction);
		expect(deferUpdate).toHaveBeenCalledOnce();
	});

	it("defers the fallback button's press, swallowing a failure", async () => {
		const deferUpdate = vi.fn(async () => Promise.reject(new Error("Unknown interaction")));
		await expect(acknowledgeConfirm({ type: InteractionType.MessageComponent, deferUpdate } as unknown as ButtonInteraction)).resolves.toBeUndefined();
		expect(deferUpdate).toHaveBeenCalledOnce();
	});
});
