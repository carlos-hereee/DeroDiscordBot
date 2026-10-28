// ── the admin command button prefix ──────────────────────────────────────────
// What:  the customId prefix of an admin command button, `admincmd:<launch id>`, which
//        adminCommandLauncher answers. The admin guide that carried one button per
//        admin command retired with 🎛️admin-controls (2026-10 item 263 Phase 4a): each
//        command now opens from a step on its 🏰 DERO HEADQUARTERS channel's card. The
//        prefix stays so the launcher's own picks and forms keep their customIds, and a
//        guide still standing on a server the boot sweep has not reached keeps working.
// Why a separate module: this one imports no command. The launcher imports every
//        admin command module, and setup sits under several of them, so the prefix
//        lives here to keep that import cycle closed.

/** The customId prefix every admin command button carries: `admincmd:<launch id>`. */
export const ADMIN_COMMAND_BUTTON_PREFIX = "admincmd";
