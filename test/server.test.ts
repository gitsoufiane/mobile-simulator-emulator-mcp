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
	assert.equal(names.length, 39);
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
