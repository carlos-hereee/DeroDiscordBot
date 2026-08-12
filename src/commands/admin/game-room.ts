import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	PermissionFlagsBits,
	MessageFlags,
	ChannelType,
	type CategoryChannel,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { RoomProvisioner, describeRoomOpenFailure } from "@features/game-rooms/RoomProvisioner.js";
import { roomLifecycle } from "@features/game-rooms/roomLifecycle.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { GAME_SLUGS, type GameSlug, type RoomVisibility } from "@features/game-rooms/roomTypes.js";

// ── /game-room ────────────────────────────────────────────────────────
// ⚠️⚠️ TEMPORARY. DELETE THIS ENTIRE FILE IN PHASE 4. ⚠️⚠️
//
// What:  a bare open/close harness for a game room, so Phase 3 is testable in a real
//        guild before the challenge board that will actually drive rooms exists.
// Who:   the server owner, and nobody else. See the gate below for why it is stricter
//        than every other admin command in this folder.
// When:  only while Phase 4 is unbuilt. The moment ⚔️challenges can open a room, this
//        command is dead weight that also happens to be a way to make rooms out of
//        band, so its deletion is a Phase 4 task and not a cleanup someone might skip.
// Where: it deliberately reuses RoomProvisioner and roomLifecycle rather than doing
//        anything of its own. A debug path that built rooms its own way would prove
//        the debug path works and nothing else.
// How:   `open` provisions a room with the invoker as the only player; `close`
//        finishes whichever room the invoker is hosting.

export const data = new SlashCommandBuilder()
	.setName("game-room")
	.setDescription("Temporary: open or close a game room for testing (server owner only)")
	// Hides it from a non-admin's command picker. The runtime gate below is the one
	// that actually enforces, because a picker flag is a hint, not a boundary.
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
	.addSubcommand((sub) =>
		sub
			.setName("open")
			.setDescription("Open a test room")
			.addStringOption((option) =>
				option
					.setName("game")
					.setDescription("Which game the room is for")
					.setRequired(true)
					.addChoices(...GAME_SLUGS.map((slug) => ({ name: gameRoomsCopy.gameLabel(slug), value: slug })))
			)
			.addStringOption((option) =>
				option
					.setName("visibility")
					.setDescription("Invite only, or open for the whole server to watch")
					.setRequired(true)
					.addChoices({ name: "Invite only", value: "invite" }, { name: "Public", value: "public" })
			)
			.addUserOption((option) => option.setName("opponent").setDescription("A second player to add to the room"))
	)
	.addSubcommand((sub) => sub.setName("close").setDescription("Finish the room you are hosting"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) {
		await interaction.reply({ embeds: [errorEmbed("Run this in a server, not a DM.")], flags: MessageFlags.Ephemeral });
		return;
	}

	// ⚠️ OWNER STRICT, deliberately stricter than the Administrator flag on the builder
	// and stricter than every other command in this folder. This is an unfinished
	// feature's debug hatch: it creates real channels, and until Phase 4 there is no
	// board, no cap on who may press what, and no product reason for anyone but the
	// person testing it to reach it.
	if (interaction.user.id !== interaction.guild.ownerId) {
		await interaction.reply({
			embeds: [errorEmbed("This is a temporary testing command, limited to the server owner.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config) {
		await interaction.reply({
			embeds: [errorEmbed("This server has not been set up yet. Run /setup first.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (interaction.options.getSubcommand() === "close") {
		await closeRoom(interaction, guildId);
		return;
	}

	await openRoom(interaction, guildId, config as unknown as { gamesCategoryId?: string | null; adminRoleId?: string | null });
}

async function openRoom(
	interaction: ChatInputCommandInteraction,
	guildId: string,
	config: { gamesCategoryId?: string | null; adminRoleId?: string | null }
): Promise<void> {
	// Deferred because the provisioner creates a channel and posts into it, which is
	// comfortably past Discord's 3 second initial-response budget.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const categoryId = config.gamesCategoryId;
	const category = categoryId ? await interaction.guild!.channels.fetch(categoryId).catch(() => null) : null;
	if (!category || category.type !== ChannelType.GuildCategory) {
		await interaction.editReply({ embeds: [errorEmbed(gameRoomsCopy.errors.noArcadeCategory)] });
		return;
	}

	const opponent = interaction.options.getUser("opponent");
	const result = await RoomProvisioner.open({
		guild: interaction.guild!,
		category: category as CategoryChannel,
		game: interaction.options.getString("game", true) as GameSlug,
		hostId: interaction.user.id,
		hostDisplayName: interaction.user.globalName ?? interaction.user.username,
		playerIds: opponent ? [interaction.user.id, opponent.id] : [interaction.user.id],
		visibility: interaction.options.getString("visibility", true) as RoomVisibility,
		adminRoleId: config.adminRoleId ?? null,
	});

	if (!result.ok) {
		await interaction.editReply({ embeds: [errorEmbed(describeRoomOpenFailure(result))] });
		return;
	}

	await interaction.editReply({
		embeds: [infoEmbed("Room open", `Your test room is ready: <#${result.channel.id}>`, COLORS.ARCADE)],
	});
}

async function closeRoom(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	// findOpenByHost is the same query F11 leans on, so "the room you are hosting" here
	// means exactly what it means everywhere else in the feature.
	const room = await gameRoomStore.findOpenByHost(guildId, interaction.user.id);
	if (!room) {
		await interaction.editReply({ embeds: [errorEmbed("You are not hosting a room right now.")] });
		return;
	}

	await roomLifecycle.finish(interaction.client, room, { winnerId: null });
	await interaction.editReply({
		embeds: [infoEmbed("Room closed", "The room is locked and will archive on schedule.", COLORS.ARCADE)],
	});
}

export default { data, execute };
