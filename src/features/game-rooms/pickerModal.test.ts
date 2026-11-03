import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, StringSelectMenuBuilder, type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction } from "discord.js";
import { GAME_ROOM_MODAL_PREFIX, GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
import { answerPick, buildFieldsModal, buildPickerModal, deferPick, isPickerPrefix, pickedValues, readFieldAnswers, showPicker, type ModalField, type PickerContent } from "./pickerModal.js";

// ── pickerModal (2026-10 item 254 Phase 5b) ──────────────────────────────────
// A single choice picker as a modal with one required select: its shape, the select
// message it falls back to, and the two halves of a slow pick, which must never edit
// the card a modal's button sits on.

type PickerJson = {
	custom_id: string;
	title: string;
	components: Array<{ type: number; content?: string; label?: string; component?: { custom_id: string; required?: boolean; options: Array<{ value: string }> } }>;
};

const content = (): PickerContent => ({
	action: "kick",
	roomId: "room-1",
	title: "🎮 Host controls",
	prompt: "Pick who leaves the room.",
	label: "Choose a player",
	select: new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:kick:room-1`)
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions({ label: "Ana", value: "u-1" }, { label: "Bo", value: "u-2" }),
});

function press(refuse = false) {
	return {
		showModal: refuse ? vi.fn(async () => Promise.reject(new Error("Invalid Form Body"))) : vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
	} as unknown as ButtonInteraction & Record<"showModal" | "reply", ReturnType<typeof vi.fn>>;
}

function modalSubmit(values: string[] | null) {
	return {
		isModalSubmit: () => true,
		fields: {
			getStringSelectValues: vi.fn(() => {
				if (values === null) throw new Error("Required field pick not found");
				return values;
			}),
		},
		deferReply: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	} as unknown as ModalSubmitInteraction & Record<"deferReply" | "deferUpdate" | "editReply", ReturnType<typeof vi.fn>>;
}

function selectMessage(values: string[]) {
	return {
		isModalSubmit: () => false,
		values,
		deferReply: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	} as unknown as StringSelectMenuInteraction & Record<"deferReply" | "deferUpdate" | "editReply", ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("buildPickerModal", () => {
	it("routes on the game room modal prefix and holds the prompt over one required select", () => {
		const modal = buildPickerModal(content()).toJSON() as unknown as PickerJson;
		expect(modal.custom_id).toBe(`${GAME_ROOM_MODAL_PREFIX}:kick:room-1`);
		expect(modal.title).toBe("🎮 Host controls");
		expect(modal.components[0]!.content).toBe("Pick who leaves the room.");
		const label = modal.components[1]!;
		expect(label.label).toBe("Choose a player");
		expect(label.component!.required).toBe(true);
		expect(label.component!.options.map((option) => option.value)).toEqual(["u-1", "u-2"]);
	});
});

describe("showPicker", () => {
	it("opens the picker modal and replies nothing", async () => {
		const interaction = press();
		await showPicker(interaction, content());
		expect(interaction.showModal).toHaveBeenCalledOnce();
		expect(interaction.reply).not.toHaveBeenCalled();
	});

	it("falls back to the private select message, routed on the select prefix, when Discord refuses the modal", async () => {
		const interaction = press(true);
		await showPicker(interaction, content());
		const reply = interaction.reply.mock.calls[0]![0] as { content: string; flags: number; components: Array<{ toJSON(): { components: Array<{ custom_id: string }> } }> };
		expect(reply.content).toBe("Pick who leaves the room.");
		expect(reply.flags).toBe(MessageFlags.Ephemeral);
		expect(reply.components[0]!.toJSON().components[0]!.custom_id).toBe(`${GAME_ROOM_SELECT_PREFIX}:kick:room-1`);
	});
});

describe("isPickerPrefix", () => {
	it("accepts the select message's prefix and the modal's, and nothing else", () => {
		expect(isPickerPrefix(GAME_ROOM_SELECT_PREFIX)).toBe(true);
		expect(isPickerPrefix(GAME_ROOM_MODAL_PREFIX)).toBe(true);
		expect(isPickerPrefix("gameroom")).toBe(false);
		expect(isPickerPrefix(undefined)).toBe(false);
	});
});

describe("pickedValues", () => {
	it("reads a select message's values and a modal's select field alike", () => {
		expect(pickedValues(selectMessage(["u-1"]))).toEqual(["u-1"]);
		expect(pickedValues(modalSubmit(["u-2"]))).toEqual(["u-2"]);
	});

	it("reads a hand made modal submit without the field as no pick, never a throw", () => {
		expect(pickedValues(modalSubmit(null))).toEqual([]);
	});
});

describe("a slow pick", () => {
	it("edits the select message in place, clearing its select", async () => {
		const interaction = selectMessage(["u-1"]);
		await deferPick(interaction);
		await answerPick(interaction, "Removed.");
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		expect(interaction.editReply).toHaveBeenCalledWith({ content: "Removed.", components: [] });
	});

	it("answers a modal's pick privately and never through deferUpdate, which would rewrite the card the modal came from", async () => {
		const interaction = modalSubmit(["u-1"]);
		await deferPick(interaction);
		await answerPick(interaction, "Removed.");
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
		expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		expect(interaction.editReply).toHaveBeenCalledWith({ content: "Removed." });
	});
});

// ── the two additions for the creation modal (2026-10 item 263 Phase 2a) ──
// A multi choice select (none to all of its options) and a value per field to prefill, which
// Edit settings opens the creation modal with.
describe("buildFieldsModal's multi choice select and prefilled values", () => {
	const options = [
		{ label: "Auctions", value: "auctions" },
		{ label: "Voice referee", value: "referee" },
	];
	type Json = { components: Array<{ component?: { custom_id: string; min_values?: number; max_values?: number; required?: boolean; value?: string; options?: Array<{ value: string; default?: boolean }> } }> };
	const componentOf = (fields: ModalField[], id: string) => (buildFieldsModal({ customId: "m", title: "t", text: [], fields }).toJSON() as unknown as Json).components.find((entry) => entry.component?.custom_id === id)?.component;

	it("lets a multi choice select take none to all of its options, so it is not required", () => {
		expect(componentOf([{ kind: "multi", id: "table", label: "Table options", options }], "table")).toMatchObject({ min_values: 0, max_values: 2, required: false });
	});

	it("keeps a single select required, one choice", () => {
		expect(componentOf([{ kind: "select", id: "pick", label: "Pick", options }], "pick")).toMatchObject({ min_values: 1, max_values: 1, required: true });
	});

	it("prefills a select's choices and a text input's text", () => {
		const multi = componentOf([{ kind: "multi", id: "table", label: "Table options", options, value: ["referee"] }], "table");
		expect(multi?.options?.filter((option) => option.default).map((option) => option.value)).toEqual(["referee"]);
		const single = componentOf([{ kind: "select", id: "pick", label: "Pick", options: options.map((option, index) => ({ ...option, isDefault: index === 0 })), value: "referee" }], "pick");
		expect(single?.options?.filter((option) => option.default).map((option) => option.value)).toEqual(["referee"]);
		expect(componentOf([{ kind: "text", id: "buyIn", label: "Buy in", placeholder: "", maxLength: 12, value: "5000" }], "buyIn")?.value).toBe("5000");
	});

	it("reads a multi choice select back as its values joined, and an empty one as empty", () => {
		const fields: ModalField[] = [{ kind: "multi", id: "table", label: "Table options", options }];
		const answered = (values: string[]) => ({ fields: { getStringSelectValues: () => values } }) as unknown as ModalSubmitInteraction;
		expect(readFieldAnswers(answered(["auctions", "referee"]), fields)).toEqual({ table: "auctions,referee" });
		expect(readFieldAnswers(answered([]), fields)).toEqual({ table: "" });
	});
});
