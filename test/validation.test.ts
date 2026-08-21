import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quoteAndroidShellArgument } from "../src/android.js";
import {
	parseBootDevice,
	parseOnlineDevice,
	validateAppIdentifier,
	validateAppPath,
	validateMediaPath,
	validatePermission,
	validatePushPayload,
	validateUrl,
} from "../src/server.js";

test("accepts only simulator and emulator device IDs", () => {
	assert.deepEqual(parseOnlineDevice("android:emulator-5554"), {
		platform: "android",
		target: "emulator-5554",
	});
	assert.deepEqual(
		parseOnlineDevice("ios:A8627257-2D08-47F0-A65B-C17F017A71CD"),
		{
			platform: "ios",
			target: "A8627257-2D08-47F0-A65B-C17F017A71CD",
		},
	);
	assert.deepEqual(parseBootDevice("android-avd:Pixel_9a"), {
		platform: "android",
		target: "Pixel_9a",
	});
	assert.throws(
		() => parseOnlineDevice("android:physical-device"),
		/Invalid online device ID/u,
	);
	assert.throws(() => parseBootDevice("android:emulator-5554"), /android-avd/u);
});

test("validates platform-specific app identifiers", () => {
	assert.equal(
		validateAppIdentifier("ios", "com.example.my-app"),
		"com.example.my-app",
	);
	assert.equal(
		validateAppIdentifier("android", "com.example.my_app"),
		"com.example.my_app",
	);
	assert.throws(
		() => validateAppIdentifier("android", "com.example.my-app"),
		/Invalid android/u,
	);
});

test("validates platform-specific permissions", () => {
	assert.equal(validatePermission("ios", "location-always"), "location-always");
	assert.equal(
		validatePermission("android", "android.permission.ACCESS_FINE_LOCATION"),
		"android.permission.ACCESS_FINE_LOCATION",
	);
	assert.throws(
		() => validatePermission("ios", "camera"),
		/Invalid ios permission/u,
	);
	assert.throws(
		() => validatePermission("android", "bad permission"),
		/Invalid android permission/u,
	);
});

test("validates APNs simulator payloads", () => {
	assert.deepEqual(validatePushPayload({ aps: { alert: "Hello" } }), {
		aps: { alert: "Hello" },
	});
	assert.throws(() => validatePushPayload({ alert: "Hello" }), /aps object/u);
	assert.throws(
		() => validatePushPayload({ aps: {}, body: "x".repeat(4_097) }),
		/4096 bytes/u,
	);
});

test("allows safe URLs and rejects dangerous schemes or credentials", () => {
	assert.equal(
		validateUrl("https://example.com/path?q=1"),
		"https://example.com/path?q=1",
	);
	const scriptUrl = "javascript".concat(":alert(1)");
	assert.throws(() => validateUrl(scriptUrl), /not allowed/u);
	assert.throws(
		() => validateUrl("https://user:secret@example.com"),
		/credentials/u,
	);
});

test("quotes Android remote-shell arguments without command injection", () => {
	assert.equal(
		quoteAndroidShellArgument("https://example.com/?q=a&next='; rm -rf /"),
		`'https://example.com/?q=a&next='\\''; rm -rf /'`,
	);
	assert.throws(
		() => quoteAndroidShellArgument("bad\ncommand"),
		/control characters/u,
	);
});

test("confines media paths and allows only media extensions", async () => {
	const base = await mkdtemp(join(tmpdir(), "mobile-mcp-media-"));
	const root = join(base, "root");
	const photo = join(root, "shot.PNG");
	const script = join(root, "payload.sh");
	const outside = join(base, "outside.png");
	const escape = join(root, "escape.png");
	const previousRoot = process.env.MOBILE_MCP_APP_ROOT;
	try {
		await mkdir(root);
		await mkdir(join(root, "album"));
		await Promise.all([
			writeFile(photo, "png"),
			writeFile(script, "#!/bin/sh"),
			writeFile(outside, "png"),
		]);
		await symlink(outside, escape);
		process.env.MOBILE_MCP_APP_ROOT = root;

		// Extension matching is case-insensitive.
		assert.equal(await validateMediaPath("shot.PNG"), await realpath(photo));
		await assert.rejects(() => validateMediaPath("payload.sh"), /must use one of/u);
		await assert.rejects(() => validateMediaPath("escape.png"), /beneath/u);
		await assert.rejects(
			() => validateMediaPath("album"),
			/must point to a file/u,
		);
		// The root itself is rejected before the file check.
		await assert.rejects(() => validateMediaPath("."), /beneath/u);
	} finally {
		if (previousRoot === undefined) delete process.env.MOBILE_MCP_APP_ROOT;
		else process.env.MOBILE_MCP_APP_ROOT = previousRoot;
		await rm(base, { recursive: true, force: true });
	}
});

test("confines app paths after resolving symlinks", async () => {
	const base = await mkdtemp(join(tmpdir(), "mobile-mcp-test-"));
	const root = join(base, "root");
	const safe = join(root, "safe.apk");
	const outside = join(base, "outside.apk");
	const escape = join(root, "escape.apk");
	const previousRoot = process.env.MOBILE_MCP_APP_ROOT;
	try {
		await mkdir(root);
		await Promise.all([writeFile(safe, "apk"), writeFile(outside, "apk")]);
		await symlink(outside, escape);
		process.env.MOBILE_MCP_APP_ROOT = root;
		assert.equal(
			await validateAppPath("android", "safe.apk"),
			await realpath(safe),
		);
		await assert.rejects(
			() => validateAppPath("android", "escape.apk"),
			/beneath/u,
		);
	} finally {
		if (previousRoot === undefined) delete process.env.MOBILE_MCP_APP_ROOT;
		else process.env.MOBILE_MCP_APP_ROOT = previousRoot;
		await rm(base, { recursive: true, force: true });
	}
});
