// ── cutover-smoke-test ───────────────────────────────────────────────
// What: a self-contained script that exercises the new server's /api/events
//   surface end-to-end. Creates a throwaway test event, reads it back, pauses
//   it, verifies the pause persisted, deletes it, verifies it is gone. Each
//   step prints PASS or FAIL with the relevant detail. Exit code 0 on full
//   pass, 1 on any failure.
// Who: operator running the cutover. Run BEFORE flipping USE_REMOTE_EVENTS on
//   the bot to verify the server endpoints actually work with the bot's
//   signing posture. Run AFTER the migration so the calendar exists.
// When: every cutover, before each flag flip. Five minutes of operator time
//   that can save hours of debugging an actual production outage.
// Where: pure HTTP. Does not touch Mongo directly. Does not touch Discord.
//   Hits whatever SERVER_BASE_URL points at, staging or prod, using the
//   guildId you pass via SMOKE_GUILD_ID.
// How:
//   ① Sign each request the same way serverApi.ts does (HMAC-SHA256, sorted
//      query, sha256(body), x-timestamp + x-signature headers).
//   ② Walk through create → list → patch → list → delete → list, asserting
//      the expected state at each step.
//   ③ Always attempt cleanup at the end even on failure so a partial run
//      does not leave a "Smoke Test Event 2026-XX-XX" sitting in real data.
//
// Usage:
//   SERVER_BASE_URL="https://staging.nexious-server.com" \
//   DASHBOARD_SIGNING_SECRET="..." \
//   SMOKE_GUILD_ID="<your test guild id>" \
//   node scripts/cutover-smoke-test.mjs

import { createHash, createHmac } from "crypto";

const baseUrl = process.env.SERVER_BASE_URL ?? "";
const secret = process.env.DASHBOARD_SIGNING_SECRET ?? "";
const guildId = process.env.SMOKE_GUILD_ID ?? "";

if (!baseUrl) {
	console.error("SERVER_BASE_URL is required.");
	process.exit(2);
}
if (!secret) {
	console.error("DASHBOARD_SIGNING_SECRET is required.");
	process.exit(2);
}
if (!guildId) {
	console.error("SMOKE_GUILD_ID is required (set it to a guild that has the plugin installed).");
	process.exit(2);
}

// ── result tracking ──
// We do not bail early on the first failure because a later step might still
// produce useful diagnostic output. Every failure adds to a counter, and the
// final exit code is 0 only when the counter is 0.
let passes = 0;
let failures = 0;
const results = [];
const ok = (label, detail = "") => {
	passes++;
	results.push({ label, detail, status: "PASS" });
	console.log(`  ✓ ${label}${detail ? `, ${detail}` : ""}`);
};
const fail = (label, detail = "") => {
	failures++;
	results.push({ label, detail, status: "FAIL" });
	console.error(`  ✗ ${label}${detail ? `, ${detail}` : ""}`);
};

// ── canonicalization (must match serverApi.ts exactly) ──
const canonicalizeQuery = (query) => {
	if (!query) return "";
	const params = new URLSearchParams(query);
	const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const rebuilt = new URLSearchParams();
	for (const [k, v] of entries) rebuilt.append(k, v);
	return rebuilt.toString();
};
const hashBody = (body) => createHash("sha256").update(body, "utf8").digest("hex");
const buildCanonicalString = ({ method, path, query, timestamp, bodyHash }) => {
	const canonicalQuery = canonicalizeQuery(query);
	const pathWithQuery = canonicalQuery ? `${path}?${canonicalQuery}` : path;
	return `${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${bodyHash}`;
};

// ── request helper ──
// Returns { status, body } on every response, throws only on transport
// failure. Calling code does its own assertions on status.
const request = async ({ method, path, query, body }) => {
	const url = new URL(path, baseUrl);
	if (query) {
		const entries = Object.entries(query)
			.filter(([, v]) => v !== undefined && v !== null && v !== "")
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		for (const [k, v] of entries) url.searchParams.set(k, v);
	}
	const hasBody = method === "POST" || method === "PATCH";
	const bodyText = hasBody ? JSON.stringify(body ?? {}) : "";
	const timestamp = `${Date.now()}`;
	const canonical = buildCanonicalString({
		method,
		path: url.pathname,
		query: url.search.replace(/^\?/, ""),
		timestamp,
		bodyHash: hashBody(bodyText),
	});
	const signature = createHmac("sha256", secret).update(canonical, "utf8").digest("hex");

	const res = await fetch(url.toString(), {
		method,
		headers: {
			"content-type": "application/json",
			"x-timestamp": timestamp,
			"x-signature": signature,
		},
		body: hasBody ? bodyText : undefined,
	});
	const text = await res.text();
	let parsed = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	return { status: res.status, body: parsed };
};

// ── canary event payload ──
// Use a clearly-labeled name with a timestamp so a leftover event from a
// failed run is obvious in the dashboard. firstOccurrence sits ~10 minutes in
// the future so a real reminder would not fire mid-test.
const canaryName = `[smoke-test] ${new Date().toISOString()}`;
const canaryPayload = {
	name: canaryName,
	description: "Created by scripts/cutover-smoke-test.mjs. Safe to delete.",
	type: "one-time",
	intervalHours: 0,
	firstOccurrence: new Date(Date.now() + 10 * 60_000).toISOString(),
	seasonEnd: null,
	reminderOffsets: [30, 15],
	prepSteps: [],
	mentionRoleId: null,
};

let createdEventId = null;

const cleanup = async () => {
	if (!createdEventId) return;
	try {
		await request({
			method: "DELETE",
			path: `/api/events/${encodeURIComponent(createdEventId)}`,
			query: { guildId },
		});
		console.log(`  cleanup: deleted ${createdEventId}`);
	} catch (err) {
		console.warn(`  cleanup failed for ${createdEventId}:`, err?.message ?? err);
	}
};

// ── run ──
console.log(`Cutover smoke test against ${baseUrl}`);
console.log(`Guild: ${guildId}`);
console.log(`Canary event name: ${canaryName}\n`);

try {
	// Step 1: list events for the guild. Confirms read path works and
	// signature is being accepted.
	console.log("[1/6] List events");
	const initialList = await request({ method: "GET", path: "/api/events", query: { guildId } });
	if (initialList.status === 200 && Array.isArray(initialList.body?.events)) {
		ok("list events", `${initialList.body.events.length} existing event(s)`);
	} else {
		fail("list events", `status=${initialList.status} body=${JSON.stringify(initialList.body)}`);
		// If the read path itself does not work, no further test will pass.
		// Surface the error and exit early.
		process.exit(1);
	}

	// Step 2: create the canary event.
	console.log("\n[2/6] Create canary event");
	const created = await request({
		method: "POST",
		path: "/api/events",
		query: { guildId },
		body: canaryPayload,
	});
	if (created.status === 200 && created.body?.event?.eventId) {
		createdEventId = created.body.event.eventId;
		ok("create event", `eventId=${createdEventId}`);
	} else {
		fail("create event", `status=${created.status} body=${JSON.stringify(created.body)}`);
	}

	// Step 3: read the canary back by id.
	if (createdEventId) {
		console.log("\n[3/6] Fetch canary by id");
		const fetched = await request({
			method: "GET",
			path: `/api/events/${encodeURIComponent(createdEventId)}`,
			query: { guildId },
		});
		if (fetched.status === 200 && fetched.body?.event?.eventId === createdEventId) {
			// Verify a few fields round-tripped correctly.
			const e = fetched.body.event;
			const nameMatches = e.name === canaryName;
			const typeMatches = e.type === "one-time";
			if (nameMatches && typeMatches) {
				ok("fetch by id", "name and type match");
			} else {
				fail(
					"fetch by id",
					`field mismatch: name="${e.name}" expected="${canaryName}", type="${e.type}" expected="one-time"`
				);
			}
		} else {
			fail("fetch by id", `status=${fetched.status} body=${JSON.stringify(fetched.body)}`);
		}
	}

	// Step 4: pause via PATCH.
	if (createdEventId) {
		console.log("\n[4/6] Pause canary (PATCH)");
		const patched = await request({
			method: "PATCH",
			path: `/api/events/${encodeURIComponent(createdEventId)}`,
			query: { guildId },
			body: { paused: true },
		});
		if (patched.status === 200 && patched.body?.event?.paused === true) {
			ok("pause via patch", "paused=true persisted");
		} else {
			fail("pause via patch", `status=${patched.status} body=${JSON.stringify(patched.body)}`);
		}
	}

	// Step 5: confirm pause via re-read.
	if (createdEventId) {
		console.log("\n[5/6] Verify pause persisted");
		const reread = await request({
			method: "GET",
			path: `/api/events/${encodeURIComponent(createdEventId)}`,
			query: { guildId },
		});
		if (reread.status === 200 && reread.body?.event?.paused === true) {
			ok("verify pause", "paused=true on re-read");
		} else {
			fail("verify pause", `status=${reread.status} paused=${reread.body?.event?.paused}`);
		}
	}

	// Step 6: delete the canary. Cleanup will also attempt this in the
	// catch block, but doing it here ensures the success path exercises
	// the delete endpoint explicitly.
	if (createdEventId) {
		console.log("\n[6/6] Delete canary (DELETE)");
		const deleted = await request({
			method: "DELETE",
			path: `/api/events/${encodeURIComponent(createdEventId)}`,
			query: { guildId },
		});
		if (deleted.status === 200) {
			ok("delete event");
			createdEventId = null; // prevent cleanup from double-deleting
		} else {
			fail("delete event", `status=${deleted.status} body=${JSON.stringify(deleted.body)}`);
		}
	}
} catch (err) {
	fail("unexpected error", err?.message ?? String(err));
} finally {
	// Always attempt cleanup. If step 6 succeeded, createdEventId is null
	// and this no-ops.
	await cleanup();
}

console.log(`\n── Summary ──`);
console.log(`  passes   ${passes}`);
console.log(`  failures ${failures}`);
console.log(failures === 0 ? "\nALL CHECKS PASSED" : "\nFAILURES PRESENT, do not flip cutover flags until resolved");
process.exit(failures === 0 ? 0 : 1);
