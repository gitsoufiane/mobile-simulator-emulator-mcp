import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../src/exec.js";
import {
	isAlreadyTerminated,
	isPhysicalIosUdid,
	lowerVersion,
	parseIosApps,
	parseIosDevices,
	parseIosExecutable,
	parsePhysicalIosApps,
	parsePhysicalIosDevices,
	summarizeIosCrash,
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
			physical: false,
			version: "26.3",
		},
	]);
});

test("lists only physical iOS devices from devicectl", () => {
	// Shape taken from `xcrun devicectl list devices --json-output` on Xcode 27.
	const hardware = (udid: string, reality: string, platform = "iOS") => ({
		udid,
		reality,
		platform,
		marketingName: "iPhone 17",
	});
	const devices = parsePhysicalIosDevices([
		{
			connectionProperties: { pairingState: "paired" },
			hardwareProperties: hardware("00008030-001A2B3C4D5E6F70", "physical"),
			deviceProperties: { name: "Test Phone", osVersionNumber: "27.2", bootState: "booted" },
		},
		{
			connectionProperties: { pairingState: "unpaired" },
			hardwareProperties: hardware("a".repeat(40), "physical"),
			deviceProperties: { osVersionNumber: "16.7", bootState: "booted" },
		},
		{ hardwareProperties: hardware("311FAA01-086F-4DDF-BEC5-BEB4D86623AF", "simulated") },
		{ hardwareProperties: hardware("00008030-001A2B3C4D5E6F71", "physical", "watchOS") },
	]);
	assert.deepEqual(devices, [
		{
			id: "ios:00008030-001A2B3C4D5E6F70",
			name: "Test Phone",
			platform: "ios",
			state: "online",
			physical: true,
			version: "27.2",
		},
		{
			id: `ios:${"a".repeat(40)}`,
			name: "iPhone 17",
			platform: "ios",
			state: "offline",
			physical: true,
			version: "16.7",
		},
	]);
	assert.equal(isPhysicalIosUdid("A8627257-2D08-47F0-A65B-C17F017A71CD"), false);
});

test("separates user apps from Apple default apps on a physical device", () => {
	const apps = [
		{ bundleIdentifier: "com.apple.calculator", name: "Calculator", defaultApp: true, removable: true },
		{ bundleIdentifier: "com.apple.assistivetouchd", defaultApp: false, removable: false },
		{ bundleIdentifier: "com.example.app", name: "Example", defaultApp: false, removable: true },
	];
	assert.deepEqual(parsePhysicalIosApps(apps, false), [
		{ appId: "com.example.app", name: "Example", system: false },
	]);
	assert.equal(parsePhysicalIosApps(apps, true).length, 3);
});

test("summarizes only crash reports from the requested app and Simulator", () => {
	// Shape of ~/Library/Logs/DiagnosticReports/*.ips v2: JSON header line + JSON body.
	const udid = "A8627257-2D08-47F0-A65B-C17F017A71CD";
	const report = (bundleID: string, device: string) =>
		`${JSON.stringify({ bundleID, name: "Example", app_version: "1.2", timestamp: "2026-09-27 17:56:14.00 -0700", is_simulated: 1 })}\n${JSON.stringify(
			{
				coalitionName: `com.apple.CoreSimulator.SimDevice.${device}`,
				exception: { type: "EXC_CRASH", signal: "SIGABRT" },
				termination: { namespace: "SIGNAL", indicator: "Abort trap: 6" },
				faultingThread: 1,
				usedImages: [{ name: "libsystem_kernel.dylib" }, { name: "Example" }],
				threads: [
					{ frames: [] },
					{
						frames: [
							{ imageIndex: 0, symbol: "__pthread_kill" },
							{ imageIndex: 1, imageOffset: 4242 },
						],
					},
				],
			},
		)}`;

	const summary = summarizeIosCrash(report("com.example.app", udid), "com.example.app", udid);
	assert.ok(summary);
	assert.match(summary, /EXC_CRASH SIGABRT/u);
	assert.match(summary, /Termination: SIGNAL Abort trap: 6/u);
	assert.match(summary, /0 __pthread_kill \(libsystem_kernel\.dylib\)/u);
	assert.match(summary, /1 \+4242 \(Example\)/u);
	assert.equal(summarizeIosCrash(report("com.other.app", udid), "com.example.app", udid), undefined);
	assert.equal(
		summarizeIosCrash(report("com.example.app", "D6B004BB-D816-4CE4-A043-705FB97867C3"), "com.example.app", udid),
		undefined,
	);
	assert.equal(summarizeIosCrash("Incident Identifier: legacy text", "com.example.app", udid), undefined);
});

test("picks the lower version so the WDA build target fits the installed SDK", () => {
	assert.equal(lowerVersion("27.2", "27.1"), "27.1");
	assert.equal(lowerVersion("26.3", "27.1"), "26.3");
	assert.equal(lowerVersion("27", "27.0"), "27");
	assert.equal(lowerVersion("17.10", "17.9"), "17.9");
});
