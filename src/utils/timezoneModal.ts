import { LabelBuilder, ModalBuilder, StringSelectMenuBuilder, TextDisplayBuilder } from "discord.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { TIMEZONE_OPTIONS } from "@utils/tzParser.js";

// ── timezoneModal ───────────────────────────────────────────────────────────
// What:  the one timezone modal, a single select of the shared 25 zones (tzParser's
//        TIMEZONE_OPTIONS), and the check of what its Submit picked (2026-11 item 388, owner
//        decision D26). "server" is the server's timezone step in 🛠️server-config; "member"
//        is a member setting their own zone for todos and reminders.
// Who:   features/setup/headquartersSteps.ts (target "server"), and from Phase 2 the
//        member timezone button and /remind timezone (target "member").
// Does NOT: gate who may open it or store the pick. The caller does both, because the server
//        step needs an owner or admin and the member pick needs nobody.

/** Whose zone the modal sets. */
export type TimezoneModalTarget = "server" | "member";

// The modal customIds, one per target. The server id is `${HEADQUARTERS_STEP_PREFIX}timezone`
// (features/setup/headquartersCards.ts), written out because a util imports no feature;
// timezoneModal.test.ts pins the two equal. "mtz" is the member prefix the plan reserves.
export const TIMEZONE_MODAL_IDS: Readonly<Record<TimezoneModalTarget, string>> = {
	server: "hqsteptimezone",
	member: "mtz:set",
};

/** The select's customId inside the modal, read back on Submit. The same for both targets. */
export const TIMEZONE_FIELD_ID = "timezone";

/**
 * The modal, with `currentZone` picked already. The words come from the pack's
 * timezoneModal block for the target; `copyConfig` picks the pack, the default one when unset.
 */
export function buildTimezoneModal(currentZone: string, target: TimezoneModalTarget = "server", copyConfig: ICopyConfig | null = null): ModalBuilder {
	const words = getPluginCopy(copyConfig).timezoneModal[target];
	const select = new StringSelectMenuBuilder()
		.setCustomId(TIMEZONE_FIELD_ID)
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(TIMEZONE_OPTIONS.map((option) => ({ label: option.label, value: option.value, description: option.description, default: option.value === currentZone })));
	return new ModalBuilder()
		.setCustomId(TIMEZONE_MODAL_IDS[target])
		.setTitle(words.title)
		.addTextDisplayComponents(new TextDisplayBuilder().setContent(words.intro))
		.addLabelComponents(new LabelBuilder().setLabel(words.selectLabel).setStringSelectMenuComponent(select));
}

/**
 * The zone a Submit picked, or null for one that is not on the list. The select only
 * offers the list, but a crafted Submit can carry any string, and this value goes
 * straight into every scheduler's time math.
 */
export function pickedTimezone(picked: string | undefined): string | null {
	return TIMEZONE_OPTIONS.some((option) => option.value === picked) ? (picked as string) : null;
}
