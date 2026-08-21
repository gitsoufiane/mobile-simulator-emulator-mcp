import assert from "node:assert/strict";
import { test } from "node:test";
import {
	KEYCODES,
	parseAndroidForegroundApp,
	parseAndroidPackages,
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
