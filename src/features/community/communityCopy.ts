import { GuildExplicitContentFilter, GuildVerificationLevel } from "discord.js";

// ── community user-facing copy ───────────────────────────────────────
// Feature-local copy module, the sibling of gameRoomsCopy.ts and its reasoning
// (2026-10 item 247 Phase 3): every string here is read by the owner or an admin
// in #admin-commands, #inner-sanctum or a private reply, and "Community is on"
// reads the same in the kingdom voice and the streamer voice, so a two-pack split
// would double the authoring for content that comes out the same twice.
// Who:   communityControls (button labels), enableCommunity (the modal, the review,
//        the replies and the screening form), communityButtons (the router's
//        refusals), communityButtonsPointer, and the Configure Onboarding modules
//        (onboardingPreconditions, onboardingDraft, configureOnboarding,
//        promptEditModal), which read the `onboarding` section.
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

/** What the Configure Onboarding review says above its questions. */
export interface IOnboardingReviewSummary {
	memberRoleId: string;
	defaultChannelIds: readonly string[];
	startedFromExisting: boolean;
	finalPromptAdded: boolean;
	/** Roles given by answers in more than one question, which the review warns about. */
	reusedRoleIds: readonly string[];
}

/** One question as the review shows it. */
export interface IOnboardingPromptView {
	required: boolean;
	singleSelect: boolean;
	isFinal: boolean;
}

/** One answer as the review shows it: its title, its description and what picking it gives. */
export interface IOnboardingOptionView {
	title: string;
	description: string | null;
	roleIds: readonly string[];
	channelIds: readonly string[];
}

// How many default channels the review names before it counts the rest, so a
// server with a hundred open channels still fits one embed description.
const REVIEW_DEFAULT_CHANNELS_SHOWN = 20;

const mentionList = (ids: readonly string[], shown: number, render: (id: string) => string): string => {
	const named = ids.slice(0, shown).map(render).join(", ");
	return ids.length > shown ? `${named} and ${ids.length - shown} more` : named;
};

// The review's opening line: a fresh draft, or the server's own questions kept,
// with or without the final question Dero had to add.
const onboardingReviewOpening = (summary: IOnboardingReviewSummary): string => {
	if (!summary.startedFromExisting) return "Dero drafted these Onboarding questions for this server. New members answer them when they join.";
	if (summary.finalPromptAdded) {
		return "This server already has Onboarding questions, so the draft keeps every one of them as it is and adds the final question that gives the member role.";
	}
	return "This server already has Onboarding questions, so the draft keeps every one of them as it is.";
};

// What picking an answer gives, after its title: "(gives @Member, opens #general)".
// A role another question's answer also gives is marked ⚠️ (2026-10 item 254).
const optionGrants = (option: IOnboardingOptionView, reusedRoleIds: ReadonlySet<string>): string => {
	const grants = [...option.roleIds.map((id) => `gives ${reusedRoleIds.has(id) ? "⚠️ " : ""}<@&${id}>`), ...option.channelIds.map((id) => `opens <#${id}>`)];
	return grants.length > 0 ? ` (${grants.join(", ")})` : "";
};

// The one warning line above the questions when answers in different questions give
// the same role. Never a refusal: the owner may mean it (the owner's decision).
const reusedRolesWarning = (roleIds: readonly string[]): string =>
	`⚠️ ${roleIds.map((id) => `<@&${id}>`).join(", ")} ${roleIds.length === 1 ? "is" : "are"} given by answers in more than one question, so a member can get ${roleIds.length === 1 ? "it" : "them"} from either.`;

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
		// The Onboarding review's editor (2026-10 item 254). Labels are capped at 80
		// characters and placeholders at 150, by Discord.
		pickPromptPlaceholder: "Pick a question to edit",
		pickOptionPlaceholder: "Pick an answer to edit or delete",
		editPrompt: "Edit question",
		deletePrompt: "Delete question",
		addPrompt: "Add question",
		addOption: "Add answer",
		editOption: "Edit answer",
		deleteOption: "Delete answer",
		confirmOnboarding: "Confirm",
		cancelOnboarding: "Cancel",
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

	// ── Configure Onboarding (2026-10 item 247 Phase 4) ──
	onboarding: {
		// The starter questions a server with none gets. The owner can edit or remove
		// the two optional ones in the review; the final one keeps its shape.
		draft: {
			heardAbout: { title: "Where did you hear about us?", options: ["Friend", "Twitter", "Reddit", "YouTube", "Other"] },
			goals: { title: "What do you want to do here?", options: ["Play games", "Chat", "Lurk", "Build things"] },
			// The owner's own wording (plan, Owner decisions). It must stay within the
			// 100 character question title cap; onboardingDraft.test pins that.
			final: {
				title: "✨ You're officially part of the community! Thanks for being here and supporting the journey.",
				optionTitle: "Glad to be here",
			},
		},

		// One sentence per precondition, in the order they are checked. Dero speaks
		// in the first person here, the plan's own wording for each refusal.
		preconditions: {
			communityOff: "Community is not enabled. Click Enable Community first.",
			missingPermissions: "I need Manage Server and Manage Roles. Please re-invite me with those or check my role permissions.",
			noMemberRole: "No member role is configured. Run /setup first.",
			memberRoleIsEveryone: "The member role is set to @everyone, which every member already has, so Onboarding cannot give it. Run /setup and pick a member role.",
			memberRoleGone: "The member role /setup saved no longer exists in this server. Run /setup and pick a member role.",
			memberRoleAboveBot: (roleName: string): string => `My role must sit above the member role in Server Settings → Roles. Please move me above ${roleName}.`,
			tooFewSendableChannels: (count: number, minimum: number): string =>
				`Discord requires at least ${minimum} channels where everyone can send messages before I can turn on Onboarding. You currently have ${count}; please add ${minimum - count} more and try again.`,
		},

		// Why a draft cannot be written, found while drafting or again at Confirm.
		draftErrors: {
			roleAboveBot: (roleName: string): string =>
				`An Onboarding answer gives ${roleName}, which sits above my highest role, so Discord would refuse it. Move my role above ${roleName} in Server Settings → Roles, or remove that answer, then try again.`,
			roleGone: "An Onboarding answer gives a role that no longer exists. Remove that answer in Server Settings → Onboarding, then try again.",
			// The edit flow cannot cause this; it guards the write in case a draft ever
			// reaches Confirm without the question that gives the member role.
			finalPromptInvalid: "The draft lost its final question, the one that gives the member role, so I stopped before changing anything. Press Configure Onboarding to start a fresh draft.",
		},

		// Reading the live config failed. Nothing is drafted over a config Dero could
		// not read, or the review would offer to replace questions it never saw.
		readFailed: (discordMessage: string): string =>
			`I could not read this server's Onboarding settings, so I stopped before drafting anything over them.\n\nDiscord said: ${discordMessage}`,
		expired: "That draft expired. Press Configure Onboarding to start over.",

		// ── the review ──
		review: {
			title: "Review: Configure Onboarding",
			description: (summary: IOnboardingReviewSummary): string => {
				const channels = summary.defaultChannelIds.length > 0 ? mentionList(summary.defaultChannelIds, REVIEW_DEFAULT_CHANNELS_SHOWN, (id) => `<#${id}>`) : "none";
				return [
					onboardingReviewOpening(summary),
					"",
					`Confirm switches Onboarding on in Advanced mode, and the final question gives <@&${summary.memberRoleId}>.`,
					"",
					`**Default channels** (${summary.defaultChannelIds.length}), which every new member gets right away: ${channels}`,
					"",
					...(summary.reusedRoleIds.length > 0 ? [reusedRolesWarning(summary.reusedRoleIds), ""] : []),
					"Pick a question below to edit it, delete it, or add and change its answers, each with its own roles. Nothing changes until you press Confirm.",
				].join("\n");
			},
			promptFieldName: (position: number, title: string): string => `${position}. ${title}`,
			promptRules: (prompt: IOnboardingPromptView): string => {
				if (prompt.isFinal) return "Required, the last question. Its answer gives the member role.";
				return `${prompt.required ? "Required" : "Optional"}, members pick ${prompt.singleSelect ? "one answer" : "any answers"}.`;
			},
			optionLine: (option: IOnboardingOptionView, reusedRoleIds: ReadonlySet<string>): string =>
				`• ${option.title}${option.description ? `: ${option.description}` : ""}${optionGrants(option, reusedRoleIds)}`,
			// When a question has more answers than one embed field holds.
			moreOptions: (count: number): string => `and ${count} more`,
		},

		// ── the edit modals ──
		// Labels are capped at 45 characters, descriptions and placeholders at 100,
		// and the modal title at 45, by Discord.
		modal: {
			title: (position: number): string => `Edit question ${position}`,
			finalTitle: "Edit the final question",
			addPromptTitle: "Add a question",
			editOptionTitle: (position: number): string => `Edit an answer to question ${position}`,
			addOptionTitle: (position: number): string => `Add an answer to question ${position}`,
			promptTitleLabel: "Question",
			promptTitleDescription: "The question new members read.",
			finalTitleDescription: "The last question. It stays required, and members pick its one answer.",
			finalOptionLabel: "Answer",
			finalOptionDescription: "Picking this answer gives the member role. Only its title can change.",
			optionTitleLabel: "Answer",
			optionTitleDescription: "What a member picks.",
			firstOptionTitleDescription: "The question's first answer. Add more after.",
			optionDescriptionLabel: "Description",
			optionDescriptionDescription: "Optional, shown under the answer.",
			optionRolesLabel: "Roles",
			optionRolesDescription: "Roles a member gets for picking this answer. Each must sit below Dero.",
		},

		// A submit or press the editor refuses. Nothing in the draft changes.
		editErrors: {
			promptGone: "That question is no longer in the draft. Use the buttons on the latest review.",
			optionGone: "That answer is no longer in the draft. Use the buttons on the latest review.",
			reviewOutdated: "This review is out of date. Use the controls on the latest review.",
			tooLongToEdit: "This question or answer is longer than an edit box holds. Edit it in Server Settings, Onboarding, instead.",
			emptyTitle: "A question needs a title.",
			emptyOptionTitle: "Every answer needs a title.",
			titleTooLong: (max: number): string => `A question can be at most ${max} characters.`,
			optionTitleTooLong: (title: string, max: number): string => `The answer "${title}" is longer than ${max} characters.`,
			descriptionTooLong: (title: string, max: number): string => `The description of "${title}" is longer than ${max} characters.`,
			tooManyOptions: (max: number): string => `A question can have at most ${max} answers.`,
			tooManyPrompts: (max: number): string => `The review can hold at most ${max} questions.`,
			tooManyRoles: (max: number): string => `An answer edited here can give at most ${max} roles.`,
			duplicateOption: (title: string): string => `The answer "${title}" is there twice. Give each answer its own title.`,
			finalPromptFixed: "The final question keeps its one answer and the member role. Edit its titles with Edit question.",
			lastOption: "A question needs at least one answer. Delete the question instead.",
			roleIsEveryone: "An answer cannot give @everyone, which every member already has. Pick another role.",
			roleGone: "One of the picked roles no longer exists. Pick the roles again.",
			roleAboveBot: (roleName: string): string =>
				`${roleName} sits above my highest role, so Discord would refuse to give it. Move my role above ${roleName} in Server Settings → Roles, or pick another role.`,
		},

		// ── the result ──
		success: {
			title: "Onboarding is on",
			description: (summary: { promptCount: number; defaultChannelCount: number; memberRoleId: string }): string =>
				[
					"Discord Onboarding is now switched on for this server, in Advanced mode.",
					"",
					`• Questions: ${summary.promptCount}, ending with the one that gives <@&${summary.memberRoleId}>`,
					`• Default channels: ${summary.defaultChannelCount}`,
					"",
					"Members who already finished Onboarding stay in. Anyone who should answer the new questions can retake Onboarding from Channels & Roles.",
				].join("\n"),
		},
		failures: {
			// 50013 on the write. Discord's Modify Guild Onboarding needs both permissions.
			missingPermission: "Discord refused: Dero is missing Manage Server or Manage Roles. Grant both in Server Settings, Roles, then press Confirm again.",
			// Discord's own words, verbatim, because a 400 names the question or the
			// channel rule it rejected and a paraphrase would hide which.
			rejected: (discordMessage: string): string => `Discord refused the Onboarding change. Nothing was changed.\n\nDiscord said: ${discordMessage}`,
			unconfirmed:
				"Dero could not get an answer from Discord, so it cannot tell whether Onboarding changed. Check Server Settings, Onboarding, and press Configure Onboarding again if it did not.",
		},
		cancelled: "Cancelled.",

		// The DM to the server owner after a successful write. editOnboarding does not
		// reset anyone who already finished Onboarding, so the owner is told how a
		// member sees the new questions.
		ownerDm: "Onboarding configured. Members who already completed Onboarding stay in; if any of them need to retake, point them to Channels & Roles → Retake Onboarding.",

		// The reason Discord's audit log shows beside the Onboarding change.
		auditReason: "Configured by Dero via Configure Onboarding",
	},

	// ── the one time pointer in #inner-sanctum ──
	pointer: {
		title: "New: Community button",
		description: (adminCommandsChannelId: string): string =>
			[
				`The admin controls card in <#${adminCommandsChannelId}> has a new Community button. It shows one of these two, whichever this server is ready for.`,
				"",
				"**Enable Community** switches on Discord Community for this server. You pick the rules channel and a channel for moderator notices, and Membership Screening (on by default) asks new members to accept your rules before they can talk.",
				"",
				"**Configure Onboarding** takes its place once Community is on. It drafts Discord Onboarding questions for this server, ending with one that gives the member role. You review and edit them before anything changes.",
			].join("\n"),
	},
};
