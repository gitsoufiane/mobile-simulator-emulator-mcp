import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface ListedDevice {
	id: string;
	platform: "ios" | "android";
	state: string;
}

interface Point {
	x: number;
	y: number;
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
const client = new Client({
	name: "mobile-mcp-live-manipulation",
	version: "1.0.0",
});
const pause = (milliseconds: number) =>
	new Promise<void>((resolvePause) => setTimeout(resolvePause, milliseconds));

async function call(
	name: string,
	args: Record<string, unknown> = {},
): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function callOk(
	name: string,
	args: Record<string, unknown> = {},
): Promise<CallToolResult> {
	const result = await call(name, args);
	if (result.isError)
		throw new Error(`${name}: ${JSON.stringify(result.content)}`);
	return result;
}

function structured(result: CallToolResult): Record<string, unknown> {
	assert.ok(
		result.structuredContent && typeof result.structuredContent === "object",
	);
	return result.structuredContent;
}

async function uiTree(device: string): Promise<string> {
	const data = structured(await callOk("mobile_get_ui_tree", { device }));
	assert.ok(typeof data.tree === "string");
	return data.tree;
}

async function waitForUi(
	device: string,
	predicate: (tree: string) => boolean,
	description: string,
	timeoutMs = 10_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	const poll = async (): Promise<string> => {
		const tree = await uiTree(device);
		if (predicate(tree)) return tree;
		if (Date.now() >= deadline)
			throw new Error(
				`Timed out waiting for ${description}. Last tree: ${tree.slice(0, 600)}`,
			);
		await pause(500);
		return poll();
	};
	return poll();
}

async function screenshot(
	device: string,
): Promise<{ bytes: number; sha256: string }> {
	const result = await callOk("mobile_take_screenshot", { device });
	const image = result.content.find((item) => item.type === "image");
	assert.ok(image && image.type === "image");
	const data = Buffer.from(image.data, "base64");
	assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	return {
		bytes: data.length,
		sha256: createHash("sha256").update(data).digest("hex").slice(0, 16),
	};
}

function androidPoint(tree: string, label: string): Point {
	for (const tag of tree.match(/<node\b[^>]*>/gu) ?? []) {
		const attributes = Object.fromEntries(
			[...tag.matchAll(/([\w-]+)="([^"]*)"/gu)].map((match) => [
				match[1],
				match[2],
			]),
		);
		if (attributes.text !== label && attributes["content-desc"] !== label)
			continue;
		const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(
			attributes.bounds ?? "",
		);
		if (bounds?.[1] && bounds[2] && bounds[3] && bounds[4]) {
			return {
				x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
				y: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2),
			};
		}
	}
	throw new Error(`Android element not found: ${label}`);
}

function iosPoint(tree: string, label: string, type: string): Point {
	let found: Point | undefined;
	const visit = (value: unknown): void => {
		if (found || !value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const child of value) visit(child);
			return;
		}
		const item = value as Record<string, unknown>;
		if (
			item.label === label &&
			item.type === type &&
			typeof item.frame === "string"
		) {
			const frame =
				/^\{\{(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\},\s*\{(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\}\}$/u.exec(
					item.frame,
				);
			if (frame?.[1] && frame[2] && frame[3] && frame[4]) {
				found = {
					x: Math.round(Number(frame[1]) + Number(frame[3]) / 2),
					y: Math.round(Number(frame[2]) + Number(frame[4]) / 2),
				};
			}
		}
		for (const child of Object.values(item)) visit(child);
	};
	let parsed: unknown;
	try {
		parsed = JSON.parse(tree) as unknown;
	} catch (error) {
		throw new Error(
			`iOS UI tree was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	visit(parsed);
	if (!found) throw new Error(`iOS element not found: ${type} ${label}`);
	return found;
}

async function tap(device: string, point: Point): Promise<void> {
	await callOk("mobile_tap", { device, ...point });
}

async function expectError(
	name: string,
	args: Record<string, unknown>,
	pattern: RegExp,
): Promise<string> {
	const result = await call(name, args);
	assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
	const message = result.content
		.filter((item) => item.type === "text")
		.map((item) => (item.type === "text" ? item.text : ""))
		.join("\n");
	assert.match(message, pattern);
	return message;
}

let connected = false;
let androidId: string | undefined;
let iosId: string | undefined;
let iosClipboardText: string | undefined;

try {
	await client.connect(transport);
	connected = true;
	const doctor = structured(await callOk("mobile_doctor"));
	assert.equal(doctor.ok, true);
	const listed = structured(await callOk("mobile_list_devices"));
	assert.ok(Array.isArray(listed.devices));
	const devices = listed.devices as ListedDevice[];
	const android = devices.find(
		(device) => device.platform === "android" && device.state === "online",
	);
	const ios = devices.find(
		(device) => device.platform === "ios" && device.state === "online",
	);
	assert.ok(android, "Start an Android Emulator before npm run live:deep");
	assert.ok(ios, "Boot an iOS Simulator before npm run live:deep");
	androidId = android.id;
	iosId = ios.id;

	await Promise.all([
		callOk("mobile_press_key", { device: android.id, key: "HOME" }),
		callOk("mobile_press_key", { device: ios.id, key: "HOME" }),
	]);
	const baseline = {
		android: await screenshot(android.id),
		ios: await screenshot(ios.id),
	};
	const spareIos = devices.find(
		(device) =>
			device.platform === "ios" &&
			device.state === "shutdown" &&
			device.id !== ios.id,
	);
	if (spareIos) {
		try {
			await callOk("mobile_boot_device", {
				device: spareIos.id,
				timeoutSeconds: 180,
			});
		} finally {
			await call("mobile_shutdown_device", { device: spareIos.id });
		}
	}
	let rotations = 0;
	try {
		while (rotations < 4) {
			await callOk("mobile_rotate", { device: android.id });
			rotations += 1;
		}
	} finally {
		while (rotations % 4 !== 0) {
			await call("mobile_rotate", { device: android.id });
			rotations += 1;
		}
	}
	await callOk("mobile_fingerprint", {
		device: android.id,
		action: "remove",
	});
	const clipboard = structured(
		await callOk("mobile_get_clipboard", { device: ios.id }),
	);
	assert.equal(typeof clipboard.text, "string");
	iosClipboardText = clipboard.text as string;
	await callOk("mobile_set_clipboard", {
		device: ios.id,
		text: "mobile-mcp-live-check",
	});
	assert.equal(
		structured(await callOk("mobile_get_clipboard", { device: ios.id })).text,
		"mobile-mcp-live-check",
	);
	await callOk("mobile_set_clipboard", {
		device: ios.id,
		text: iosClipboardText,
	});
	await callOk("mobile_set_status_bar", {
		device: ios.id,
		action: "override",
		time: "9:41",
		batteryState: "charged",
		batteryLevel: 100,
	});
	await callOk("mobile_set_status_bar", { device: ios.id, action: "clear" });
	await callOk("mobile_set_battery", {
		device: android.id,
		capacity: 73,
		charging: false,
	});
	await callOk("mobile_set_network", {
		device: android.id,
		speed: "edge",
		delay: "edge",
	});
	await Promise.all([
		callOk("mobile_set_location", {
			device: android.id,
			action: "set",
			latitude: 37.7749,
			longitude: -122.4194,
		}),
		callOk("mobile_set_location", {
			device: ios.id,
			action: "set",
			latitude: 37.7749,
			longitude: -122.4194,
		}),
	]);
	await callOk("mobile_set_location", { device: ios.id, action: "clear" });

	await Promise.all([
		callOk("mobile_terminate_app", {
			device: android.id,
			appId: "com.android.settings",
		}),
		callOk("mobile_terminate_app", {
			device: android.id,
			appId: "com.google.android.settings.intelligence",
		}),
	]);
	await callOk("mobile_press_key", { device: android.id, key: "HOME" });
	await callOk("mobile_launch_app", {
		device: android.id,
		appId: "com.android.settings",
	});
	const androidSettings = await waitForUi(
		android.id,
		(tree) => /(?:text|content-desc)="Search Settings"/u.test(tree),
		"Android Settings root screen",
		15_000,
	);
	await tap(android.id, androidPoint(androidSettings, "Search Settings"));
	await pause(500);
	await callOk("mobile_type_text", { device: android.id, text: "battery" });
	await pause(1_000);
	const androidSearch = await uiTree(android.id);
	assert.match(androidSearch, /battery/iu);
	await callOk("mobile_swipe", {
		device: android.id,
		fromX: 500,
		fromY: 1_600,
		toX: 500,
		toY: 600,
		durationMs: 400,
	});
	const androidManipulated = await screenshot(android.id);
	const androidLogs = structured(
		await callOk("mobile_get_logs", {
			device: android.id,
			appId: "com.android.settings",
			sinceMinutes: 5,
			maxLines: 100,
		}),
	);
	assert.equal(typeof androidLogs.logs, "string");
	await callOk("mobile_terminate_app", {
		device: android.id,
		appId: "com.android.settings",
	});
	await callOk("mobile_press_key", { device: android.id, key: "HOME" });

	await callOk("mobile_terminate_app", {
		device: ios.id,
		appId: "com.apple.Preferences",
	});
	await callOk("mobile_launch_app", {
		device: ios.id,
		appId: "com.apple.Preferences",
	});
	const iosSettings = await waitForUi(
		ios.id,
		(tree) => tree.includes('"label":"General"'),
		"iOS Settings root screen",
	);
	await tap(ios.id, iosPoint(iosSettings, "General", "Button"));
	await pause(750);
	const iosGeneral = await uiTree(ios.id);
	assert.notEqual(iosGeneral, iosSettings);
	assert.match(iosGeneral, /"label":"About"/u);
	await callOk("mobile_swipe", {
		device: ios.id,
		fromX: 200,
		fromY: 700,
		toX: 200,
		toY: 300,
		durationMs: 400,
	});
	await pause(500);
	const iosScrolled = await uiTree(ios.id);
	assert.notEqual(iosScrolled, iosGeneral);
	const iosManipulated = await screenshot(ios.id);
	const iosLogs = structured(
		await callOk("mobile_get_logs", {
			device: ios.id,
			appId: "com.apple.Preferences",
			sinceMinutes: 5,
			maxLines: 100,
		}),
	);
	assert.equal(typeof iosLogs.logs, "string");
	await callOk("mobile_terminate_app", {
		device: ios.id,
		appId: "com.apple.Preferences",
	});
	await callOk("mobile_press_key", { device: ios.id, key: "HOME" });

	await Promise.all([
		callOk("mobile_open_url", {
			device: android.id,
			url: "https://example.com",
		}),
		callOk("mobile_open_url", { device: ios.id, url: "https://example.com" }),
	]);
	await pause(3_000);
	let [androidBrowserTree, iosBrowserTree] = await Promise.all([
		uiTree(android.id),
		uiTree(ios.id),
	]);
	let androidPromptsDismissed = 0;
	while (
		!/Example Domain|example\.com/iu.test(androidBrowserTree) &&
		androidBrowserTree.includes("No thanks") &&
		androidPromptsDismissed < 3
	) {
		await tap(android.id, androidPoint(androidBrowserTree, "No thanks"));
		androidPromptsDismissed += 1;
		await pause(2_000);
		androidBrowserTree = await uiTree(android.id);
	}
	assert.match(androidBrowserTree, /Example Domain|example\.com/iu);
	assert.match(iosBrowserTree, /Example Domain|example\.com/iu);
	const [androidBrowser, iosBrowser] = await Promise.all([
		screenshot(android.id),
		screenshot(ios.id),
	]);

	const negativeChecks = await Promise.all([
		expectError(
			"mobile_take_screenshot",
			{ device: "android:physical-device" },
			/Invalid online device ID/u,
		),
		expectError(
			"mobile_open_url",
			{ device: android.id, url: "javascript".concat(":alert(1)") },
			/not allowed/u,
		),
		expectError(
			"mobile_tap",
			{ device: android.id, x: 99_999, y: 99_999 },
			/outside|exceed/u,
		),
		expectError(
			"mobile_launch_app",
			{ device: android.id, appId: "com.example.bad-app" },
			/Invalid android app identifier/u,
		),
		expectError(
			"mobile_set_location",
			{ device: android.id, action: "set", latitude: 91, longitude: 0 },
			/invalid|less than or equal/iu,
		),
	]);

	await Promise.all([
		callOk("mobile_press_key", { device: android.id, key: "HOME" }),
		callOk("mobile_press_key", { device: ios.id, key: "HOME" }),
	]);

	process.stdout.write(
		`${JSON.stringify({
			devices: { android: android.id, ios: ios.id },
			doctorOk: doctor.ok,
			baseline,
			android: {
				settingsTreeCharacters: androidSettings.length,
				searchTreeCharacters: androidSearch.length,
				logCharacters: (androidLogs.logs as string).length,
				actions: [
					"launch Settings",
					"tap Search Settings",
					"type battery",
					"swipe",
					"terminate",
					"HOME",
				],
				screenshot: androidManipulated,
			},
			ios: {
				settingsTreeCharacters: iosSettings.length,
				generalTreeCharacters: iosGeneral.length,
				scrolledTreeCharacters: iosScrolled.length,
				logCharacters: (iosLogs.logs as string).length,
				actions: [
					"launch Settings",
					"tap General",
					"swipe",
					"terminate",
					"HOME",
				],
				screenshot: iosManipulated,
			},
			browser: {
				url: "https://example.com",
				androidPromptsDismissed,
				androidTreeCharacters: androidBrowserTree.length,
				iosTreeCharacters: iosBrowserTree.length,
				androidScreenshot: androidBrowser,
				iosScreenshot: iosBrowser,
			},
			negativeChecks: negativeChecks.length,
			serverStderrLines: stderr.trim().split("\n").filter(Boolean).length,
		})}\n`,
	);
} finally {
	if (connected) {
		const cleanup: Promise<CallToolResult>[] = [];
		if (androidId) {
			cleanup.push(
				call("mobile_set_battery", {
					device: androidId,
					capacity: 100,
					charging: true,
				}),
				call("mobile_set_network", {
					device: androidId,
					speed: "full",
					delay: "none",
				}),
			);
			for (const appId of [
				"com.android.settings",
				"com.google.android.settings.intelligence",
				"com.android.chrome",
			]) {
				cleanup.push(
					call("mobile_terminate_app", { device: androidId, appId }),
				);
			}
			cleanup.push(
				call("mobile_set_location", {
					device: androidId,
					action: "set",
					latitude: 0,
					longitude: 0,
				}),
				call("mobile_press_key", { device: androidId, key: "HOME" }),
			);
		}
		if (iosId) {
			cleanup.push(
				...(iosClipboardText === undefined
					? []
					: [
							call("mobile_set_clipboard", {
								device: iosId,
								text: iosClipboardText,
							}),
						]),
				call("mobile_set_status_bar", { device: iosId, action: "clear" }),
				call("mobile_terminate_app", {
					device: iosId,
					appId: "com.apple.Preferences",
				}),
				call("mobile_set_location", { device: iosId, action: "clear" }),
				call("mobile_press_key", { device: iosId, key: "HOME" }),
			);
		}
		await Promise.allSettled(cleanup);
	}
	await client.close();
}
