import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMobileServer } from "../src/server.js";

const created = createMobileServer({
	doctor: async () => ({ ok: true, source: "test" }),
});
const client = new Client({ name: "mobile-mcp-test", version: "1.0.0" });

before(async () => {
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		client.connect(clientTransport),
		created.server.connect(serverTransport),
	]);
});

after(async () => {
	await client.close();
	await created.close();
});

test("lists the focused mobile tool surface", async () => {
	const result = await client.listTools();
	const names = result.tools.map((tool) => tool.name);
	assert.equal(names.length, 53);
	assert.deepEqual(names, [
		"mobile_doctor",
		"mobile_list_devices",
		"mobile_boot_device",
		"mobile_shutdown_device",
		"mobile_install_app",
		"mobile_launch_app",
		"mobile_terminate_app",
		"mobile_list_apps",
		"mobile_get_foreground_app",
		"mobile_get_logs",
		"mobile_reset_app",
		"mobile_set_permission",
		"mobile_set_location",
		"mobile_send_push",
		"mobile_add_media",
		"mobile_uninstall_app",
		"mobile_erase_device",
		"mobile_set_clipboard",
		"mobile_get_clipboard",
		"mobile_set_status_bar",
		"mobile_set_appearance",
		"mobile_set_accessibility",
		"mobile_set_battery",
		"mobile_send_sms",
		"mobile_fingerprint",
		"mobile_set_network",
		"mobile_set_connectivity",
		"mobile_rotate",
		"mobile_set_orientation",
		"mobile_open_url",
		"mobile_take_screenshot",
		"mobile_get_ui_tree",
		"mobile_list_elements",
		"mobile_tap_element",
		"mobile_double_tap",
		"mobile_handle_alert",
		"mobile_dismiss_keyboard",
		"mobile_set_lock",
		"mobile_simulate_biometric",
		"mobile_record_screen",
		"mobile_get_crash_logs",
		"mobile_accessibility_audit",
		"mobile_keychain",
		"mobile_emulator_snapshot",
		"mobile_phone_call",
		"mobile_set_sensor",
		"mobile_set_proxy",
		"mobile_get_screen_info",
		"mobile_tap",
		"mobile_long_press",
		"mobile_swipe",
		"mobile_type_text",
		"mobile_press_key",
	]);

	const reset = result.tools.find((tool) => tool.name === "mobile_reset_app");
	assert.equal(reset?.annotations?.destructiveHint, true);
	assert.doesNotMatch(JSON.stringify(reset?.inputSchema), /confirm/u);
	for (const name of ["mobile_uninstall_app", "mobile_erase_device"]) {
		assert.equal(
			result.tools.find((tool) => tool.name === name)?.annotations
				?.destructiveHint,
			true,
		);
	}
	// Every tool except the image-only screenshot returns structuredContent,
	// so each one must advertise an output schema for clients to validate.
	for (const tool of result.tools) {
		if (tool.name === "mobile_take_screenshot") continue;
		assert.ok(tool.outputSchema, `${tool.name} is missing an outputSchema`);
	}
	assert.equal(
		result.tools.find((tool) => tool.name === "mobile_take_screenshot")
			?.outputSchema,
		undefined,
	);
});

test("advertises server instructions for agent onboarding", () => {
	const instructions = client.getInstructions();
	assert.match(String(instructions), /mobile_doctor/u);
	assert.match(String(instructions), /mobile_list_devices/u);
	assert.match(String(instructions), /WebDriverAgent/u);
	assert.match(String(instructions), /mobile_list_elements/u);
});

test("returns structured data for a valid call", async () => {
	const result = await client.callTool({
		name: "mobile_doctor",
		arguments: {},
	});
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.structuredContent, { ok: true, source: "test" });
});

test("rejects invalid environment controls before native execution", async () => {
	const [battery, sms] = await Promise.all([
		client.callTool({
			name: "mobile_set_battery",
			arguments: {
				device: "android:emulator-5554",
				capacity: 101,
				charging: true,
			},
		}),
		client.callTool({
			name: "mobile_send_sms",
			arguments: {
				device: "android:emulator-5554",
				phoneNumber: "not a number",
				text: "test",
			},
		}),
	]);
	assert.equal(battery.isError, true);
	assert.equal(sms.isError, true);
});

test("rejects platform-mismatched and malformed inputs before native execution", async () => {
	const ios = "ios:A8627257-2D08-47F0-A65B-C17F017A71CD";
	const android = "android:emulator-5554";
	const calls: Array<[string, Record<string, unknown>, RegExp]> = [
		["mobile_launch_app", { device: ios, appId: "com.example.app", extras: { a: "b" } }, /Android-only/u],
		["mobile_launch_app", { device: android, appId: "com.example.app", arguments: ["-x"] }, /iOS-only/u],
		["mobile_launch_app", { device: ios, appId: "com.example.app", locale: "not a locale" }, /invalid|locale/iu],
		["mobile_launch_app", { device: ios, appId: "com.example.app", environment: { "BAD-NAME": "x" } }, /invalid/iu],
		["mobile_handle_alert", { device: android, action: "accept" }, /mobile_tap_element/u],
		["mobile_simulate_biometric", { device: android, action: "match" }, /mobile_fingerprint/u],
		["mobile_accessibility_audit", { device: android }, /Android has no/u],
		["mobile_keychain", { device: android, action: "reset" }, /iOS Simulators only/u],
		["mobile_emulator_snapshot", { device: ios, action: "list" }, /Android Emulators only/u],
		["mobile_emulator_snapshot", { device: android, action: "save", name: "../x" }, /invalid/iu],
		["mobile_set_proxy", { device: android, action: "set", proxy: "http://user:pw@host:80" }, /invalid/iu],
		["mobile_set_sensor", { device: android, sensor: "bogus", values: [1] }, /invalid/iu],
		["mobile_phone_call", { device: android, action: "call", phoneNumber: "555; rm" }, /invalid/iu],
		["mobile_set_location", { device: android, action: "route", waypoints: [{ latitude: 1, longitude: 1 }] }, /invalid|too small|>=2/iu],
		["mobile_set_orientation", { device: ios, orientation: "auto" }, /Android-only/u],
		["mobile_record_screen", { device: android, path: "clip.mov" }, /\.mp4/u],
		["mobile_tap_element", { device: android, query: "" }, /invalid|too small/iu],
	];
	for (const [name, args, expected] of calls) {
		const result = await client.callTool({ name, arguments: args });
		assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} must fail`);
		assert.match(JSON.stringify(result.content), expected, name);
	}
});

test("rejects unknown input fields before executing a tool", async () => {
	const result = await client.callTool({
		name: "mobile_doctor",
		arguments: { unexpected: true },
	});
	assert.equal(result.isError, true);
	assert.match(
		JSON.stringify(result.content),
		/unexpected|unrecognized|invalid/iu,
	);
});
