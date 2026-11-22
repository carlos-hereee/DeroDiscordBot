import { DiscordAPIError, RESTJSONErrorCodes, type Client, type MessageCreateOptions, type MessageEditOptions, type SendableChannels } from "discord.js";

// ── cardMessage ─────────────────────────────────────────────────────────────
// What:  the two channel writes a card drawn from a row needs (2026-11 item 388 Phase 2):
//        keep one message showing the card (edit it, or post it again when it is gone), and
//        post a one off line.
// Who:   features/todos/todoActions.ts (todo cards), features/meetings/scheduledMeetings.ts
//        (scheduled meeting cards) and features/reminders/dueReminders.ts (channel reminders).
// Does NOT: store the message id. The caller writes what syncCardMessage returns onto its row,
//        because only the caller knows which row the card belongs to.

/** A card's message content: embeds, buttons and the mention rules, valid to send or edit. */
export type CardPayload = Pick<MessageCreateOptions, "embeds" | "components" | "allowedMentions" | "content">;

async function sendableChannel(client: Client, channelId: string): Promise<SendableChannels | null> {
	const channel = await client.channels.fetch(channelId).catch(() => null);
	return channel && channel.isSendable() ? channel : null;
}

// Only Unknown Message means the card is gone and may be posted again; any other refusal (a
// lost permission, an outage) leaves the stored id alone, or one hiccup would duplicate a card.
function isMessageGone(error: unknown): boolean {
	return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage;
}

/**
 * Show `payload` in `channelId`: edit `messageId` in place, or post it when there is no id or
 * the message was deleted. Answers the id now holding the card (unchanged when edited), or
 * null when the channel cannot be reached or the edit was refused for another reason.
 */
export async function syncCardMessage(client: Client, channelId: string, messageId: string | null, payload: CardPayload): Promise<string | null> {
	const channel = await sendableChannel(client, channelId);
	if (!channel) return null;
	if (messageId) {
		try {
			const message = await channel.messages.fetch(messageId);
			await message.edit(payload as MessageEditOptions);
			return messageId;
		} catch (error) {
			if (!isMessageGone(error)) return null;
		}
	}
	const posted = await channel.send(payload).catch(() => null);
	return posted?.id ?? null;
}

/**
 * Edit a card's message in place and never post it again: for a last face (a meeting removed
 * from the dashboard) that is pointless once the message is gone. True when the edit landed.
 */
export async function editCardMessage(client: Client, channelId: string, messageId: string, payload: CardPayload): Promise<boolean> {
	const channel = await sendableChannel(client, channelId);
	if (!channel) return false;
	const message = await channel.messages.fetch(messageId).catch(() => null);
	if (!message) return false;
	return (await message.edit(payload as MessageEditOptions).catch(() => null)) !== null;
}

/** Delete a card's message, quietly: a message already gone is the outcome wanted. */
export async function deleteCardMessage(client: Client, channelId: string, messageId: string): Promise<void> {
	const channel = await sendableChannel(client, channelId);
	if (!channel) return;
	await channel.messages.delete(messageId).catch(() => undefined);
}

/** Post one line in a channel. True when Discord took it. */
export async function postInChannel(client: Client, channelId: string, payload: CardPayload): Promise<boolean> {
	const channel = await sendableChannel(client, channelId);
	if (!channel) return false;
	return (await channel.send(payload).catch(() => null)) !== null;
}
