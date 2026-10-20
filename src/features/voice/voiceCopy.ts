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

	// ── voice calls: /dero join and /dero leave, and what Dero posts in text ──
	// The refusals here are only the ones a call adds. /dero join reuses the
	// lines that already fit word for word: deroBrainCopy.tell for the guild,
	// kill switch and task list gates, and listen.notSetUp for a missing voice.
	call: {
		replyTitle: "🔊 Dero in voice",
		notInVoice: "Join a voice channel first, then run /dero join.",
		channelNotAllowed: "Dero is not allowed to join that voice channel. An admin can add it with /dero-config voicechannel add.",
		botLacksPermission: "Dero needs permission to see, connect and speak in that voice channel.",
		alreadyHere: (channelId: string): string => `Dero is already in <#${channelId}>.`,
		alreadyElsewhere: (channelId: string): string =>
			`Dero is already in <#${channelId}> in this server. Run /dero leave first.`,
		joinCooldown: (seconds: number): string => `Give Dero a moment. Try /dero join again in ${seconds}s.`,
		connectFailed: (channelId: string): string =>
			`Dero could not connect to <#${channelId}>, so Dero is not in the call. Try again in a moment.`,
		notInCall: "Dero is not in a voice call in this server.",
		left: (channelId: string): string => `Dero left <#${channelId}>.`,

		// The private reply to whoever ran /dero join, one per greeting outcome,
		// so a silent Dero always says why it is silent.
		joined: {
			greeted: (channelId: string): string => `Dero joined <#${channelId}> and said hello.`,
			capReached: (channelId: string): string =>
				`Dero joined <#${channelId}> but stays quiet: this server's voice budget for the month is used up.`,
			providerTrouble: (channelId: string): string =>
				`Dero joined <#${channelId}> but could not find his voice just now, so Dero is in the call in silence.`,
			// The speaker could not start the clip (an audio encoder fault), which is
			// a bot problem rather than a budget or provider one.
			playbackFailed: (channelId: string): string =>
				`Dero joined <#${channelId}> but could not play sound in the call, so Dero is there in silence.`,
		},

		// The public line in the channel /dero join ran in. PRIVACY BY CONSTRUCTION:
		// Dero joins deafened in this phase, and the notice says so in plain words
		// before Dero makes a sound.
		joinNotice: (channelId: string): string =>
			`🔊 Dero joined <#${channelId}>. Dero can speak in this call but does not listen yet: nothing anyone says there is heard, recorded or transcribed. An allowed member can send Dero away with /dero leave.`,
		// Spoken once per join, in the guild's voice. Rendered once and then
		// replayed from the clip cache, so a rejoin costs nothing.
		greeting: "Hello, I am Dero. I can talk in this call, but I am not listening yet.",

		// Posted in the same channel when a session ends on its own.
		reconnectFailed: (channelId: string, attempts: number): string =>
			`Dero lost the connection to <#${channelId}> and could not get back in after ${attempts} tries, so Dero left the call.`,
		removed: (channelId: string): string => `Dero was removed from <#${channelId}>, so the call has ended.`,
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
