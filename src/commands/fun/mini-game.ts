import {
	SlashCommandBuilder,
	MessageFlags,
	type ChatInputCommandInteraction,
	type SlashCommandStringOption,
} from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { gamesCopy } from "@features/games/gamesCopy.js";
import { fortuneCopy } from "@features/fortune/fortuneCopy.js";
import { runCoinFlip, runDiceRoll, runMonopoly, runRps } from "@features/games/challengeEntry.js";
import { runHangman } from "@features/games/hangmanHandler.js";
import { runBlackjack } from "@features/games/blackjackHandler.js";
import { runFortune } from "@features/games/fortuneHandler.js";
import { routeMiniGameInChallenges } from "@features/games/miniGameInChallenges.js";

// ── /mini-game ─────────────────────────────────────────────────────────────
// The single home for every Dero game. Four games ship as native Discord
// SUBCOMMANDS of one command rather than four separate slash commands, because
// four fun commands crowd a member's picker and bury the bot's real work.
// Typing /mini-game makes Discord's own picker render the game menu, with each
// game's description and its own typed options, at zero cost in bot code.
//
// Open to every member: deliberately NOT in BOT_CONSTANTS.ADMIN_COMMANDS and
// NOT in EARLY_ACCESS_FEATURES. Both of those gates key on
// interaction.commandName alone, which for any subcommand here resolves to the
// bare "mini-game", so listing this command would gate all four games at once,
// including fortune, which is already generally available to everyone. Gating
// one game would first need a composite `mini-game <subcommand>` gate key. Do
// not add this command to either set.
//
// /secret-code is deliberately NOT part of this command. Redeeming a code is a
// persistent account action that happens to buff the fortune subcommand, not a
// game, so it stays its own top level command at src/commands/fun/secret-code.ts.

// The `against` choice the three luck games share. Optional, defaulting to a member,
// so /mini-game coin-flip with nothing else still opens a challenge as it always did.
const againstOption = (option: SlashCommandStringOption): SlashCommandStringOption =>
	option
		.setName("against")
		.setDescription(gamesCopy.soloLuck.againstOptionDescription)
		.setRequired(false)
		.addChoices(
			{ name: gamesCopy.soloLuck.againstMemberLabel, value: "member" },
			{ name: gamesCopy.soloLuck.againstDeroLabel, value: "dero" }
		);

// ── the command builder ────────────────────────────────────────────────────
// `data` is deliberately UNANNOTATED. Calling .addSubcommand() narrows the
// builder's type away from SlashCommandBuilder, so an explicit
// `: SlashCommandBuilder` annotation would not compile. Every command file in
// this repo already relies on inference for the same reason (the old fortune.ts
// narrows via .addStringOption()), and both loaders (main.ts' boot loop and
// deploy-commands.ts) only check that the string keys "data" and "execute"
// exist, so ICommand is documentary rather than enforced. If you are here to
// "fix" this: widen ICommand's data field to a union that admits the narrowed
// builder types. Never cast to any, and never cast to SlashCommandBuilder.
//
// The parent carries NO options of its own, because Discord forbids a command
// from holding both subcommands and top level options (and makes its bare form
// uninvokable). Every option below therefore lives inside its own subcommand,
// which is also why there is no shared `private` toggle: that flag belongs to
// fortune alone.
export const data = new SlashCommandBuilder()
	.setName("mini-game")
	.setDescription(gamesCopy.commandDescription)
	// ── the three head to head games ──
	// One subcommand ("duel") until 2026-08-12, with a REQUIRED flip option that
	// made a member choose a rule before they had played once and left the game
	// with a name that described half of it. Two subcommands, no option, no
	// question.
	//
	// ⚠️ NO `opponent` OPTION ON ANY OF THE THREE, as of game rooms Phase 4, and its
	// absence is the point. An addUserOption is populated by DISCORD and will
	// happily return a bot, which is why a bot-opponent rejection string had to exist
	// at all (the phrase is not quoted here on purpose: a grep for it returning
	// nothing is this phase's completion criterion). These three now open a card on
	// ⚔️challenges instead, where the opponent arrives either through a
	// bot-populated StringSelect (which cannot contain a bot) or by pressing Join
	// (which a bot cannot do). The rejection is structural now, so the string is
	// gone. Do NOT add a user option back to any game.
	//
	// The one option they DO carry is `against`, a STRING choice between a member (the
	// default, the challenge board) and Dero (a solo round played inline, the 1.7.0 test
	// fixes, item 14). Dero is offered by the bot as a fixed choice, never picked from a
	// member list, so this is not the user option the note above forbids. ⚠️ HAND KEPT
	// PAIR: the option names and the "dero" value are read in
	// src/features/games/challengeEntry.ts.
	.addSubcommand((sub) =>
		sub.setName("coin-flip").setDescription(gamesCopy.coinFlip.subcommandDescription).addStringOption(againstOption)
	)
	.addSubcommand((sub) =>
		sub.setName("dice-roll").setDescription(gamesCopy.diceRoll.subcommandDescription).addStringOption(againstOption)
	)
	.addSubcommand((sub) =>
		sub
			.setName("rps")
			.setDescription(gamesCopy.rps.subcommandDescription)
			.addStringOption(againstOption)
			// Read only when `against` is Dero; a member's throw against another member is
			// still made in secret inside the room.
			.addStringOption((option) =>
				option
					.setName("throw")
					.setDescription(gamesCopy.soloLuck.throwOptionDescription)
					.setRequired(false)
					.addChoices(
						{ name: gamesCopy.rps.rockLabel, value: "rock" },
						{ name: gamesCopy.rps.paperLabel, value: "paper" },
						{ name: gamesCopy.rps.scissorsLabel, value: "scissors" }
					)
			)
	)
	// Monopoly seats the whole pool (two to six), so like the three above it opens a
	// card on ⚔️challenges and carries no option: who plays is gathered on the card.
	.addSubcommand((sub) => sub.setName("monopoly").setDescription(gamesCopy.monopoly.subcommandDescription))
	.addSubcommand((sub) => sub.setName("hangman").setDescription(gamesCopy.hangman.subcommandDescription))
	.addSubcommand((sub) =>
		sub
			.setName("blackjack")
			.setDescription(gamesCopy.blackjack.subcommandDescription)
			.addStringOption((option) =>
				option
					.setName("mode")
					.setDescription(gamesCopy.blackjack.modeOptionDescription)
					// Optional, defaulting to solo, so the shortest path to a hand is
					// /mini-game blackjack and nothing else. Choices rather than free text
					// so Discord rejects anything else before it reaches the handler.
					.setRequired(false)
					.addChoices(
						{ name: gamesCopy.blackjack.soloChoiceLabel, value: "solo" },
						{ name: gamesCopy.blackjack.tableChoiceLabel, value: "table" }
					)
			)
	)
	.addSubcommand((sub) =>
		sub
			// The absorbed /fortune. Option names, types, requiredness, and the 200
			// character cap are copied verbatim from the shipped command, and the
			// descriptions are READ from fortuneCopy rather than retyped, so the option
			// text cannot drift from it. A member who used the retired /fortune must
			// get an identical experience here.
			.setName("fortune")
			.setDescription(fortuneCopy.commandDescription)
			.addStringOption((option) =>
				option
					.setName("question")
					.setDescription(fortuneCopy.questionOptionDescription)
					.setMaxLength(200)
					.setRequired(false)
			)
			.addBooleanOption((option) =>
				option.setName("private").setDescription(fortuneCopy.privateOptionDescription).setRequired(false)
			)
	);

// ── subcommand dispatch table ──────────────────────────────────────────────
// Mirrors POWERUP_ACTIONS in src/features/power-ups/PowerUps.ts on purpose: a
// reader who knows one knows the other, and adding a fifth game is ONE entry
// here plus one addSubcommand callback above, never a new switch arm and never
// a new slash command. Every handler takes the same signature and reads its own
// options off the interaction, which keeps each game's option contract
// colocated with the game that owns it.
//
// Keys MUST match the subcommand names declared in the builder. mini-game.test.ts
// asserts that both ways round, which is the guard that catches the obvious way
// to break this file while adding a game.
export const MINI_GAME_HANDLERS = {
	"coin-flip": runCoinFlip,
	"dice-roll": runDiceRoll,
	rps: runRps,
	monopoly: runMonopoly,
	hangman: runHangman,
	blackjack: runBlackjack,
	fortune: runFortune,
} as const satisfies Record<string, (interaction: ChatInputCommandInteraction) => Promise<void>>;

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	// Discord validates the subcommand name, the presence of required options,
	// and the flip choice value before this runs, so there is nothing to hand
	// validate here. This function routes and does nothing else: no option
	// reading, no cooldown checks, no embeds, no state maps. Business logic lives
	// in src/features/games/.
	const subcommand = interaction.options.getSubcommand();

	// Nothing is played in a challenge channel (2026-10 item 254, Arcade 1): typed there,
	// a game opens its room and a fortune answers privately. Everywhere else this returns
	// false and the table below runs exactly as before.
	if (await routeMiniGameInChallenges(interaction, subcommand)) return;

	const handler = MINI_GAME_HANDLERS[subcommand as keyof typeof MINI_GAME_HANDLERS] as
		| ((interaction: ChatInputCommandInteraction) => Promise<void>)
		| undefined;

	// Unreachable for a member: Discord will not send a subcommand the builder
	// never declared, and it will not let anyone invoke the bare /mini-game. The
	// only way here is a developer declaring a subcommand above without adding it
	// to the table, so fail LOUDLY rather than returning silently, otherwise that
	// mistake ships as a game that does nothing when clicked.
	if (!handler) {
		console.error(`[mini-game] no handler registered for subcommand '${subcommand}'`);
		await interaction.reply({ embeds: [errorEmbed(gamesCopy.unknownSubcommand)], flags: MessageFlags.Ephemeral });
		return;
	}

	await handler(interaction);
}
