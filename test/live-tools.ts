import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Live gate for the discovery/appearance/gesture tools added in 0.3.0.
// Android runs in full. iOS runs only the paths that do not need
// WebDriverAgent, because launching WDA takes over the Simulator's
// foreground; set MOBILE_MCP_LIVE_WDA=1 to include those too.

interface ListedDevice {
	id: string;
	platform: "ios" | "android";
	state: string;
}

function structured(result: CallToolResult): Record<string, unknown> {
	if (result.isError) throw new Error(JSON.stringify(result.content));
	assert.ok(
		result.structuredContent && typeof result.structuredContent === "object",
	);
	return result.structuredContent;
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [resolve("dist/src/index.js")],
	cwd: process.cwd(),
	stderr: "pipe",
});
const client = new Client({ name: "mobile-mcp-live-tools", version: "1.0.0" });
const passed: string[] = [];
const call = async (
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
	structured(
		(await client.callTool({ name, arguments: args })) as CallToolResult,
	);

try {
	await client.connect(transport);
	assert.match(
		String(client.getInstructions()),
		/mobile_list_devices/u,
		"server must advertise onboarding instructions",
	);
	passed.push("server instructions advertised");

	const devices = (await call("mobile_list_devices", {}))
		.devices as ListedDevice[];
	const android = devices.find(
		(device) => device.platform === "android" && device.state === "online",
	);
	const ios = devices.find(
		(device) => device.platform === "ios" && device.state === "online",
	);
	assert.ok(
		android,
		"Start an Android Emulator before running npm run live:tools",
	);

	for (const device of [android.id, ...(ios ? [ios.id] : [])]) {
		const listed = await call("mobile_list_apps", { device });
		assert.ok(Array.isArray(listed.apps) && listed.apps.length > 0);
		assert.equal(listed.count, (listed.apps as unknown[]).length);
		const withSystem = await call("mobile_list_apps", {
			device,
			includeSystem: true,
		});
		assert.ok(
			(withSystem.count as number) > (listed.count as number),
			"includeSystem must widen the result",
		);
		passed.push(`${device} list_apps (${String(listed.count)} user apps)`);

		// Appearance must round-trip so the device is left as it was found.
		for (const mode of ["dark", "light"] as const) {
			const result = await call("mobile_set_appearance", { device, mode });
			assert.equal(result.mode, mode);
		}
		passed.push(`${device} set_appearance dark -> light`);
	}

	const screen = await call("mobile_get_screen_info", { device: android.id });
	assert.ok((screen.width as number) > 0 && (screen.height as number) > 0);
	assert.ok(["portrait", "landscape"].includes(screen.orientation as string));
	passed.push(
		`android screen ${String(screen.width)}x${String(screen.height)} ${String(screen.orientation)}`,
	);

	// Element centers must land on screen and the query filter must narrow.
	const elements = await call("mobile_list_elements", { device: android.id });
	const listedElements = elements.elements as Array<{
		label?: string;
		center: { x: number; y: number };
	}>;
	assert.ok(listedElements.length > 0, "home screen exposes elements");
	for (const { center } of listedElements) {
		assert.ok(center.x >= 0 && center.x < (screen.width as number));
		assert.ok(center.y >= 0 && center.y < (screen.height as number));
	}
	const labeled = listedElements.find((entry) => entry.label);
	if (labeled?.label) {
		const filtered = await call("mobile_list_elements", {
			device: android.id,
			query: labeled.label,
		});
		assert.ok((filtered.count as number) >= 1);
		assert.ok((filtered.count as number) <= (elements.count as number));
	}
	passed.push(`android list_elements (${String(elements.count)} elements)`);

	const foreground = await call("mobile_get_foreground_app", {
		device: android.id,
	});
	assert.ok(typeof foreground.appId === "string" && foreground.appId.length);
	passed.push(`android foreground ${String(foreground.appId)}`);

	await call("mobile_long_press", {
		device: android.id,
		x: Math.floor((screen.width as number) / 2),
		y: Math.floor((screen.height as number) / 2),
		durationMs: 600,
	});
	passed.push("android long_press at screen centre");

	await call("mobile_set_accessibility", {
		device: android.id,
		fontScale: 1.15,
	});
	await call("mobile_set_accessibility", { device: android.id, fontScale: 1 });
	passed.push("android set_accessibility fontScale round-trip");

	// Rejections must stay rejections: wrong platform and out-of-range input.
	const rejected = await client.callTool({
		name: "mobile_set_accessibility",
		arguments: { device: android.id, contentSize: "large" },
	});
	assert.equal(
		rejected.isError,
		true,
		"contentSize must be rejected on Android",
	);
	const offscreen = await client.callTool({
		name: "mobile_long_press",
		arguments: {
			device: android.id,
			x: (screen.width as number) + 500,
			y: 10,
			durationMs: 300,
		},
	});
	assert.equal(
		offscreen.isError,
		true,
		"offscreen long press must be rejected",
	);
	passed.push("platform and coordinate rejections hold");

	if (ios && process.env.MOBILE_MCP_LIVE_WDA === "1") {
		const iosScreen = await call("mobile_get_screen_info", { device: ios.id });
		assert.ok((iosScreen.width as number) > 0);
		const iosForeground = await call("mobile_get_foreground_app", {
			device: ios.id,
		});
		assert.ok(typeof iosForeground.appId === "string");
		const iosElements = await call("mobile_list_elements", { device: ios.id });
		assert.ok((iosElements.count as number) > 0);
		// The iPhone home screen is portrait-only; rotate inside Safari instead.
		const rotatable = { device: ios.id, appId: "com.apple.mobilesafari" };
		const homeRotation = await client.callTool({
			name: "mobile_set_orientation",
			arguments: { device: ios.id, orientation: "landscape" },
		});
		if (homeRotation.isError)
			assert.match(JSON.stringify(homeRotation.content), /portrait-only/u);
		await call("mobile_launch_app", rotatable);
		try {
			for (const orientation of ["landscape", "portrait"] as const)
				await call("mobile_set_orientation", { device: ios.id, orientation });
		} finally {
			await call("mobile_set_orientation", {
				device: ios.id,
				orientation: "portrait",
			}).catch(() => undefined);
			await call("mobile_terminate_app", rotatable);
			await call("mobile_press_key", { device: ios.id, key: "HOME" });
		}
		passed.push(
			"ios WDA screen_info, foreground_app, list_elements, orientation round-trip",
		);
	}

	for (const entry of passed) console.log(`PASS  ${entry}`);
	console.log(`\n${passed.length} live tool checks passed`);
} finally {
	await client.close();
}
