import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../src/exec.js";
import {
	isAlreadyTerminated,
	parseIosApps,
	parseIosDevices,
	parseIosExecutable,
	type SimctlList,
} from "../src/ios.js";

test("recognizes an already-terminated iOS app", () => {
	const error = new CommandError(
		"simctl failed",
		"xcrun",
		["simctl", "terminate"],
		"",
		"found nothing to terminate",
	);
	assert.equal(isAlreadyTerminated(error), true);
	assert.equal(
		isAlreadyTerminated(new Error("found nothing to terminate")),
		false,
	);
});

test("reads an iOS app executable from simctl appinfo", () => {
	assert.equal(
		parseIosExecutable(`{\n    CFBundleExecutable = "Example App";\n}`),
		"Example App",
	);
	assert.throws(() => parseIosExecutable("{}"), /CFBundleExecutable/u);
});

test("separates user apps from system apps in simctl listapps output", () => {
	// Shape taken from `xcrun simctl listapps <udid> | plutil -convert json`.
	const json = JSON.stringify({
		"com.apple.Bridge": {
			ApplicationType: "System",
			CFBundleDisplayName: "Watch",
		},
		"com.inspiren.augi": {
			ApplicationType: "User",
			CFBundleDisplayName: "Inspiren",
		},
		"com.example.nameless": { ApplicationType: "User" },
	});

	assert.deepEqual(parseIosApps(json, false), [
		{
			appId: "com.example.nameless",
			name: "com.example.nameless",
			system: false,
		},
		{ appId: "com.inspiren.augi", name: "Inspiren", system: false },
	]);
	assert.equal(parseIosApps(json, true).length, 3);
	assert.equal(
		parseIosApps(json, true).find((app) => app.appId === "com.apple.Bridge")
			?.system,
		true,
	);
	assert.throws(() => parseIosApps("not json", false), /invalid JSON/u);
});

test("lists only available iOS simulator runtimes", () => {
	const devices: SimctlList = {
		devices: {
			"com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
				{ udid: "IOS-1", name: "iPhone", state: "Booted", isAvailable: true },
				{
					udid: "IOS-2",
					name: "Unavailable",
					state: "Shutdown",
					isAvailable: false,
				},
			],
			"com.apple.CoreSimulator.SimRuntime.watchOS-26-3": [
				{
					udid: "WATCH-1",
					name: "Apple Watch",
					state: "Booted",
					isAvailable: true,
				},
			],
		},
	};

	assert.deepEqual(parseIosDevices(devices), [
		{
			id: "ios:IOS-1",
			name: "iPhone",
			platform: "ios",
			state: "online",
			version: "26.3",
		},
	]);
});
