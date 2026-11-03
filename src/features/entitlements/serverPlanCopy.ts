import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── Dero server plan copy ──
// What:  the one written sentence that tells an UNCOVERED server about the Dero server plan
//        (2026-10 item 262), and the line /dero plan shows a covered one. Platform copy, not
//        pack copy: like gameRoomUpgradeEmbed, a plan notice reads the same in every template.
// Who:   the voice budget refusals (voiceCopy, deroBrainCopy), the private room limit
//        (gameRoomsCopy) and /dero plan. One helper, so every surface names the plan and its
//        link the same way.
// Not:   a spoken line. Speech never reads a link aloud, so the spoken budget line names the
//        plan in its own words (voiceCopy.turn.spoken).
//
// House rule: no dashes in user facing copy.

/** The written plan line with its link, for a server that is not covered. */
export const serverPlanLine = (): string =>
	`The Dero server plan gives this server a bigger voice budget and more private game rooms: ${BOT_CONSTANTS.DERO_SERVER_PLAN_URL}`;

// ── /dero plan, the server owner's private reply ──
export const serverPlanCommandCopy = {
	title: "🔑 Your server code",
	notInGuild: "Run /dero plan inside your Discord server.",
	ownerOnly: "Only this server's owner can get its code.",
	// The code is one time and replaces any older code for the server, which includes the
	// code Dero sent when it joined, so the owner is told to use the newest one (risk R16).
	code: (code: string, minutes: number): string =>
		[
			`**\`${code}\`**`,
			`It expires in ${minutes} minutes and replaces any older code for this server, so use the newest one.`,
			"Enter it on the Company Uno pricing page, or in the Company Uno dashboard's \"Connect your Discord server\" panel.",
		].join("\n\n"),
	covered: "This server already has the bigger voice budget and more private game rooms.",
	failed: "Dero could not make a code just now. Try /dero plan again in a moment.",
};
