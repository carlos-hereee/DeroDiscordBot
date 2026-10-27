// ── command buttons copy ───────────────────────────────────────────────────
// What:  every line the admin guide's command buttons say: the subcommand picker,
//        the optional field picker, the form's field hints and its refusals.
// Who:   the admin command launcher (adminCommandLauncher.ts). Admin facing and
//        private, so it is practical rather than kingdom voiced, like levelingCopy
//        and ratingsCopy, and it reads the same in every pack.
// Where: the buttons' labels are not here: each is the command's own name, so a
//        button can never name a command that does not exist.

export const commandButtonsCopy = {
	launcher: {
		pickLeafPlaceholder: "Choose what to do",
		pickLeafPrompt: (command: string) => `Pick what \`/${command}\` should do. It runs exactly as the slash command does.`,
		pickFieldsPlaceholder: "Choose the optional settings to fill in",
		pickFieldsPrompt: (command: string, max: number) =>
			`\`/${command}\` has more settings than one form can hold. Pick up to ${max} of the optional ones to fill in, or continue with the required ones only.`,
		continueWithoutLabel: "Continue with the required ones",
		yes: "Yes",
		no: "No",
		rangeHint: (min: number | null, max: number | null) => {
			if (min !== null && max !== null) return `${min} to ${max}`;
			if (min !== null) return `${min} or more`;
			if (max !== null) return `up to ${max}`;
			return "a number";
		},
		staleButton: "This button is from an older layout. The slash command still works.",
		// The notice title over staleButton (2026-10 item 254 Phase 5b).
		staleTitle: "🎛️ Controls",
		outsideGuild: "These buttons only work inside a server.",
	},
	// The settings modals (post-launch plan item 9). Labels hold 45 characters and
	// hints 100, Discord's ceilings; a hint the command already words (a voice or
	// leveling option) is read from the command instead of repeated here.
	panels: {
		switchesLabel: "Switches",
		switchesHint: "Selected settings are on. Deselect one to switch it off.",
		server: {
			title: "Server switches",
			autoHeal: "Auto heal channels",
			autoHealHint: "Rebuild homebase channels that go missing",
			tracking: "Leaderboard tracking",
			trackingHint: "Record reactions and voice joins as participation",
			weekLabel: "Leaderboard week starts on",
			weekHint: "The day the leaderboard's \"this week\" window begins",
		},
		serverChannels: {
			title: "Channel visibility",
			label: "Visible to members",
			hint: "Deselect a channel to hide it from members. Dero still posts in it.",
		},
		deroConfig: {
			title: "Dero settings",
			voice: "Dero's voice",
			listen: "Listen buttons",
			roles: "Roles that may give Dero tasks",
			rolesHint: "The server owner and the admin role always may, whatever this list holds",
			channels: "Text channels Dero may post in",
			voiceChannels: "Voice channels Dero may join",
			cap: "Monthly speech budget, in dollars",
		},
		arcade: {
			title: "Arcade settings",
			monthlyPost: "Monthly arcade post",
			bots: "Dero bot opponents",
		},
		leveling: {
			title: "Leveling settings",
			leveling: "Leveling",
			levelingHint: "Members earn XP. Off records nothing new and deletes nothing.",
			stackRewards: "Keep every reward role",
			stackRewardsHint: "Off keeps only the highest reward a member earned",
			stackMultipliers: "Combine XP multipliers",
			stackMultipliersHint: "Off pays only the highest multiplier that applies",
			curve: "Level curve",
			milestones: "Milestone levels",
			announce: "Where level ups post",
			reactionAwards: "Who a reaction pays",
		},
		saved: {
			title: (command: string) => `/${command} settings`,
			nothingChanged: "Every setting is as it was, so nothing was written.",
			moreChanges: (count: number) => `${count} more changes were saved. Each one has a line in the admin log.`,
			runFailed: (path: string) => `Saving \`${path}\` failed. Try it again from its subcommand, or check the bot's logs.`,
			morePrompt: (command: string) => `More \`/${command}\` options:`,
		},
	},
	problems: {
		missing: (option: string) => `\`${option}\` is required. Open the form again and fill it in.`,
		notWholeNumber: (option: string) => `\`${option}\` must be a whole number.`,
		notNumber: (option: string) => `\`${option}\` must be a number.`,
		outOfRange: (option: string, range: string) => `\`${option}\` must be ${range}.`,
		nothingToPick: (option: string) => `There is nothing to pick for \`${option}\` right now, so this cannot run yet.`,
	},
} as const;
