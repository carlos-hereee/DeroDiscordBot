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
		outsideGuild: "These buttons only work inside a server.",
	},
	problems: {
		missing: (option: string) => `\`${option}\` is required. Open the form again and fill it in.`,
		notWholeNumber: (option: string) => `\`${option}\` must be a whole number.`,
		notNumber: (option: string) => `\`${option}\` must be a number.`,
		outOfRange: (option: string, range: string) => `\`${option}\` must be ${range}.`,
		nothingToPick: (option: string) => `There is nothing to pick for \`${option}\` right now, so this cannot run yet.`,
	},
} as const;
