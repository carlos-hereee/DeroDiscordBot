import { IPlayerActivity } from "./activity.types.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// pure function, takes an activity record, returns a score
// no DB calls, easy to unit test and tweak weights
export function computeScore(activity: Partial<IPlayerActivity>): number {
	const w = BOT_CONSTANTS.SCORE_WEIGHTS;
	let score = 0;

	if (activity.acknowledgedReminder) score += w.ACKNOWLEDGED_REMINDER;
	if (activity.wasOnlineAtStart) score += w.WAS_ONLINE_AT_START;
	if (activity.joinedVoiceDuring) score += w.JOINED_VOICE;

	// voice minutes capped so players cant inflate score by idling
	const voiceBonus = Math.min((activity.voiceMinutes ?? 0) * w.VOICE_MINUTE_BONUS, w.MAX_VOICE_BONUS);
	score += voiceBonus;

	return score;
}
