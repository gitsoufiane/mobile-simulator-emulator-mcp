import assert from "node:assert/strict";
import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Live gate for the 0.5.0 tools. Every state change is reverted: locale,
// orientation, lock, accessibility, proxy, snapshot, and call state. It
// touches only system apps (Settings, Safari) and needs one booted iOS
// Simulator plus one running Android Emulator.

interface ListedDevice {
	id: string;
	platform: "ios" | "android";
	state: string;
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [resolve("dist/src/index.js")],
	cwd: process.cwd(),
	stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk: Buffer | string) => {
	if (stderr.length < 200_000) stderr += chunk.toString();
});
const client = new Client({ name: "mobile-mcp-live-extended", version: "1.0.0" });
const passed: string[] = [];
const artifacts = resolve(".live-artifacts");
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function call(
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const result = (await client.callTool({
		name,
		arguments: args,
	})) as CallToolResult;
	if (result.isError)
		throw new Error(`${name} ${JSON.stringify(args)}: ${JSON.stringify(result.content)}`);
	assert.ok(result.structuredContent);
	return result.structuredContent;
}

async function rejects(
	name: string,
	args: Record<string, unknown>,
	pattern: RegExp,
): Promise<void> {
	const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
	assert.equal(result.isError, true, `${name} must fail`);
	assert.match(JSON.stringify(result.content), pattern);
}

async function labels(device: string, query?: string): Promise<string[]> {
	const listed = await call("mobile_list_elements", {
		device,
		...(query ? { query } : {}),
	});
	return (listed.elements as Array<{ label?: string }>).flatMap((entry) =>
		entry.label ? [entry.label] : [],
	);
}

async function waitForLabel(device: string, query: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if ((await labels(device, query)).length) return;
		await pause(500);
	}
	throw new Error(`No element matching "${query}" appeared on ${device}`);
}

/** Scrolls down to a lower row and back up, so later steps see the top. */
async function scrollRoundTrip(
	device: string,
	lower: string,
	top: string,
): Promise<void> {
	const down = await call("mobile_scroll_to_element", { device, query: lower });
	assert.ok((down.swipes as number) >= 1, `${lower} needed at least one swipe`);
	const up = await call("mobile_scroll_to_element", {
		device,
		query: top,
		direction: "up",
	});
	assert.ok((up.swipes as number) >= 1, `${top} needed at least one swipe`);
}

async function record(device: string, name: string): Promise<void> {
	const result = await call("mobile_record_screen", {
		device,
		path: `.live-artifacts/${name}.mp4`,
		durationSeconds: 2,
	});
	assert.ok((result.bytes as number) > 1_000, "recording has content");
	assert.equal((await stat(result.path as string)).size, result.bytes);
	await rejects(
		"mobile_record_screen",
		{ device, path: `.live-artifacts/${name}.mp4`, durationSeconds: 1 },
		/already exists/u,
	);

	// start returns at once, so the agent can act while it records.
	const started = Date.now();
	await call("mobile_record_screen", {
		device,
		action: "start",
		path: `.live-artifacts/${name}-actions.mp4`,
		durationSeconds: 60,
	});
	assert.ok(Date.now() - started < 10_000, "start did not block");
	await call("mobile_press_key", { device, key: "HOME" });
	await pause(2_000);
	const stopped = await call("mobile_record_screen", { device, action: "stop" });
	assert.ok((stopped.bytes as number) > 1_000, "start/stop recording has content");
	assert.equal((await stat(stopped.path as string)).size, stopped.bytes);
}

async function android(device: string): Promise<void> {
	const settings = "com.android.settings";
	await call("mobile_press_key", { device, key: "HOME" });
	// Start from the Settings main page, not a subpage left by an earlier run.
	await call("mobile_terminate_app", { device, appId: settings });

	await call("mobile_launch_app", { device, appId: settings, locale: "fr-FR" });
	await waitForLabel(device, "Réseau");
	await call("mobile_launch_app", {
		device,
		appId: settings,
		locale: "system",
		extras: { mobile_mcp_live: "1" },
	});
	await waitForLabel(device, "Network");
	passed.push("android launch locale fr-FR -> system, intent extras");

	const tapped = await call("mobile_tap_element", { device, query: "Network" });
	assert.match(String((tapped.element as { label?: string }).label), /Network/u);
	await waitForLabel(device, "Internet");
	await call("mobile_wait_for_element", { device, query: "Connected devices", state: "gone" });
	await call("mobile_press_key", { device, key: "BACK" });
	passed.push("android tap_element Network & internet, wait_for_element gone");

	await scrollRoundTrip(device, "About", "Network");
	passed.push("android scroll_to_element About -> Network");

	await call("mobile_tap_element", { device, query: "Search" });
	await pause(1_000);
	await call("mobile_type_text", { device, text: "wifi" });
	const keyboard = await call("mobile_dismiss_keyboard", { device });
	assert.equal(keyboard.dismissed, true, "keyboard was shown and dismissed");
	await call("mobile_press_key", { device, key: "BACK" });
	passed.push("android dismiss_keyboard after typing");

	try {
		await call("mobile_set_orientation", { device, orientation: "landscape" });
		await pause(1_500);
		const screen = await call("mobile_get_screen_info", { device });
		assert.ok((screen.width as number) > (screen.height as number), "landscape size");
		assert.equal(screen.orientation, "landscape");
		// Before the rotation fix, x beyond the portrait width was rejected.
		await call("mobile_tap", { device, x: (screen.width as number) - 200, y: 5 });
		passed.push(`android orientation landscape ${String(screen.width)}x${String(screen.height)} + wide tap`);
	} finally {
		await call("mobile_set_orientation", { device, orientation: "auto" });
	}

	const center = await call("mobile_get_screen_info", { device });
	await call("mobile_double_tap", {
		device,
		x: Math.floor((center.width as number) / 2),
		y: 5,
	});
	passed.push("android double_tap");

	await call("mobile_terminate_app", { device, appId: settings });
	await call("mobile_press_key", { device, key: "HOME" });

	try {
		assert.equal((await call("mobile_set_lock", { device, locked: true })).locked, true);
	} finally {
		assert.equal((await call("mobile_set_lock", { device, locked: false })).locked, false);
	}
	passed.push("android set_lock true -> false");

	await record(device, "android");
	passed.push("android record_screen 2s, start -> HOME -> stop");

	const crashes = await call("mobile_get_crash_logs", { device, appId: settings });
	assert.equal(typeof crashes.found, "boolean");
	passed.push(`android crash logs (found=${String(crashes.found)})`);

	const snapshot = "mobile_mcp_live";
	await call("mobile_emulator_snapshot", { device, action: "save", name: snapshot });
	try {
		const listed = await call("mobile_emulator_snapshot", { device, action: "list" });
		assert.ok((listed.snapshots as string[]).includes(snapshot));
		await call("mobile_emulator_snapshot", { device, action: "load", name: snapshot });
	} finally {
		await call("mobile_emulator_snapshot", { device, action: "delete", name: snapshot });
	}
	const after = await call("mobile_emulator_snapshot", { device, action: "list" });
	assert.ok(!(after.snapshots as string[]).includes(snapshot));
	passed.push("android snapshot save -> list -> load -> delete");

	await call("mobile_phone_call", { device, action: "call", phoneNumber: "5551234" });
	await pause(1_500);
	await call("mobile_phone_call", { device, action: "cancel", phoneNumber: "5551234" });
	// The console reports failures as "KO:" with exit 0; they must surface.
	await rejects(
		"mobile_phone_call",
		{ device, action: "accept", phoneNumber: "5559999" },
		/rejected/u,
	);
	passed.push("android phone call -> cancel, console KO surfaces as error");

	await call("mobile_set_sensor", { device, sensor: "light", values: [200] });
	await call("mobile_set_sensor", { device, sensor: "acceleration", values: [0, 9.8, 0] });
	passed.push("android set_sensor light, acceleration");

	try {
		await call("mobile_set_proxy", { device, action: "set", proxy: "127.0.0.1:8888" });
	} finally {
		await call("mobile_set_proxy", { device, action: "clear" });
	}
	passed.push("android proxy set -> clear");

	try {
		await call("mobile_set_accessibility", { device, reduceMotion: true });
	} finally {
		await call("mobile_set_accessibility", { device, reduceMotion: false });
	}
	passed.push("android reduceMotion on -> off");

	await call("mobile_press_key", { device, key: "NOTIFICATIONS" });
	await pause(1_000);
	// The shade is a SystemUI window, not an app, so check the UI tree.
	const shade = await call("mobile_list_elements", { device, query: "com.android.systemui:id/" });
	assert.ok((shade.count as number) > 0, "notification shade is visible");
	await call("mobile_press_key", { device, key: "BACK" });
	passed.push("android NOTIFICATIONS key opens the shade");

	try {
		await call("mobile_set_accessibility", { device, screenReader: true });
	} finally {
		await call("mobile_set_accessibility", { device, screenReader: false });
	}
	await call("mobile_press_key", { device, key: "HOME" });
	passed.push("android TalkBack on -> off");
}

async function ios(device: string): Promise<void> {
	const settings = "com.apple.Preferences";
	await call("mobile_press_key", { device, key: "HOME" });

	try {
		await call("mobile_simulate_biometric", { device, action: "enroll" });
		await call("mobile_simulate_biometric", { device, action: "match" });
		await call("mobile_simulate_biometric", { device, action: "fail" });
	} finally {
		await call("mobile_simulate_biometric", { device, action: "unenroll" });
	}
	passed.push("ios biometric enroll -> match -> fail -> unenroll");

	try {
		await call("mobile_set_orientation", { device, orientation: "landscape" });
	} finally {
		await call("mobile_set_orientation", { device, orientation: "portrait" });
	}
	passed.push("ios orientation landscape -> portrait on the home screen");

	assert.deepEqual((await call("mobile_handle_alert", { device, action: "list" })).buttons, []);
	passed.push("ios handle_alert list with no alert");

	await call("mobile_launch_app", { device, appId: settings, locale: "fr-FR" });
	await waitForLabel(device, "Général");
	await call("mobile_launch_app", {
		device,
		appId: settings,
		arguments: ["-MobileMcpLive", "YES"],
		environment: { MOBILE_MCP_LIVE: "1" },
	});
	await waitForLabel(device, "General");
	passed.push("ios launch locale fr-FR -> default, arguments, environment");

	const audit = await call("mobile_accessibility_audit", { device, limit: 20 });
	assert.equal(typeof audit.count, "number");
	passed.push(`ios accessibility audit (${String(audit.count)} issues)`);

	await scrollRoundTrip(device, "Developer", "General");
	passed.push("ios scroll_to_element Developer -> General");

	await call("mobile_tap_element", { device, query: "General" });
	await call("mobile_wait_for_element", { device, query: "About" });
	passed.push("ios tap_element General, wait_for_element visible");

	await call("mobile_launch_app", { device, appId: settings });
	await waitForLabel(device, "General");
	await call("mobile_tap_element", { device, query: "Search" });
	await pause(1_000);
	await call("mobile_type_text", { device, text: "wifi" });
	assert.equal((await call("mobile_dismiss_keyboard", { device })).dismissed, true);
	passed.push("ios dismiss_keyboard after typing");

	const screen = await call("mobile_get_screen_info", { device });
	await call("mobile_double_tap", {
		device,
		x: Math.floor((screen.width as number) / 2),
		y: 5,
	});
	passed.push("ios double_tap");
	await call("mobile_terminate_app", { device, appId: settings });
	await call("mobile_press_key", { device, key: "HOME" });

	try {
		assert.equal((await call("mobile_set_lock", { device, locked: true })).locked, true);
	} finally {
		assert.equal((await call("mobile_set_lock", { device, locked: false })).locked, false);
	}
	passed.push("ios set_lock true -> false");

	await record(device, "ios");
	passed.push("ios record_screen 2s, start -> HOME -> stop");

	const crashes = await call("mobile_get_crash_logs", {
		device,
		appId: "com.apple.mobilesafari",
		sinceMinutes: 1_440,
	});
	passed.push(`ios crash logs Safari (found=${String(crashes.found)})`);

	try {
		await call("mobile_set_accessibility", {
			device,
			reduceMotion: true,
			reduceTransparency: true,
		});
	} finally {
		await call("mobile_set_accessibility", {
			device,
			reduceMotion: false,
			reduceTransparency: false,
		});
	}
	try {
		await call("mobile_set_accessibility", { device, screenReader: true });
	} finally {
		await call("mobile_set_accessibility", { device, screenReader: false });
	}
	passed.push("ios reduceMotion, reduceTransparency, VoiceOver on -> off");
}

try {
	await mkdir(artifacts, { recursive: true });
	await client.connect(transport);
	const devices = (await call("mobile_list_devices", {})).devices as ListedDevice[];
	const androidDevice = devices.find(
		(entry) => entry.platform === "android" && entry.state === "online",
	);
	const iosDevice = devices.find(
		(entry) => entry.platform === "ios" && entry.state === "online",
	);
	assert.ok(androidDevice, "Start an Android Emulator first");
	assert.ok(iosDevice, "Boot an iOS Simulator first");
	await android(androidDevice.id);
	await ios(iosDevice.id);
	for (const entry of passed) console.log(`PASS  ${entry}`);
	console.log(`\n${passed.length} extended live checks passed`);
} catch (error) {
	for (const entry of passed) console.log(`PASS  ${entry}`);
	console.error(`server stderr tail:\n${stderr.split("\n").slice(-15).join("\n")}`);
	throw error;
} finally {
	await client.close();
	await rm(artifacts, { recursive: true, force: true });
}
