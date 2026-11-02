import { DiscordAPIError, RESTJSONErrorCodes, type Client, type MessageCreateOptions } from "discord.js";

// ── Dero's direct message dispatcher (2026-11 item 283 Phase 4) ──
// What:  sends one DM to one Discord user by id and says how it went, without throwing.
// Who:   the Creator Lab analysis DM (api/routes/creatorLab.routes.ts) today, and Creator Lab's
//        weekly tips (Phase 5) next. The outage watcher and the weekly digest DM through their own
//        older code; they are left as they are rather than moved here in this change.
// Why:   a DM can fail for a reason that is the user's choice (DMs closed, or they share no server
//        with Dero any more), which the caller reports differently from an outage. Discord answers
//        that with error 50007; an unknown user is 10013.
// Never: logs the message, which can carry a creator's analysis.

export type DirectMessageOutcome = "sent" | "closed" | "failed";

const CLOSED_CODES = new Set<number>([RESTJSONErrorCodes.CannotSendMessagesToThisUser, RESTJSONErrorCodes.UnknownUser]);

export async function sendDirectMessage(client: Client, userId: string, message: MessageCreateOptions): Promise<DirectMessageOutcome> {
	try {
		const user = await client.users.fetch(userId);
		await user.send(message);
		return "sent";
	}
	catch (error) {
		if (error instanceof DiscordAPIError && typeof error.code === "number" && CLOSED_CODES.has(error.code)) return "closed";
		console.warn("[directMessage] a DM could not be sent", error instanceof Error ? error.name : "unknown");
		return "failed";
	}
}
