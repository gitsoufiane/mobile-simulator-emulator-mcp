import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../src/exec.js";
import {
	devicectlLaunchArgs,
	IosController,
	isAlreadyTerminated,
	isMissingDevicectlCommand,
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

// A made-up UDID in the physical-device format.
const phone = "00008030-001A2B3C4D5E6F70";
const simulator = "A8627257-2D08-47F0-A65B-C17F017A71CD";

/** An IosController whose simctl and devicectl calls are recorded, not run. */
function recorded(answers: { simctl?: string; devicectl?: string; json?: unknown } = {}) {
	const controller = new IosController();
	const calls: Array<{ tool: string; args: string[]; input?: string }> = [];
	Object.assign(controller, {
		simctl: async (args: string[], _timeout?: number, _buffer?: number, input?: string) => {
			calls.push({ tool: "simctl", args, ...(input === undefined ? {} : { input }) });
			return { stdout: answers.simctl ?? "", stderr: "" };
		},
		devicectl: async (udid: string, args: string[], input?: string) => {
			calls.push({ tool: "devicectl", args: [...args, "--device", udid], ...(input === undefined ? {} : { input }) });
			return answers.devicectl ?? "";
		},
		devicectlJson: async (args: string[]) => {
			calls.push({ tool: "devicectlJson", args });
			return answers.json ?? {};
		},
	});
	return { controller, calls };
}

test("reads an empty or non-text iPhone pasteboard without returning devicectl's notice", async () => {
	const fake = (items: unknown[]) => {
		const controller = new IosController();
		const pastes: string[][] = [];
		Object.assign(controller, {
			devicectlJson: async () => ({ items }),
			devicectl: async (_udid: string, args: string[]) => {
				pastes.push(args);
				return "Pasteboard is empty.\n";
			},
		});
		return { controller, pastes };
	};
	const empty = fake([]);
	assert.equal(await empty.controller.getClipboard(phone), "");
	assert.deepEqual(empty.pastes, [], "paste is never read for an empty pasteboard");

	const image = fake([{ flavors: [{ type: "public.png" }] }]);
	await assert.rejects(image.controller.getClipboard(phone), /holds no text \(public\.png\)/u);

	const text = fake([{ flavors: [{ type: "public.utf8-plain-text" }] }]);
	assert.equal(await text.controller.getClipboard(phone), "Pasteboard is empty.\n", "real text is returned as is");
	assert.deepEqual(text.pastes, [["device", "pasteboard", "paste"]]);
});

test("knows when devicectl lacks a subcommand, as before Xcode 27", () => {
	const failure = (stderr: string) =>
		new CommandError("devicectl failed", "xcrun", ["devicectl"], "", stderr);
	// Real devicectl output: with options after a missing subcommand it names
	// the first option; without options it lists the extra arguments.
	assert.equal(isMissingDevicectlCommand(failure("Error: Unknown option '--destination'")), true);
	assert.equal(isMissingDevicectlCommand(failure("Error: 2 unexpected arguments: 'capture', 'screenshot'")), true);
	assert.equal(isMissingDevicectlCommand(failure("ERROR: The device is locked.")), false);
	assert.equal(isMissingDevicectlCommand(new Error("Unknown option '--destination'")), false);
});

test("ends devicectl's options with -- so app arguments reach the app", () => {
	const args = devicectlLaunchArgs(phone, "com.example.app", { DEBUG: "1" }, [
		"-AppleLanguages",
		"(fr)",
		"--user",
		"root",
	]);
	const separator = args.indexOf("--");
	assert.ok(separator > args.indexOf("--environment-variables"), "devicectl options come first");
	assert.deepEqual(args.slice(separator), ["--", "com.example.app", "-AppleLanguages", "(fr)", "--user", "root"]);
});

test("never sends biometrics or the devicectl orientation to a real iPhone", async () => {
	const { controller, calls } = recorded();
	await assert.rejects(controller.setBiometric(phone, "unenroll"), /physical device/u);
	await assert.rejects(controller.setOrientation(phone, "landscape"), /physical device/u);
	assert.equal(calls.length, 0, "no devicectl command reaches the phone");
	await controller.setBiometric(simulator, "match");
	assert.deepEqual(calls[0]?.args, ["device", "simulate", "biometrics", "--success", "--device", simulator]);
});

test("keeps negative coordinates away from option parsing", async () => {
	const waypoints = [
		{ latitude: -33.87, longitude: 151.21 },
		{ latitude: -33.88, longitude: 151.22 },
	];
	const sim = recorded();
	await sim.controller.startLocationRoute(simulator, waypoints, 20);
	assert.deepEqual(sim.calls[0], {
		tool: "simctl",
		args: ["location", simulator, "start", "--speed=20", "-"],
		input: "-33.87,151.21\n-33.88,151.22\n",
	});

	const device = recorded();
	await device.controller.setLocation(phone, { latitude: -33.87, longitude: -70.5 });
	assert.deepEqual(device.calls[0]?.args, [
		"device", "simulate", "location", "coordinate", "--latitude=-33.87", "--longitude=-70.5", "--device", phone,
	]);
	await device.controller.startLocationRoute(phone, waypoints, 5);
	assert.deepEqual(device.calls[1]?.args.slice(0, 5), ["device", "simulate", "location", "route", "--route-file"]);
});

test("reports a Simulator pasteboard write that did not take", async () => {
	const stale = recorded({ simctl: "old text" });
	await assert.rejects(stale.controller.setClipboard(simulator, "new text"), /did not change/u);
	assert.deepEqual(stale.calls[0], { tool: "simctl", args: ["pbcopy", simulator], input: "new text" });
	const fresh = recorded({ simctl: "new text" });
	await fresh.controller.setClipboard(simulator, "new text");
});

test("maps iPhone text sizes to devicectl and reads the primary display scale", async () => {
	const { controller, calls } = recorded({
		json: { displays: [{ primary: false, pointScale: 1 }, { primary: true, pointScale: 3 }] },
	});
	await assert.rejects(controller.setContentSize(phone, "increment"), /named size/u);
	await controller.setContentSize(phone, "accessibility-large");
	assert.deepEqual(calls[0]?.args, [
		"device", "settings", "appearance", "--text-size", "accessibility-large",
		"--larger-accessibility-sizes", "on", "--device", phone,
	]);
	assert.equal(await controller.pointScale(phone), 3);
	assert.equal(await controller.pointScale(phone), 3);
	assert.equal(calls.filter((call) => call.tool === "devicectlJson").length, 1, "the scale is read once");
});
