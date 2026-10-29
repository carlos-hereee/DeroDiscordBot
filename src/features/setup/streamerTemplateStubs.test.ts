import { describe, it, expect } from "vitest";
import type { Guild } from "discord.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { GuildSetupManager } from "./GuildSetupManager.js";
import { ChannelContent } from "./ChannelContent.js";
import { arcadeControlView, deroConfigView, onboardingView, serverConfigView } from "./headquartersCards.js";

// ── no stub reaches a streamer server (2026-10 item 262 Phase 4, risk R9) ──
// The general-events pack fills its Rise of Kingdoms only keys with a stub that reads
// "[unused in this plugin]" so a KvK path that leaks into a streamer guild shows loudly.
// Once the template step lets any admin pick streamer, every surface a switch rewrites
// has to read clean under that pack: the setup copy, every channel's intro and its
// buttons, the command guides, the invite card and the Headquarters cards.

const STUB = "[unused in this plugin]";
const streamer = { pluginId: "general-events" };

// The private statics refreshIntroEmbeds renders through, reached by a cast as the other
// setup tests do (test files are excluded from the tsc build).
const internals = GuildSetupManager as unknown as {
	resolveIntroEmbed(field: string, guild: Guild, adminRoleId: string | null, config: unknown): { toJSON(): unknown } | null;
	resolveIntroComponents(field: string, config: unknown): Array<{ toJSON(): unknown }> | null;
	inviteCardComponents(config: unknown): Array<{ toJSON(): unknown }>;
};

const guild = { id: "g1", ownerId: "owner-1" } as unknown as Guild;

function expectNoStub(label: string, rendered: unknown): void {
	// A channel with no buttons renders undefined, which has nothing to carry a stub.
	expect(JSON.stringify(rendered) ?? "", label).not.toContain(STUB);
}

describe("the streamer template's surfaces", () => {
	it("carries no stub in its setup copy, arrival, pairing DM or channel content", () => {
		const pack = getPluginCopy(streamer);
		expectNoStub("setup", pack.setup);
		expectNoStub("arrival", pack.arrival.description("Guild", "owner-1"));
		expectNoStub("pairingCode", pack.pairingCode.description("ABC123"));
		expectNoStub("channelContent", pack.channelContent);
	});

	it("renders every channel's intro and buttons without a stub, before and after /setup names an admin role", () => {
		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			for (const adminRoleId of [null, "role-1"]) {
				expectNoStub(`${spec.configField} intro`, internals.resolveIntroEmbed(spec.configField, guild, adminRoleId, streamer)?.toJSON());
			}
			expectNoStub(`${spec.configField} buttons`, internals.resolveIntroComponents(spec.configField, streamer)?.map((row) => row.toJSON()));
		}
	});

	it("renders the command guides and the invite card without a stub", () => {
		expectNoStub("command guide", ChannelContent.commandGuide(streamer).toJSON());
		expectNoStub("admin command guide", getPluginCopy(streamer).channelContent.adminCommandGuide);
		expectNoStub("invite card", ChannelContent.inviteCard(streamer).toJSON());
		expectNoStub("invite buttons", internals.inviteCardComponents(streamer).map((row) => row.toJSON()));
	});

	it("names every managed channel, and its invite button, in the streamer pack's own words", () => {
		expect(GuildSetupManager.CHANNEL_SPECS.find((spec) => spec.configField === "adminChannelId")!.displayName).toBe("🔒inner-sanctum");
		const adminSpec = GuildSetupManager.CHANNEL_SPECS.find((spec) => spec.configField === "adminChannelId")!;
		expect(GuildSetupManager.channelNameFor(adminSpec, streamer)).toBe("🔒admin");
		expect(ChannelContent.buildInviteButton(streamer).toJSON()).toMatchObject({ label: getPluginCopy(streamer).channelContent.inviteCard.buttonLabel });
	});

	it("draws the Headquarters cards without a stub", () => {
		const facts = { now: 0, activeEvents: 0, pausedEvents: 0, weeklySchedules: 0 };
		const row = { pluginId: "general-events" };
		expectNoStub("dero config", deroConfigView(null));
		expectNoStub("onboarding", onboardingView({ communityOn: false, onboardingOn: false, gated: false, memberRoleName: null, adoptedPlaced: true, adoptedLines: [] }));
		expectNoStub("arcade control", arcadeControlView(row));
		expectNoStub("server config", serverConfigView(row, facts));
	});
});
