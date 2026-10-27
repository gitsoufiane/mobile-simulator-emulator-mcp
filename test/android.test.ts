import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AndroidController,
	KEYCODES,
	parseAndroidDisplaySize,
	parseAndroidForegroundApp,
	parseAndroidPackages,
	parseAndroidSnapshots,
	validateAndroidUiTree,
} from "../src/android.js";

test("reads package names from pm list packages output", () => {
	assert.deepEqual(
		parseAndroidPackages(
			"package:com.inspiren.inspiren\npackage:com.example.app\n\n",
		),
		["com.example.app", "com.inspiren.inspiren"],
	);
	assert.deepEqual(parseAndroidPackages(""), []);
});

test("falls back to mFocusedApp when the focused window is null", () => {
	// Real `adb shell dumpsys window` shape: a locked/animating device
	// reports mCurrentFocus=null while mFocusedApp still names the activity.
	assert.deepEqual(
		parseAndroidForegroundApp(
			"  mCurrentFocus=null\n  mFocusedApp=ActivityRecord{168505050 u0 com.inspiren.inspiren/.MainActivity t49}\n",
		),
		{ appId: "com.inspiren.inspiren", activity: ".MainActivity" },
	);

	assert.deepEqual(
		parseAndroidForegroundApp(
			"  mCurrentFocus=Window{d1c48e2 u0 com.example.app/com.example.app.MainActivity}\n",
		),
		{ appId: "com.example.app", activity: "com.example.app.MainActivity" },
	);

	assert.throws(
		() => parseAndroidForegroundApp("  mCurrentFocus=null\n"),
		/foreground app/u,
	);
});

test("never returns a failed UI dump as if it were the tree", () => {
	const remotePath = "/sdcard/mobile-mcp-ui.xml";
	const realTree = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0"/></hierarchy>`;

	assert.equal(
		validateAndroidUiTree(
			`UI hierchary dumped to: ${remotePath}`,
			realTree,
			remotePath,
		),
		realTree,
	);

	// Both native commands exit 0 on failure, so these outputs are the only
	// signal. A sleeping or locked device produces exactly these strings.
	assert.throws(
		() =>
			validateAndroidUiTree(
				"ERROR: null root node returned by UiTestAutomationBridge.",
				`cat: ${remotePath}: No such file or directory`,
				remotePath,
			),
		/could not dump the UI/u,
	);
	assert.throws(
		() => validateAndroidUiTree("", "", remotePath),
		/could not dump the UI/u,
	);
	assert.throws(
		() =>
			validateAndroidUiTree(
				`UI hierchary dumped to: ${remotePath}`,
				`cat: ${remotePath}: No such file or directory`,
				remotePath,
			),
		/no UI hierarchy/u,
	);
});

test("maps every supported key to an Android keycode", () => {
	for (const [key, code] of Object.entries(KEYCODES)) {
		assert.match(code, /^KEYCODE_[A-Z_]+$/u, `${key} maps to a real keycode`);
	}
	assert.equal(KEYCODES.DELETE, "KEYCODE_DEL");
	assert.equal(KEYCODES.APP_SWITCH, "KEYCODE_APP_SWITCH");
});

test("reads the rotated logical display size, not the physical panel", () => {
	// `dumpsys window displays` while locked to landscape (user-rotation 1).
	const displays =
		"  Display: mDisplayId=0 rootTasks=1\n    init=1080x2424 420dpi base=1080x2424 cur=2424x1080 app=2424x1010 rng=1080x1010-2424x2354\n";
	assert.deepEqual(parseAndroidDisplaySize(displays), {
		width: 2424,
		height: 1080,
	});
	assert.equal(parseAndroidDisplaySize("no display"), undefined);
});

test("lists emulator snapshot tags", () => {
	const listing =
		"List of snapshots present on all disks:\nID        TAG                 VM SIZE                DATE       VM CLOCK\n--        default_boot            72M 2026-09-10 13:20:05  367:07:58.218\n--        checkout_ready         80M 2026-09-27 18:01:00  001:02:03.000\nOK\n";
	assert.deepEqual(parseAndroidSnapshots(listing), [
		"default_boot",
		"checkout_ready",
	]);
	assert.deepEqual(parseAndroidSnapshots("OK\n"), []);
});

test("retries transient uiautomator dump failures, but not other failures", async () => {
	const remotePath = "/sdcard/mobile-mcp-ui.xml";
	const fake = (dumps: string[]) => {
		const controller = new AndroidController();
		let dumpCalls = 0;
		Object.assign(controller, {
			command: async (_serial: string, args: readonly string[]) => {
				if (args.includes("dump")) {
					const stderr = dumps[Math.min(dumpCalls, dumps.length - 1)] ?? "";
					dumpCalls += 1;
					return { stdout: "", stderr };
				}
				if (args.includes("cat"))
					return { stdout: "<hierarchy rotation=\"0\" />", stderr: "" };
				return { stdout: "", stderr: "" };
			},
		});
		return { controller, dumpCalls: () => dumpCalls };
	};
	const ok = `UI hierchary dumped to: ${remotePath}`;
	const nullRoot = "ERROR: null root node returned by UiTestAutomationBridge.";

	const recovers = fake([nullRoot, ok]);
	assert.match(await recovers.controller.uiTree("emulator-5554"), /<hierarchy/u);
	assert.equal(recovers.dumpCalls(), 2);

	const persistent = fake([nullRoot]);
	await assert.rejects(persistent.controller.uiTree("emulator-5554"), /null root node/u);
	assert.equal(persistent.dumpCalls(), 3);

	const locked = fake(["ERROR: screen is off"]);
	await assert.rejects(locked.controller.uiTree("emulator-5554"), /screen is off/u);
	assert.equal(locked.dumpCalls(), 1);
});

test("runs emulator console commands only on emulators", async () => {
	const controller = new AndroidController();
	const calls: string[][] = [];
	Object.assign(controller, {
		command: async (_serial: string, args: readonly string[]) => {
			calls.push([...args]);
			return { stdout: "OK\n", stderr: "" };
		},
	});
	await assert.rejects(
		controller.sendSms("R58M12345AB", "5551234", "hi"),
		/physical device; "sms" works only on Android Emulators/u,
	);
	await assert.rejects(controller.shutdown("192.168.1.20:5555"), /physical device/u);
	assert.deepEqual(calls, [], "no adb command reaches a physical device");
	await controller.sendSms("emulator-5554", "5551234", "hi");
	assert.deepEqual(calls, [["emu", "sms", "send", "5551234", "hi"]]);
});
