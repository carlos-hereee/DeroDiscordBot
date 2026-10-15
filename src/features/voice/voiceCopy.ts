// ── Dero voice user-facing copy ───────────────────────────────────────
// Feature-local copy module, the sibling of gameRoomsCopy.ts and fortuneCopy.ts,
// with their reasoning: the voice is a bot feature rather than a platform plugin,
// and "Dero cannot speak right now" reads the same in the kingdom voice and the
// streamer voice, so a two-pack split would double the authoring for content that
// comes out the same twice. If voice ever graduates into a real plugin this file
// moves into the pack + copyOverrides system wholesale.
//
// Two audiences. `listen` is what a member sees after pressing Listen, short and
// in Dero's voice. `config` is the admin's /dero-config replies, practical and
// plain, like the other admin commands.
//
// House rule for every string below: no dashes in user-facing copy.

const onOff = (on: boolean): string => (on ? "ON" : "OFF");

export const voiceCopy = {
	// ── the Listen button and its private replies ──
	listen: {
		buttonLabel: "Listen",
		// Each refusal names its cause, so a member learns whether to wait, ask an
		// admin, or give up for the month, rather than that "something failed".
		voiceOff: "Dero's voice is switched off in this server right now.",
		notSetUp: "Dero's voice is not set up in this server yet.",
		listenOff: "Listening is turned off in this server.",
		nothingToRead: "There is nothing in this post for Dero to read aloud.",
		cooldown: (seconds: number): string => `Dero needs a breath. Try Listen again in ${seconds}s.`,
		capReached: "Dero has used this server's voice budget for the month. Listen comes back next month.",
		providerTrouble: "Dero could not find his voice just now. Try again in a little while.",
		// Rides the clip when the post was longer than Listen reads, so the member
		// knows the recording stops early on purpose.
		truncated: "This post is long, so Dero read the first part.",
	},

	// ── /dero-config, admin facing ──
	config: {
		commandDescription: "Set up Dero's voice and the Listen button for this server",
		sub: {
			status: "Show this server's voice settings and this month's speech spend",
			enable: "Turn Dero's voice on (needs a voice id first)",
			disable: "Turn Dero's voice off. Every setting is kept",
			voice: "Set the ElevenLabs voice id Dero speaks with",
			voiceOption: "The voice id from your ElevenLabs voice library",
			listen: "Show or hide Listen buttons on fortunes and welcomes",
			listenOption: "True shows Listen buttons, false hides them",
			cap: "Set the monthly speech budget for this server, in whole dollars",
			capOption: "Whole dollars per month. 0 refuses every speech call",
			roleGroup: "Roles that may give Dero tasks (used from the next phase)",
			channelGroup: "Text channels Dero may post in (used from the next phase)",
			voiceChannelGroup: "Voice channels Dero may join (used in a later phase)",
			add: "Add one to the list",
			remove: "Remove one from the list",
			roleOption: "The role",
			channelOption: "The text channel",
			voiceChannelOption: "The voice channel",
		},

		notInGuild: "Run this in a server, not a DM.",
		setupRequired: "This server has not been set up yet. Run /setup first.",
		saveFailed: "Could not save that change. Try again or check the bot's logs.",

		statusTitle: "🔊 Dero voice settings",
		statusBody: (status: {
			enabled: boolean;
			voiceIdTail: string | null;
			listenEnabled: boolean;
			keyConfigured: boolean;
			roles: number;
			channels: number;
			voiceChannels: number;
			spentUsd: string;
			capUsd: number;
		}): string =>
			[
				`Voice: **${onOff(status.enabled)}**`,
				`Voice id: ${status.voiceIdTail ? `set, ending in \`${status.voiceIdTail}\`` : "not set"}`,
				`Listen buttons: **${onOff(status.listenEnabled)}**`,
				`Speech key on the bot: ${status.keyConfigured ? "configured" : "missing, so no speech call is sent"}`,
				`Allowed roles: ${status.roles} · text channels: ${status.channels} · voice channels: ${status.voiceChannels}`,
				`This month: $${status.spentUsd} of a $${status.capUsd} cap (an estimate, not the provider's invoice)`,
			].join("\n"),

		enabledTitle: "🔊 Dero's voice is ON",
		enabledBody:
			"Listen buttons appear on new fortunes and welcomes while Listen is on. Posts made before now keep no button.",
		alreadyEnabled: "Dero's voice is already ON. No change made.",
		enableNeedsVoice: "Set a voice first with /dero-config voice, then run enable again.",
		disabledTitle: "🔇 Dero's voice is OFF",
		disabledBody:
			"No speech call is sent and Listen buttons stop answering. Every setting is kept, so enable brings it back exactly as it was.",
		alreadyDisabled: "Dero's voice is already OFF. No change made.",

		voiceInvalid: (min: number, max: number): string =>
			`That does not look like a voice id. Paste the id from ElevenLabs: ${min} to ${max} letters and digits, nothing else.`,
		voiceSet: (tail: string): string => `Voice id saved, ending in \`${tail}\`.`,
		voiceUnchanged: (tail: string): string => `That voice id (ending in \`${tail}\`) is already set. No change made.`,

		listenSet: (on: boolean): string => `Listen buttons are now **${onOff(on)}**.`,
		listenUnchanged: (on: boolean): string => `Listen buttons are already **${onOff(on)}**. No change made.`,

		capSet: (usd: number): string =>
			usd === 0
				? "Monthly cap set to $0. Every speech call is refused until you raise it."
				: `Monthly cap set to $${usd}.`,
		capUnchanged: (usd: number): string => `The monthly cap is already $${usd}. No change made.`,

		// `item` is a rendered mention (<@&id> or <#id>); these replies are
		// ephemeral embeds, which never ping.
		listAdded: (item: string): string => `${item} added.`,
		listAlreadyThere: (item: string): string => `${item} is already on the list. No change made.`,
		listRemoved: (item: string): string => `${item} removed.`,
		listNotThere: (item: string): string => `${item} is not on the list. No change made.`,
		listTitle: {
			roles: "Allowed roles",
			channels: "Allowed text channels",
			voiceChannels: "Allowed voice channels",
		},
	},
};
