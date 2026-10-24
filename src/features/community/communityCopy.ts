import { GuildExplicitContentFilter, GuildVerificationLevel } from "discord.js";

// ── community user-facing copy ───────────────────────────────────────
// Feature-local copy module, the sibling of gameRoomsCopy.ts and its reasoning
// (2026-10 item 247 Phase 3): every string here is read by the owner or an admin
// in #admin-commands, #inner-sanctum or a private reply, and "Community is on"
// reads the same in the kingdom voice and the streamer voice, so a two-pack split
// would double the authoring for content that comes out the same twice.
// Who:   communityControls (button labels), enableCommunity (the modal, the review,
//        the replies and the screening form), communityButtons (the router's
//        refusals and the Configure Onboarding stub), communityButtonsPointer.
//
// House rule for every string below: no dashes in user-facing copy.

// Discord's own names for the settings the review reports, keyed by the enum so a
// level Discord adds later renders as its number rather than crashing a reply.
const VERIFICATION_LEVEL_NAMES: Record<GuildVerificationLevel, string> = {
	[GuildVerificationLevel.None]: "None",
	[GuildVerificationLevel.Low]: "Low",
	[GuildVerificationLevel.Medium]: "Medium",
	[GuildVerificationLevel.High]: "High",
	[GuildVerificationLevel.VeryHigh]: "Highest",
};

const CONTENT_FILTER_NAMES: Record<GuildExplicitContentFilter, string> = {
	[GuildExplicitContentFilter.Disabled]: "Off",
	[GuildExplicitContentFilter.MembersWithoutRoles]: "Members without roles",
	[GuildExplicitContentFilter.AllMembers]: "All members",
};

/** One setting's line in the review: what it is now and what Confirm makes it. */
interface ISettingChange {
	from: string;
	to: string;
}

/** What the review and the success reply describe. */
export interface ICommunityChangeSummary {
	rulesChannelId: string;
	publicUpdatesChannelId: string;
	verificationLevel: ISettingChange;
	contentFilter: ISettingChange;
	membershipScreening: boolean;
	rulesTruncated: boolean;
}

/** How the Membership Screening write went, for the success reply. */
export type ScreeningReplyOutcome = "enabled" | "skipped" | "refused";

// "Low to Medium" when Confirm raises it, "stays High" when it is already there.
const settingLine = (label: string, change: ISettingChange): string =>
	change.from === change.to ? `• ${label}: stays ${change.to}` : `• ${label}: ${change.from} to ${change.to}`;

const channelLines = (summary: ICommunityChangeSummary): string[] => [
	`• Rules channel: <#${summary.rulesChannelId}>`,
	`• Community updates channel: <#${summary.publicUpdatesChannelId}>`,
];

const settingLines = (summary: ICommunityChangeSummary): string[] => [
	settingLine("Verification level", summary.verificationLevel),
	settingLine("Explicit content filter", summary.contentFilter),
];

// Said in the review and again in the result, so the owner learns before Confirm
// that the form carries fewer rules than the server has. The cut falls between
// whole rules (enableCommunity.fitRulesToScreeningForm), never inside one.
const rulesCutNotice = (rulesLimit: number): string =>
	`The rules are longer than ${rulesLimit} characters, so the screening form shows the whole rules that fit and leaves out the rest.`;

export const communityCopy = {
	rulesCutNotice,
	verificationLevelName: (level: GuildVerificationLevel): string => VERIFICATION_LEVEL_NAMES[level] ?? String(level),
	contentFilterName: (filter: GuildExplicitContentFilter): string => CONTENT_FILTER_NAMES[filter] ?? String(filter),

	// ── the admin guide's row and the flow's own buttons ──
	buttons: {
		enable: "Enable Community",
		configure: "Configure Onboarding",
		confirm: "Confirm",
	},

	// ── refusals the router and the flow share ──
	errors: {
		notInServer: "This button only works inside a server.",
		notSetUp: "This server is not set up yet. Run /setup first.",
		// A button from an older layout. Discord keeps every component clickable
		// forever, so this is normal to hit and the copy says so plainly.
		controlRetired: "This control is no longer available.",
		// The pending pick lives in memory, so a restart or the wait running out both
		// land here; the way back is the same button that started it.
		expired: "That request expired. Press Enable Community again to start over.",
		// Names what to grant and where, because the admin reading it is the one who
		// can fix it, and "no" alone reads as the button being broken.
		missingPermissions: (permissionNames: readonly string[]): string =>
			`Dero cannot turn Community on yet. Grant Dero ${permissionNames.join(", ")} (or Administrator) in Server Settings, Roles, then press Enable Community again.`,
		permissionsUnreadable: "Dero could not read its own permissions in this server. Try again in a moment.",
		channelsMissing: "Pick both a rules channel and a community updates channel, then submit again.",
	},

	// Discord's names for the permissions Enable Community needs, keyed by the flag name.
	permissionNames: {
		ManageGuild: "Manage Server",
		ManageRoles: "Manage Roles",
		ManageChannels: "Manage Channels",
	},

	// ── already on ──
	alreadyOn: {
		title: "Community is already on",
		description: (status: { rulesChannelId: string | null; publicUpdatesChannelId: string | null; verificationLevel: string; contentFilter: string }): string =>
			[
				"Discord Community is already switched on for this server, so there is nothing to enable.",
				"",
				`• Rules channel: ${status.rulesChannelId ? `<#${status.rulesChannelId}>` : "not set"}`,
				`• Community updates channel: ${status.publicUpdatesChannelId ? `<#${status.publicUpdatesChannelId}>` : "not set"}`,
				`• Verification level: ${status.verificationLevel}`,
				`• Explicit content filter: ${status.contentFilter}`,
				"",
				"Configure Onboarding is the next step.",
			].join("\n"),
	},

	// ── the modal: two channel picks and the screening checkbox ──
	// Labels are capped at 45 characters and descriptions at 100 by Discord.
	modal: {
		title: "Enable Community",
		rulesLabel: "Rules channel",
		rulesDescription: "Where Discord points new members for the server rules.",
		publicUpdatesLabel: "Community updates channel",
		publicUpdatesDescription: "Where Discord sends notices for moderators. A staff only channel works best.",
		screeningLabel: "Membership Screening",
		screeningDescription: "New members accept the server rules before they can talk. On by default.",
	},

	// ── the review, before anything changes ──
	review: {
		title: "Review: Enable Community",
		description: (summary: ICommunityChangeSummary, rulesLimit: number): string => {
			const screening = summary.membershipScreening ? "• Membership Screening: on, using the server rules" : "• Membership Screening: off";
			const lines = ["Confirm turns on Discord Community for this server. Here is what changes:", "", ...channelLines(summary), ...settingLines(summary), screening];
			if (summary.membershipScreening && summary.rulesTruncated) lines.push("", rulesCutNotice(rulesLimit));
			lines.push("", "Nothing changes until you press Confirm.");
			return lines.join("\n");
		},
	},

	// ── the result ──
	success: {
		title: "Community is on",
		description: (summary: ICommunityChangeSummary, screening: ScreeningReplyOutcome, rulesLimit: number): string => {
			const lines = ["Discord Community is now switched on for this server.", "", ...channelLines(summary), ...settingLines(summary)];
			if (screening === "enabled") lines.push("• Membership Screening: on. New members accept the server rules before they can talk.");
			if (screening === "skipped") lines.push("• Membership Screening: off, as you chose.");
			if (screening === "refused") {
				lines.push("• Membership Screening: Discord did not accept the screening form, so it is off. Switch it on by hand in Server Settings if you want it.");
			}
			if (screening === "enabled" && summary.rulesTruncated) lines.push("", rulesCutNotice(rulesLimit));
			lines.push("", "Configure Onboarding is the next step.");
			return lines.join("\n");
		},
	},

	failures: {
		// 50013 on the guild edit. Manage Server is the permission that edit needs.
		missingPermission: "Discord refused: Dero is missing the Manage Server permission. Grant it in Server Settings, Roles, then press Enable Community again.",
		// Discord's own words, verbatim, because a 400 names the setting it rejected
		// and a paraphrase would hide which one.
		rejected: (discordMessage: string): string => `Discord refused the change. Nothing was switched on.\n\nDiscord said: ${discordMessage}`,
		unconfirmed: "Dero could not get an answer from Discord, so it cannot tell whether Community switched on. Check Server Settings, and press Enable Community again if it is still off.",
	},

	// ── the Membership Screening form, which Discord shows to every new member ──
	screeningForm: {
		label: "Server Rules",
		description: "Please read and accept the server rules.",
	},

	// The reason Discord's audit log shows beside each change Dero makes here.
	auditReason: "Enabled by Dero via Enable Community",

	// ── Configure Onboarding, until it is built ──
	configureComingSoon:
		"Configure Onboarding is coming in the next Dero release. Until then you can set up Onboarding by hand in Server Settings, Onboarding.",

	// ── the one time pointer in #inner-sanctum ──
	pointer: {
		title: "New: Community buttons",
		description: (adminCommandsChannelId: string): string =>
			[
				`The admin controls card in <#${adminCommandsChannelId}> has two new buttons.`,
				"",
				"**Enable Community** switches on Discord Community for this server. You pick the rules channel and a channel for moderator notices, and Membership Screening (on by default) asks new members to accept your rules before they can talk.",
				"",
				"**Configure Onboarding** has its button already, and it opens in the next Dero release.",
			].join("\n"),
	},
};
