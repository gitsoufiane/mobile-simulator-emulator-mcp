import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../src/exec.js";
import {
	isAlreadyTerminated,
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
