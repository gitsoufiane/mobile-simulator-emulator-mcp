import assert from "node:assert/strict";
import { resolve } from "node:path";
import { type CallToolResult, Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

interface ListedDevice {
	id: string;
	platform: "ios" | "android";
	state: string;
}

function structured(result: CallToolResult): Record<string, unknown> {
	if (result.isError) throw new Error(JSON.stringify(result.content));
	const data = result.structuredContent;
	assert.ok(typeof data === "object" && data !== null);
	return data as Record<string, unknown>;
}

function screenshotBytes(result: CallToolResult): number {
	if (result.isError) throw new Error(JSON.stringify(result.content));
	const image = result.content.find((item) => item.type === "image");
	assert.ok(image && image.type === "image");
	const data = Buffer.from(image.data, "base64");
	const signature = image.mimeType === "image/png" ? "89504e470d0a1a0a" : "ffd8ff";
	assert.equal(data.subarray(0, signature.length / 2).toString("hex"), signature);
	return data.length;
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [resolve("dist/src/index.js")],
	cwd: process.cwd(),
	stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk: Buffer | string) => {
	if (stderr.length < 100_000) stderr += chunk.toString();
});
const client = new Client({ name: "mobile-mcp-live-smoke", version: "1.0.0" });

try {
	await client.connect(transport);
	structured(
		(await client.callTool({
			name: "mobile_doctor",
			arguments: {},
		})) as CallToolResult,
	);
	const listed = structured(
		(await client.callTool({
			name: "mobile_list_devices",
			arguments: {},
		})) as CallToolResult,
	);
	assert.ok(Array.isArray(listed.devices));
	const devices = listed.devices as ListedDevice[];
	const android = devices.find(
		(device) => device.platform === "android" && device.state === "online",
	);
	const ios = devices.find(
		(device) => device.platform === "ios" && device.state === "online",
	);
	assert.ok(android, "Start an Android Emulator before running npm run live");
	assert.ok(ios, "Boot an iOS Simulator before running npm run live");

	const [androidScreenshot, iosScreenshot, androidUiResult, iosUiResult] =
		await Promise.all([
			client.callTool({
				name: "mobile_take_screenshot",
				arguments: { device: android.id },
			}),
			client.callTool({
				name: "mobile_take_screenshot",
				arguments: { device: ios.id },
			}),
			client.callTool({
				name: "mobile_get_ui_tree",
				arguments: { device: android.id },
			}),
			client.callTool({
				name: "mobile_get_ui_tree",
				arguments: { device: ios.id },
			}),
		]);
	const androidUi = structured(androidUiResult as CallToolResult);
	const iosUi = structured(iosUiResult as CallToolResult);
	assert.equal(androidUi.format, "xml");
	assert.equal(iosUi.format, "json");
	assert.ok(
		typeof androidUi.tree === "string" && androidUi.tree.includes("<hierarchy"),
	);
	assert.ok(typeof iosUi.tree === "string" && iosUi.tree.length > 100);

	// HOME is a reversible interaction and proves both protocol-to-device input paths.
	await Promise.all([
		client.callTool({
			name: "mobile_press_key",
			arguments: { device: android.id, key: "HOME" },
		}),
		client.callTool({
			name: "mobile_press_key",
			arguments: { device: ios.id, key: "HOME" },
		}),
		client.callTool({
			name: "mobile_press_key",
			arguments: { device: ios.id, key: "HOME" },
		}),
	]);

	const iosFullResolution = (await client.callTool({
		name: "mobile_take_screenshot",
		arguments: { device: ios.id, fullResolution: true },
	})) as CallToolResult;
	const iosJpegBytes = screenshotBytes(iosScreenshot as CallToolResult);
	const iosPngBytes = screenshotBytes(iosFullResolution);
	assert.ok(
		iosJpegBytes * 5 < iosPngBytes,
		`the default iOS screenshot (${iosJpegBytes} bytes) is far smaller than the PNG (${iosPngBytes} bytes)`,
	);

	process.stdout.write(
		`${JSON.stringify({
			android: android.id,
			ios: ios.id,
			androidScreenshotBytes: screenshotBytes(
				androidScreenshot as CallToolResult,
			),
			iosScreenshotBytes: iosJpegBytes,
			iosFullResolutionBytes: iosPngBytes,
			androidUiCharacters: (androidUi.tree as string).length,
			iosUiCharacters: (iosUi.tree as string).length,
			interaction: "HOME",
			serverStderrLines: stderr.trim().split("\n").filter(Boolean).length,
		})}\n`,
	);
} finally {
	await client.close();
}
