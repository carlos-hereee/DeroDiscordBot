import { describe, it, expect, vi } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";
import { buildPrivateViewModal, closePrivateView, showPrivateView, PRIVATE_VIEW_ACTION } from "./privateView.js";
import { GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";

// ── privateView (post-launch plan item 16) ───────────────────────────
// The modal a player's own board or hand opens in, and the fallback that keeps the
// view private when Discord refuses it. The games' own suites cover WHAT each view
// shows; this one covers the shape and the fallback they share.

type ModalJson = { custom_id: string; title: string; components: { type: number; content?: string }[] };

function press(showModal: ReturnType<typeof vi.fn>): ButtonInteraction {
	return { showModal, reply: vi.fn().mockResolvedValue(undefined) } as unknown as ButtonInteraction;
}

describe("buildPrivateViewModal", () => {
	it("routes back through the room's modal prefix and carries the room id", () => {
		const json = buildPrivateViewModal("room-9", { title: "Your hand", sections: ["A♠ K♠"] }).toJSON() as unknown as ModalJson;
		expect(json.custom_id).toBe(`${GAME_ROOM_MODAL_PREFIX}:${PRIVATE_VIEW_ACTION}:room-9`);
		expect(json.title).toBe("Your hand");
	});

	it("draws one text display per non empty section, at most five", () => {
		const sections = ["one", "", "two", "three", "four", "five", "six"];
		const json = buildPrivateViewModal("room-1", { title: "t", sections }).toJSON() as unknown as ModalJson;
		expect(json.components.map((component) => component.content)).toEqual(["one", "two", "three", "four", "five"]);
		// 10 is Discord's TextDisplay component type.
		expect(json.components.every((component) => component.type === 10)).toBe(true);
	});

	it("cuts a section to Discord's 4000 character limit", () => {
		const json = buildPrivateViewModal("room-1", { title: "t", sections: ["x".repeat(5000)] }).toJSON() as unknown as ModalJson;
		expect(json.components[0].content).toHaveLength(4000);
	});
});

describe("showPrivateView", () => {
	it("opens the modal and does not reply", async () => {
		const interaction = press(vi.fn().mockResolvedValue(undefined));
		const fallback = vi.fn();

		await showPrivateView(interaction, "room-1", { title: "t", sections: ["s"] }, fallback);

		expect(interaction.showModal).toHaveBeenCalledOnce();
		expect(fallback).not.toHaveBeenCalled();
		expect(interaction.reply).not.toHaveBeenCalled();
	});

	it("answers with the fallback when Discord refuses the modal", async () => {
		const interaction = press(vi.fn().mockRejectedValue(new Error("Invalid Form Body")));
		const fallback = vi.fn().mockResolvedValue({ content: "private", flags: 64 });

		await showPrivateView(interaction, "room-1", { title: "t", sections: ["s"] }, fallback);

		expect(interaction.reply).toHaveBeenCalledWith({ content: "private", flags: 64 });
	});
});

describe("closePrivateView", () => {
	it("acknowledges the close without a reply, and survives a failed acknowledgement", async () => {
		const deferUpdate = vi.fn().mockRejectedValue(new Error("Unknown interaction"));
		await expect(closePrivateView({ deferUpdate } as unknown as ModalSubmitInteraction)).resolves.toBeUndefined();
		expect(deferUpdate).toHaveBeenCalledOnce();
	});
});
