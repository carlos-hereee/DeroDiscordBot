import { describe, it, expect, vi } from "vitest";
import { EmbedBuilder, type RepliableInteraction } from "discord.js";
import { collectReplies } from "./replyCollector.js";

// ── the reply collector ──────────────────────────────────────────────────────
// A settings panel runs a command's own handler once per changed setting, so the
// collector must keep every reply away from Discord, answer replied and deferred
// for its own run, and read everything else through to the real interaction.

class FakeInteraction {
	readonly guildId = "g1";
	readonly user = { id: "u1" };
	private readonly secret = "kept";
	replied = true;
	deferred = true;
	reply = vi.fn(async () => undefined);
	editReply = vi.fn(async () => undefined);
	followUp = vi.fn(async () => undefined);
	deferReply = vi.fn(async () => undefined);
	readSecret(): string {
		return this.secret;
	}
}

function collect() {
	const real = new FakeInteraction();
	const run = collectReplies(real as unknown as RepliableInteraction);
	return { real, ...run };
}

describe("collectReplies", () => {
	it("keeps every reply instead of sending it, and starts each run unanswered", async () => {
		const { real, interaction, replies } = collect();
		expect(interaction.replied).toBe(false);
		expect(interaction.deferred).toBe(false);

		await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Saved")], components: [] });
		await interaction.followUp("and one more");

		expect(real.reply).not.toHaveBeenCalled();
		expect(real.followUp).not.toHaveBeenCalled();
		expect(interaction.replied).toBe(true);
		expect(replies).toHaveLength(2);
		expect(replies[1]).toEqual({ content: "and one more", embeds: [], components: [] });
	});

	it("lets an edit replace the run's last reply, and a defer only mark the run", async () => {
		const { real, interaction, replies } = collect();
		await interaction.deferReply();
		expect(interaction.deferred).toBe(true);
		expect(real.deferReply).not.toHaveBeenCalled();

		await interaction.editReply({ content: "working" });
		await interaction.editReply({ content: "done" });
		expect(replies.map((reply) => reply.content)).toEqual(["done"]);
	});

	it("reads everything else through to the real interaction, methods bound to it", () => {
		const { interaction } = collect();
		const passthrough = interaction as unknown as FakeInteraction;
		expect(interaction.guildId).toBe("g1");
		expect(interaction.user.id).toBe("u1");
		expect(passthrough.readSecret()).toBe("kept");
	});
});
