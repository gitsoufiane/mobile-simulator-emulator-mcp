import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Live gate for the tools that install, delete, or erase. It never touches
// the user's devices: it creates a throwaway iOS Simulator and Android AVD,
// builds a throwaway app for each, and deletes all of them at the end.

const APP_ID = "dev.mobilemcp.fixture";
const AVD = "mobile_mcp_disposable";
const SDK = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
const BUILD_TOOLS = join(SDK, "build-tools/37.0.0");
const SYSTEM_IMAGE = "system-images;android-37.0;google_apis_playstore_ps16k;arm64-v8a";
// 1x1 transparent PNG.
const PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const sh = (file: string, args: string[], input?: string) =>
	execFileSync(file, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });

function buildFixtures(root: string): void {
	const app = join(root, "Fixture.app");
	mkdirSync(app);
	writeFileSync(
		join(root, "main.m"),
		"#import <UIKit/UIKit.h>\nint main(int argc, char *argv[]) { @autoreleasepool { return UIApplicationMain(argc, argv, nil, nil); } }\n",
	);
	sh("xcrun", ["-sdk", "iphonesimulator", "clang", "-arch", "arm64", "-mios-simulator-version-min=17.0", "-fobjc-arc", "-framework", "UIKit", join(root, "main.m"), "-o", join(app, "Fixture")]);
	writeFileSync(
		join(app, "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${APP_ID}</string><key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleName</key><string>MCP Fixture</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string><key>MinimumOSVersion</key><string>17.0</string>
<key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
<key>UIDeviceFamily</key><array><integer>1</integer></array></dict></plist>`,
	);
	sh("codesign", ["-s", "-", app]);

	writeFileSync(
		join(root, "AndroidManifest.xml"),
		`<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${APP_ID}" android:versionCode="1" android:versionName="1.0">
<uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/>
<uses-permission android:name="android.permission.CAMERA"/>
<application android:label="MCP Fixture" android:hasCode="false"/></manifest>`,
	);
	const tmp = (name: string) => join(root, name);
	sh(join(BUILD_TOOLS, "aapt2"), ["link", "-o", tmp("unsigned.apk"), "-I", join(SDK, "platforms/android-36/android.jar"), "--manifest", tmp("AndroidManifest.xml")]);
	sh(join(BUILD_TOOLS, "zipalign"), ["-f", "4", tmp("unsigned.apk"), tmp("aligned.apk")]);
	sh("keytool", ["-genkeypair", "-keystore", tmp("k.jks"), "-storepass", "fixture", "-keypass", "fixture", "-alias", "f", "-keyalg", "RSA", "-keysize", "2048", "-validity", "1", "-dname", "CN=fixture"]);
	sh(join(BUILD_TOOLS, "apksigner"), ["sign", "--ks", tmp("k.jks"), "--ks-pass", "pass:fixture", "--out", tmp("fixture.apk"), tmp("aligned.apk")]);

	sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", tmp("key.pem"), "-out", tmp("cert.pem"), "-days", "1", "-subj", "/CN=mobile-mcp-fixture"]);
	writeFileSync(tmp("pixel.png"), Buffer.from(PIXEL_PNG, "base64"));
}

const root = mkdtempSync(join(tmpdir(), "mobile-mcp-destructive-"));
buildFixtures(root);

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [resolve("dist/src/index.js")],
	env: Object.fromEntries(
		Object.entries({ ...process.env, MOBILE_MCP_APP_ROOT: root }).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	),
	stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk: Buffer | string) => {
	if (stderr.length < 200_000) stderr += chunk.toString();
});
const client = new Client({ name: "mobile-mcp-live-destructive", version: "1.0.0" });
const passed: string[] = [];

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
	if (result.isError)
		throw new Error(`${name} ${JSON.stringify(args)}: ${JSON.stringify(result.content)}`);
	return result.structuredContent ?? {};
}

async function hasFixture(device: string): Promise<boolean> {
	const listed = await call("mobile_list_apps", { device });
	return (listed.apps as Array<{ appId: string }>).some((app) => app.appId === APP_ID);
}

async function ios(udid: string): Promise<void> {
	const device = `ios:${udid}`;
	await call("mobile_boot_device", { device });
	passed.push("ios boot_device (disposable Simulator)");

	await call("mobile_install_app", { device, path: "Fixture.app" });
	assert.ok(await hasFixture(device), "fixture is listed after install");
	passed.push("ios install_app");

	await call("mobile_set_permission", { device, appId: APP_ID, permission: "photos", action: "grant" });
	await call("mobile_set_permission", { device, appId: APP_ID, permission: "photos", action: "revoke" });
	await call("mobile_set_permission", { device, appId: APP_ID, permission: "photos", action: "reset" });
	passed.push("ios set_permission photos grant -> revoke -> reset");

	await call("mobile_send_push", { device, appId: APP_ID, payload: { aps: { alert: "mobile-mcp live" } } });
	passed.push("ios send_push");

	await call("mobile_add_media", { device, paths: ["pixel.png"] });
	passed.push("ios add_media");

	await call("mobile_keychain", { device, action: "add-root-cert", path: "cert.pem" });
	await call("mobile_keychain", { device, action: "add-cert", path: "cert.pem" });
	await call("mobile_keychain", { device, action: "reset" });
	passed.push("ios keychain add-root-cert -> add-cert -> reset");

	await call("mobile_reset_app", { device, appId: APP_ID });
	assert.equal(await hasFixture(device), false, "iOS reset removes the app and its data");
	await call("mobile_install_app", { device, path: "Fixture.app" });
	await call("mobile_uninstall_app", { device, appId: APP_ID });
	assert.equal(await hasFixture(device), false, "fixture is gone after uninstall");
	passed.push("ios reset_app, uninstall_app");

	await call("mobile_shutdown_device", { device });
	assert.match(sh("xcrun", ["simctl", "list", "devices", udid]), /\(Shutdown\)/u);
	await call("mobile_boot_device", { device });
	const erased = await call("mobile_erase_device", { device });
	assert.equal(erased.erased, true);
	assert.match(sh("xcrun", ["simctl", "list", "devices", udid]), /\(Shutdown\)/u);
	passed.push("ios shutdown_device, erase_device (booted -> erased + shut down)");
}

async function android(): Promise<void> {
	const booted = await call("mobile_boot_device", { device: `android-avd:${AVD}`, timeoutSeconds: 300 });
	const device = String(booted.device);
	const serial = device.slice("android:".length);
	passed.push(`android boot_device (disposable AVD on ${serial})`);

	await call("mobile_install_app", { device, path: "fixture.apk" });
	assert.ok(await hasFixture(device), "fixture is listed after install");
	passed.push("android install_app");

	const camera = () => sh("adb", ["-s", serial, "shell", "dumpsys", "package", APP_ID]);
	await call("mobile_set_permission", { device, appId: APP_ID, permission: "android.permission.CAMERA", action: "grant" });
	assert.match(camera(), /android\.permission\.CAMERA: granted=true/u);
	await call("mobile_set_permission", { device, appId: APP_ID, permission: "android.permission.CAMERA", action: "revoke" });
	assert.doesNotMatch(camera(), /android\.permission\.CAMERA: granted=true/u);
	passed.push("android set_permission CAMERA grant -> revoke (checked in dumpsys)");

	await call("mobile_reset_app", { device, appId: APP_ID });
	assert.ok(await hasFixture(device), "Android reset keeps the app installed");
	passed.push("android reset_app");

	await call("mobile_send_sms", { device, phoneNumber: "5551234567", text: "mobile-mcp live" });
	passed.push("android send_sms");

	const setting = (namespace: string, key: string) =>
		sh("adb", ["-s", serial, "shell", "settings", "get", namespace, key]).trim();
	await call("mobile_set_connectivity", { device, target: "airplane", enabled: true });
	assert.equal(setting("global", "airplane_mode_on"), "1");
	await call("mobile_set_connectivity", { device, target: "airplane", enabled: false });
	assert.equal(setting("global", "airplane_mode_on"), "0");
	await call("mobile_set_connectivity", { device, target: "wifi", enabled: false });
	await call("mobile_set_connectivity", { device, target: "wifi", enabled: true });
	await call("mobile_set_connectivity", { device, target: "data", enabled: false });
	await call("mobile_set_connectivity", { device, target: "data", enabled: true });
	passed.push("android set_connectivity airplane/wifi/data off -> on");

	await call("mobile_add_media", { device, paths: ["pixel.png"] });
	assert.match(sh("adb", ["-s", serial, "shell", "ls", "/sdcard/Pictures"]), /pixel\.png/u);
	passed.push("android add_media");

	await call("mobile_uninstall_app", { device, appId: APP_ID });
	assert.equal(await hasFixture(device), false, "fixture is gone after uninstall");
	passed.push("android uninstall_app");

	const erase = (await client.callTool({ name: "mobile_erase_device", arguments: { device } })) as CallToolResult;
	assert.equal(erase.isError, true, "Android erase must be refused");
	assert.match(JSON.stringify(erase.content), /boot-time operation/u);
	passed.push("android erase_device is refused (wipe is boot-time only)");

	await call("mobile_shutdown_device", { device });
	passed.push("android shutdown_device");
}

let iosUdid: string | undefined;
let avdCreated = false;
try {
	await client.connect(transport);
	iosUdid = sh("xcrun", ["simctl", "create", "mobile-mcp-disposable", "iPhone 17 Pro Max"]).trim();
	sh(join(SDK, "cmdline-tools/latest/bin/avdmanager"), ["create", "avd", "-n", AVD, "-k", SYSTEM_IMAGE, "-d", "pixel_9a", "--force"], "no\n");
	avdCreated = true;
	await ios(iosUdid);
	await android();
	process.stdout.write(`${passed.map((line) => `PASS  ${line}`).join("\n")}\n\n${passed.length} destructive live checks passed\n`);
} catch (error) {
	process.stderr.write(`passed before failure:\n${passed.join("\n")}\n\nserver stderr tail:\n${stderr.slice(-4_000)}\n`);
	throw error;
} finally {
	await client.close().catch(() => undefined);
	// Cleanup must not hide the test result, so failures are reported, not thrown.
	const cleanup = (step: string, action: () => unknown) => {
		try {
			action();
		} catch (error) {
			process.stderr.write(`cleanup ${step} failed: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	};
	if (iosUdid) {
		const udid = iosUdid;
		if (sh("xcrun", ["simctl", "list", "devices", udid]).includes("(Booted)"))
			cleanup("shut down iOS Simulator", () => sh("xcrun", ["simctl", "shutdown", udid]));
		cleanup("delete iOS Simulator", () => sh("xcrun", ["simctl", "delete", udid]));
	}
	if (avdCreated) {
		for (const line of sh("adb", ["devices"]).split("\n")) {
			const serial = /^(emulator-\d+)\s/u.exec(line)?.[1];
			if (serial && sh("adb", ["-s", serial, "emu", "avd", "name"]).includes(AVD))
				cleanup(`kill ${serial}`, () => sh("adb", ["-s", serial, "emu", "kill"]));
		}
		cleanup("delete AVD", () =>
			sh(join(SDK, "cmdline-tools/latest/bin/avdmanager"), ["delete", "avd", "-n", AVD]),
		);
	}
	rmSync(root, { recursive: true, force: true });
}
