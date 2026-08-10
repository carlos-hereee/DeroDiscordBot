import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type ModalSubmitInteraction,
} from "discord.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import {
	serverApi,
	ServerNotConfiguredError,
	ServerResponseError,
	ServerUnreachableError,
} from "@utils/serverApi.js";

// ── Suggestion Box ─────────────────────────────────────────────────
// Lets any guild member send feedback that lands in the platform
// owner's in-app inbox on Company Uno. Two entry points share the
// same modal + submission handler:
//   - /suggestion-box slash command (any guild member can run)
//   - Button on the #command-center pinned commandGuide message
//
// Modal: single paragraph textarea, 1000 char max. Submission posts
// to /api/suggestion-box on nexious-server (HMAC-signed via
// serverApi). Server creates a Messages doc in the platform owner's
// inbox via the isPlatformOwner: true lookup.
//
// Why a persistent registered modal handler instead of inline
// awaitModalSubmit: both entry points (slash command + button) need
// to show the same modal AND have submissions handled identically.
// Registering once means each entry point just calls
// interaction.showModal(buildSuggestionModal()) and returns; the
// submission flows through handleModalSubmit regardless of which
// surface opened it. Inline collectors would duplicate the
// submission logic across both entry points.

// customId conventions. Prefix-based dispatch slices on the first
// ":", so adding more controls under the same prefix later does not
// collide with handler routing.
const BUTTON_PREFIX = "suggestion_box";
const OPEN_BUTTON_ID = `${BUTTON_PREFIX}:open`;
const MODAL_PREFIX = "suggestion_box_modal";
const MODAL_ID = `${MODAL_PREFIX}:submit`;
const TEXT_INPUT_ID = "suggestion_text";

// Compose the modal users see when they invoke either entry point.
// Single required paragraph input, 1000-char ceiling matches the
// Discord modal limit and gives users room without inviting essays.
export function buildSuggestionModal(): ModalBuilder {
	const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle("Suggestion Box");

	const textInput = new TextInputBuilder()
		.setCustomId(TEXT_INPUT_ID)
		.setLabel("Your suggestion or request")
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(true)
		.setMaxLength(1000)
		.setPlaceholder("What would you like to share with the Company Uno team?");

	const row = new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);
	modal.addComponents(row);
	return modal;
}

// The "Suggestion Box" button that opens the feedback modal. Exported as a bare
// ButtonBuilder (not a row) so resolveIntroComponents can pack it into the same
// #command-center guide row as the member controls + invite button. ButtonStyle.Primary
// (blurple) reads as the main action without alarm framing; Success (green) would
// imply a successful state, which the button does not represent.
export function buildSuggestionBoxButton(): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(OPEN_BUTTON_ID)
		.setLabel("Suggestion Box")
		.setEmoji("💡")
		.setStyle(ButtonStyle.Primary);
}

// Button handler: just shows the modal. No permission gate because
// the suggestion box is open to all guild members, friction defeats
// the purpose of feedback collection.
async function handleOpenButton(interaction: ButtonInteraction): Promise<void> {
	await interaction.showModal(buildSuggestionModal());
}

// Modal submission handler: pull the text, gather guild + user
// context, post to server, ack with ephemeral confirmation. Errors
// are mapped to a single user-facing "could not send" message; the
// underlying typed error is logged for diagnostics.
async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
	const text = interaction.fields.getTextInputValue(TEXT_INPUT_ID).trim();
	if (!text) {
		await interaction.reply({
			embeds: [errorEmbed("Suggestion cannot be empty.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const guild = interaction.guild;
	if (!guild) {
		// Defensive: Discord scopes the slash command to guilds so
		// guild is normally populated. Empty branch covers any cache
		// race or DM path so users get a clear "must be in a server"
		// message instead of a generic error.
		await interaction.reply({
			embeds: [errorEmbed("This must be used inside a server, not a DM.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Defer with an ephemeral flag so the spinner is private to the
	// submitter. Network round trip to Heroku can take 200ms to 2s;
	// deferring gives us the full 15-min interaction window if the
	// platform is slow, and avoids a visible "this app is thinking"
	// state for nearby members in the channel.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const payload = {
		text,
		guildName: guild.name,
		guildId: guild.id,
		discordHandle: interaction.user.username,
	};

	try {
		await serverApi.post("/api/suggestion-box", payload);
		await interaction.editReply({
			content: "✅ Thank you for taking the time to write to us. Every note shapes what comes next.",
		});
	} catch (err) {
		// Log the typed error for operator diagnostics but show the
		// user a single friendly message. We do not surface server
		// internals (5xx body, signing details, etc) to the user.
		if (err instanceof ServerNotConfiguredError) {
			console.error("[suggestion-box] server not configured", err);
		} else if (err instanceof ServerUnreachableError) {
			console.warn("[suggestion-box] server unreachable", err);
		} else if (err instanceof ServerResponseError) {
			console.warn(`[suggestion-box] server returned ${err.status}`, err.body);
		} else {
			console.error("[suggestion-box] unknown error", err);
		}
		await interaction.editReply({
			embeds: [errorEmbed("Could not send your suggestion right now. Please try again later.")],
		});
	}
}

// Register the persistent button + modal handlers. Called once at
// boot from main.ts before the InteractionCreate listener installs.
// Both entry points (slash command + button) converge on the same
// modal handler via the MODAL_PREFIX registration.
export function registerSuggestionBoxHandlers(): void {
	registerButton(BUTTON_PREFIX, handleOpenButton);
	registerModal(MODAL_PREFIX, handleModalSubmit);
}
