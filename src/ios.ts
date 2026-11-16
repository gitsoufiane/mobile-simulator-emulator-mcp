import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError, run, sleep, tailLines } from "./exec.js";

/** A screen recording that runs until stop() finalizes the file. */
export interface Recording {
	stop(): Promise<void>;
}

export type IosBiometricAction = "enroll" | "unenroll" | "match" | "fail";
export type IosOrientation =
	| "portrait"
	| "landscape"
	| "landscape-right"
	| "portrait-upside-down";

/** `devicectl device orientation set` names. */
const DEVICECTL_ORIENTATIONS: Record<IosOrientation, string> = {
	portrait: "portrait",
	landscape: "landscapeLeft",
	"landscape-right": "landscapeRight",
	"portrait-upside-down": "portraitUpsideDown",
};

const CRASH_FRAME_LIMIT = 25;

const CLIPBOARD_CHECKS = 4;
const CLIPBOARD_CHECK_MS = 250;

/** The text types `devicectl device pasteboard paste` reads, in its own order. */
const PASTEBOARD_TEXT_TYPES = new Set([
	"public.utf8-plain-text",
	"public.plain-text",
	"public.text",
	"public.url",
]);

/** Real iPhone and iPad UDIDs: `00008030-001A2B3C4D5E6F70` or 40 hex digits. */
const PHYSICAL_IOS_UDID = /^(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9A-F]{40})$/iu;

/** The lower of two dotted versions; non-numeric parts compare as 0. */
export function lowerVersion(left: string, right: string): string {
	const parts = (value: string) => value.split(".").map((part) => Number(part) || 0);
	const [a, b] = [parts(left), parts(right)];
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference < 0 ? left : right;
	}
	return left;
}

export function isPhysicalIosUdid(udid: string): boolean {
	return PHYSICAL_IOS_UDID.test(udid);
}

/**
 * Whether devicectl lacks a subcommand, as before Xcode 27. With options
 * after the missing subcommand, devicectl names the first option instead.
 */
export function isMissingDevicectlCommand(error: unknown): error is CommandError {
	return (
		error instanceof CommandError &&
		/unexpected argument|unknown option|not a valid|unknown (sub)?command/iu.test(
			error.stderr + error.stdout,
		)
	);
}

/** `--` ends devicectl's own options, so app arguments such as -AppleLanguages or --user reach the app. */
export function devicectlLaunchArgs(
	udid: string,
	bundleId: string,
	environment: Record<string, string> | undefined,
	appArguments: readonly string[],
): string[] {
	return [
		"devicectl",
		"device",
		"process",
		"launch",
		"--device",
		udid,
		"--terminate-existing",
		...(environment
			? ["--environment-variables", JSON.stringify(environment)]
			: []),
		"--",
		bundleId,
		...appArguments,
	];
}

function assertSimulator(udid: string): void {
	if (isPhysicalIosUdid(udid))
		throw new Error(
			`ios:${udid} is a physical device; this control works only on iOS Simulators`,
		);
}

/**
 * Summarizes one `.ips` crash report if it belongs to `bundleId` on the
 * Simulator `udid`. Simulator crashes land in the host DiagnosticReports
 * folder; `coalitionName` is the only field that names the Simulator.
 */
export function summarizeIosCrash(
	text: string,
	bundleId: string,
	udid: string,
): string | undefined {
	const newline = text.indexOf("\n");
	if (newline === -1) return undefined;
	let header: Record<string, unknown>;
	let body: Record<string, unknown>;
	try {
		header = JSON.parse(text.slice(0, newline)) as Record<string, unknown>;
		body = JSON.parse(text.slice(newline + 1)) as Record<string, unknown>;
	} catch {
		// Not an .ips v2 JSON report (older text format); it cannot be attributed.
		return undefined;
	}
	if (
		header.bundleID !== bundleId ||
		body.coalitionName !== `com.apple.CoreSimulator.SimDevice.${udid}`
	)
		return undefined;
	const exception = (body.exception ?? {}) as Record<string, unknown>;
	const termination = (body.termination ?? {}) as Record<string, unknown>;
	const images = Array.isArray(body.usedImages)
		? (body.usedImages as Array<{ name?: unknown }>)
		: [];
	const threads = Array.isArray(body.threads)
		? (body.threads as Array<{ frames?: unknown }>)
		: [];
	const faulting =
		typeof body.faultingThread === "number" ? body.faultingThread : 0;
	const frames = Array.isArray(threads[faulting]?.frames)
		? (threads[faulting].frames as Array<Record<string, unknown>>)
		: [];
	const lines = [
		`${String(header.timestamp ?? "unknown time")} ${String(header.name ?? bundleId)} ${String(header.app_version ?? "")}`.trim(),
		`Exception: ${[exception.type, exception.signal, exception.subtype].filter(Boolean).join(" ")}`,
		...(exception.message ? [`Message: ${String(exception.message)}`] : []),
		...(termination.indicator || termination.namespace
			? [
					`Termination: ${[termination.namespace, termination.indicator].filter(Boolean).join(" ")}`,
				]
			: []),
		`Faulting thread ${faulting}:`,
		...frames.slice(0, CRASH_FRAME_LIMIT).map((frame, index) => {
			const image =
				typeof frame.imageIndex === "number"
					? images[frame.imageIndex]?.name
					: undefined;
			return `  ${index} ${String(frame.symbol ?? `+${String(frame.imageOffset ?? "?")}`)} (${String(image ?? "?")})`;
		}),
	];
	return lines.join("\n");
}

export interface SimctlDevice {
	udid: string;
	name: string;
	state: string;
	isAvailable?: boolean;
}

export interface SimctlList {
	devices?: Record<string, SimctlDevice[]>;
}

export interface IosDevice {
	id: string;
	name: string;
	platform: "ios";
	state: "online" | "offline" | "shutdown";
	physical: boolean;
	version: string;
}

/** One entry of `devicectl list devices`; these fields exist from Xcode 15 on. */
interface DevicectlDevice {
	connectionProperties?: { pairingState?: string };
	hardwareProperties?: { udid?: string; platform?: string; reality?: string; marketingName?: string };
	deviceProperties?: { name?: string; osVersionNumber?: string; bootState?: string };
}

export function parsePhysicalIosDevices(devices: readonly DevicectlDevice[]): IosDevice[] {
	return devices.flatMap(({ connectionProperties, hardwareProperties, deviceProperties }) => {
		const udid = hardwareProperties?.udid;
		if (hardwareProperties?.reality !== "physical" || hardwareProperties.platform !== "iOS" || !udid)
			return [];
		return [
			{
				id: `ios:${udid}`,
				name: deviceProperties?.name ?? hardwareProperties.marketingName ?? udid,
				platform: "ios" as const,
				state:
					connectionProperties?.pairingState === "paired" &&
					deviceProperties?.bootState === "booted"
						? ("online" as const)
						: ("offline" as const),
				physical: true,
				version: deviceProperties?.osVersionNumber ?? "unknown",
			},
		];
	});
}

interface DevicectlApp {
	bundleIdentifier?: string;
	name?: string;
	defaultApp?: boolean;
	removable?: boolean;
	url?: string;
}

export function parsePhysicalIosApps(
	apps: readonly DevicectlApp[],
	includeSystem: boolean,
): MobileApp[] {
	return apps
		.flatMap((app) => {
			if (!app.bundleIdentifier) return [];
			const system = app.defaultApp === true || app.removable === false;
			if (system && !includeSystem) return [];
			return [{ appId: app.bundleIdentifier, name: app.name || app.bundleIdentifier, system }];
		})
		.sort((left, right) => left.appId.localeCompare(right.appId));
}

/** Cross-platform installed-app record shared with the Android controller. */
export interface MobileApp {
	appId: string;
	name: string;
	system: boolean;
}

export function parseIosApps(
	json: string,
	includeSystem: boolean,
): MobileApp[] {
	let parsed: Record<string, Record<string, unknown>>;
	try {
		parsed = JSON.parse(json) as Record<string, Record<string, unknown>>;
	} catch (error) {
		throw new Error(
			`simctl listapps returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return Object.entries(parsed)
		.flatMap(([appId, info]) => {
			const system = info.ApplicationType !== "User";
			if (system && !includeSystem) return [];
			const display = info.CFBundleDisplayName ?? info.CFBundleName;
			return [
				{
					appId,
					name: typeof display === "string" && display ? display : appId,
					system,
				},
			];
		})
		.sort((left, right) => left.appId.localeCompare(right.appId));
}

export function isAlreadyTerminated(error: unknown): boolean {
	return (
		error instanceof CommandError &&
		error.stderr.includes("found nothing to terminate")
	);
}

export function parseIosExecutable(appInfo: string): string {
	const match = /CFBundleExecutable = (?:"([^"]+)"|([^;]+));/u.exec(appInfo);
	const executable = (match?.[1] ?? match?.[2])?.trim();
	if (!executable)
		throw new Error("simctl appinfo did not return CFBundleExecutable");
	return executable;
}

function runtimeVersion(runtime: string): string {
	const suffix = runtime.split(".SimRuntime.iOS-").at(-1) ?? runtime;
	return suffix.replaceAll("-", ".");
}

export function parseIosDevices(parsed: SimctlList): IosDevice[] {
	return Object.entries(parsed.devices ?? {}).flatMap(([runtime, devices]) => {
		if (!runtime.includes(".SimRuntime.iOS-")) return [];
		return devices.flatMap((device) =>
			device.isAvailable === false
				? []
				: [
						{
							id: `ios:${device.udid}`,
							name: device.name,
							platform: "ios" as const,
							state:
								device.state === "Booted"
									? ("online" as const)
									: ("shutdown" as const),
							physical: false,
							version: runtimeVersion(runtime),
						},
					],
		);
	});
}

export class IosController {
	private readonly pointScales = new Map<string, number>();

	private simctl(
		args: readonly string[],
		timeoutMs = 30_000,
		maxBuffer = 2 * 1024 * 1024,
		input?: string,
	) {
		// Safety net: every simctl subcommand here takes the target UDID.
		for (const arg of args) assertSimulator(arg);
		return run("xcrun", ["simctl", ...args], {
			timeoutMs,
			maxBuffer,
			...(input === undefined ? {} : { input }),
		});
	}

	private async devicectlJson<T>(args: readonly string[]): Promise<T> {
		const output = join(tmpdir(), `mobile-mcp-${randomUUID()}.json`);
		try {
			await run("xcrun", ["devicectl", ...args, "--quiet", "--json-output", output], {
				timeoutMs: 60_000,
			});
			return (JSON.parse(await readFile(output, "utf8")) as { result: T }).result;
		} finally {
			// safe to ignore: temp cleanup must not hide the devicectl result.
			await unlink(output).catch(() => undefined);
		}
	}

	async listPhysicalDevices(): Promise<IosDevice[]> {
		const { devices } = await this.devicectlJson<{ devices?: DevicectlDevice[] }>([
			"list",
			"devices",
		]);
		return parsePhysicalIosDevices(devices ?? []);
	}

	/**
	 * Deployment target for building WDA onto a device. A device may run a
	 * newer iOS than the installed SDK, and xcodebuild rejects such a target.
	 */
	async deviceBuildVersion(deviceVersion: string): Promise<string> {
		const { stdout } = await run("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"]);
		return lowerVersion(deviceVersion, stdout.trim());
	}

	/** IPv6 address of the CoreDevice tunnel; devicectl brings the tunnel up first. */
	async tunnelAddress(udid: string): Promise<string> {
		const details = await this.devicectlJson<{
			connectionProperties?: { tunnelIPAddress?: string };
		}>(["device", "info", "details", "--device", udid]);
		const address = details.connectionProperties?.tunnelIPAddress;
		if (!address)
			throw new Error(
				`ios:${udid} has no CoreDevice tunnel. Connect it by USB or the same network, unlock it, and trust this Mac.`,
			);
		return address;
	}

	async listDevices(): Promise<IosDevice[]> {
		const [simulators, physical] = await Promise.all([
			this.listSimulators(),
			this.listPhysicalDevices(),
		]);
		return [...simulators, ...physical];
	}

	private async listSimulators(): Promise<IosDevice[]> {
		const { stdout } = await this.simctl(["list", "devices", "--json"]);
		let parsed: SimctlList;
		try {
			parsed = JSON.parse(stdout) as SimctlList;
		} catch (error) {
			throw new Error(
				`simctl returned invalid device JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return parseIosDevices(parsed);
	}

	async getDevice(udid: string): Promise<IosDevice> {
		const devices = isPhysicalIosUdid(udid)
			? await this.listPhysicalDevices()
			: await this.listSimulators();
		const found = devices.find((device) => device.id === `ios:${udid}`);
		if (!found) throw new Error(`ios:${udid} is not available`);
		return found;
	}

	async boot(udid: string, timeoutMs: number): Promise<void> {
		const device = await this.getDevice(udid);
		if (device.state !== "online") await this.simctl(["boot", udid], timeoutMs);
		await this.simctl(["bootstatus", udid, "-b"], timeoutMs);
	}

	async shutdown(udid: string): Promise<void> {
		const device = await this.getDevice(udid);
		if (device.state === "online") await this.simctl(["shutdown", udid]);
	}

	async install(udid: string, appPath: string): Promise<void> {
		if (isPhysicalIosUdid(udid))
			await run("xcrun", ["devicectl", "device", "install", "app", "--device", udid, appPath], {
				timeoutMs: 300_000,
			});
		else await this.simctl(["install", udid, appPath], 120_000);
	}

	async launch(
		udid: string,
		bundleId: string,
		options: {
			arguments?: readonly string[];
			environment?: Record<string, string>;
			locale?: string;
		} = {},
	): Promise<void> {
		// Foundation reads these argument-domain defaults for per-launch language.
		const localeArgs = options.locale
			? [
					"-AppleLanguages",
					`(${options.locale.replaceAll("_", "-")})`,
					"-AppleLocale",
					options.locale.replaceAll("-", "_"),
				]
			: [];
		if (isPhysicalIosUdid(udid)) {
			await run(
				"xcrun",
				devicectlLaunchArgs(udid, bundleId, options.environment, [
					...localeArgs,
					...(options.arguments ?? []),
				]),
				{ timeoutMs: 60_000 },
			);
			return;
		}
		// simctl forwards SIMCTL_CHILD_<NAME> host variables to the launched app.
		const childEnv = Object.fromEntries(
			Object.entries(options.environment ?? {}).map(([key, value]) => [
				`SIMCTL_CHILD_${key}`,
				value,
			]),
		);
		await run(
			"xcrun",
			[
				"simctl",
				"launch",
				"--terminate-running-process",
				udid,
				bundleId,
				...localeArgs,
				...(options.arguments ?? []),
			],
			{ env: { ...process.env, ...childEnv } },
		);
	}

	/** CoreDevice control; Xcode 27 `devicectl` also drives Simulators. */
	private async devicectl(
		udid: string,
		args: readonly string[],
		input?: string,
	): Promise<string> {
		try {
			const { stdout } = await run(
				"xcrun",
				["devicectl", ...args, "--device", udid],
				{ timeoutMs: 60_000, ...(input === undefined ? {} : { input }) },
			);
			return stdout;
		} catch (error) {
			if (isMissingDevicectlCommand(error))
				throw new Error(
					`This control needs Xcode 27 or newer (xcrun devicectl ${args.slice(0, 3).join(" ")}); ${error.message}`,
				);
			throw error;
		}
	}

	async setBiometric(udid: string, action: IosBiometricAction): Promise<void> {
		// On a device this would change the owner's real Face ID enrollment.
		assertSimulator(udid);
		const args = {
			enroll: ["device", "settings", "biometrics", "--enable"],
			unenroll: ["device", "settings", "biometrics", "--disable"],
			match: ["device", "simulate", "biometrics", "--success"],
			fail: ["device", "simulate", "biometrics", "--failure"],
		}[action];
		await this.devicectl(udid, args);
	}

	async setOrientation(udid: string, orientation: IosOrientation): Promise<void> {
		assertSimulator(udid);
		await this.devicectl(udid, [
			"device",
			"orientation",
			"set",
			DEVICECTL_ORIENTATIONS[orientation],
		]);
	}

	async setMotionAndTransparency(
		udid: string,
		settings: { reduceMotion?: boolean; reduceTransparency?: boolean },
	): Promise<void> {
		const onOff = (value: boolean) => (value ? "on" : "off");
		await this.deviceAppearance(udid, [
			...(settings.reduceMotion === undefined
				? []
				: ["--reduce-motion", onOff(settings.reduceMotion)]),
			...(settings.reduceTransparency === undefined
				? []
				: ["--reduce-transparency", onOff(settings.reduceTransparency)]),
		]);
	}

	async setVoiceOver(udid: string, enabled: boolean): Promise<void> {
		await this.devicectl(udid, [
			"device",
			"settings",
			"voiceover",
			enabled ? "--enable" : "--disable",
		]);
	}

	async startLocationRoute(
		udid: string,
		waypoints: ReadonlyArray<{ latitude: number; longitude: number }>,
		speedMetersPerSecond: number,
	): Promise<void> {
		if (isPhysicalIosUdid(udid)) {
			const routeFile = join(tmpdir(), `mobile-mcp-${randomUUID()}.json`);
			try {
				await writeFile(
					routeFile,
					JSON.stringify({
						mode: "interval",
						interval: 1,
						speed: speedMetersPerSecond,
						waypoints,
					}),
				);
				await this.devicectl(udid, [
					"device",
					"simulate",
					"location",
					"route",
					"--route-file",
					routeFile,
				]);
			} finally {
				await unlink(routeFile).catch(() => undefined);
			}
			return;
		}
		// simctl parses a negative latitude argument ("-33.8,151.2") as an
		// option, so the waypoints go through stdin, one per line.
		await this.simctl(
			["location", udid, "start", `--speed=${speedMetersPerSecond}`, "-"],
			30_000,
			2 * 1024 * 1024,
			`${waypoints.map(({ latitude, longitude }) => `${latitude},${longitude}`).join("\n")}\n`,
		);
	}

	async keychain(
		udid: string,
		action: "add-root-cert" | "add-cert" | "reset",
		certificatePath?: string,
	): Promise<void> {
		await this.simctl([
			"keychain",
			udid,
			action,
			...(certificatePath ? [certificatePath] : []),
		]);
	}

	/**
	 * simctl (Simulator) and devicectl (device, Xcode 27) both record until
	 * SIGINT, then finalize the file and exit 0. simctl announces the start on
	 * stderr and devicectl on stdout.
	 */
	async startVideo(udid: string, outputPath: string): Promise<Recording> {
		const args = isPhysicalIosUdid(udid)
			? ["devicectl", "device", "capture", "screen-record", "--device", udid, "--destination", outputPath]
			: ["simctl", "io", udid, "recordVideo", "--codec=h264", outputPath];
		const child = spawn("xcrun", args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const exited = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		const started = new Promise<void>((resolve) => {
			const collect = (chunk: Buffer) => {
				if (output.length < 10_000) output += chunk.toString();
				if (output.includes("Recording started")) resolve();
			};
			child.stdout.on("data", collect);
			child.stderr.on("data", collect);
		});
		const startTimeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
		try {
			const first = await Promise.race([started.then(() => "started"), exited]);
			if (first !== "started")
				throw new Error(`xcrun ${args[0]} recording did not start: ${output.trim()}`);
		} catch (error) {
			if (child.exitCode === null) child.kill("SIGKILL");
			throw error;
		} finally {
			clearTimeout(startTimeout);
		}
		return {
			stop: async () => {
				child.kill("SIGINT");
				const stopTimeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
				try {
					const code = await exited;
					if (code !== 0)
						throw new Error(
							`xcrun ${args[0]} recording exited with ${String(code)}: ${output.trim()}`,
						);
				} finally {
					clearTimeout(stopTimeout);
				}
			},
		};
	}

	async crashReports(
		udid: string,
		bundleId: string,
		sinceMinutes: number,
	): Promise<string[]> {
		assertSimulator(udid);
		const folder = join(homedir(), "Library", "Logs", "DiagnosticReports");
		const since = Date.now() - sinceMinutes * 60_000;
		const names = await readdir(folder).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		});
		const recent = (
			await Promise.all(
				names
					.filter((name) => name.endsWith(".ips"))
					.map(async (name) => {
						const path = join(folder, name);
						const { mtimeMs } = await stat(path);
						return { path, mtimeMs };
					}),
			)
		)
			.filter(({ mtimeMs }) => mtimeMs >= since)
			.sort((left, right) => right.mtimeMs - left.mtimeMs);
		const summaries = await Promise.all(
			recent.map(async ({ path }) =>
				summarizeIosCrash(await readFile(path, "utf8"), bundleId, udid),
			),
		);
		return summaries.filter((summary): summary is string => Boolean(summary));
	}

	private async physicalApps(udid: string, extra: readonly string[] = []): Promise<DevicectlApp[]> {
		const { apps } = await this.devicectlJson<{ apps?: DevicectlApp[] }>([
			"device",
			"info",
			"apps",
			"--device",
			udid,
			"--include-all-apps",
			...extra,
		]);
		return apps ?? [];
	}

	/** devicectl terminates by PID, so match running executables to the app bundle path. */
	private async terminatePhysical(udid: string, bundleId: string): Promise<void> {
		const [app] = await this.physicalApps(udid, ["--bundle-id", bundleId]);
		if (!app?.url) throw new Error(`${bundleId} is not installed on ios:${udid}`);
		const { runningProcesses } = await this.devicectlJson<{
			runningProcesses?: Array<{ executable?: string; processIdentifier?: number }>;
		}>(["device", "info", "processes", "--device", udid]);
		for (const entry of runningProcesses ?? []) {
			if (!entry.executable?.startsWith(app.url) || entry.processIdentifier === undefined)
				continue;
			await run(
				"xcrun",
				[
					"devicectl",
					"device",
					"process",
					"terminate",
					"--device",
					udid,
					"--pid",
					String(entry.processIdentifier),
				],
				{ timeoutMs: 60_000 },
			);
		}
	}

	async terminate(udid: string, bundleId: string): Promise<void> {
		if (isPhysicalIosUdid(udid)) return this.terminatePhysical(udid, bundleId);
		await this.simctl(["terminate", udid, bundleId]).catch((error: unknown) => {
			if (!isAlreadyTerminated(error)) throw error;
		});
	}

	async resetAppData(udid: string, bundleId: string): Promise<void> {
		await this.uninstall(udid, bundleId);
	}

	async uninstall(udid: string, bundleId: string): Promise<void> {
		if (isPhysicalIosUdid(udid))
			await run("xcrun", ["devicectl", "device", "uninstall", "app", "--device", udid, bundleId], {
				timeoutMs: 120_000,
			});
		else await this.simctl(["uninstall", udid, bundleId]);
	}

	async erase(udid: string): Promise<void> {
		await this.shutdown(udid);
		await this.simctl(["erase", udid], 120_000);
	}

	async getLogs(
		udid: string,
		bundleId: string,
		sinceMinutes: number,
		maxLines: number,
	): Promise<string> {
		const appInfo = await this.simctl(["appinfo", udid, bundleId]);
		const executable = parseIosExecutable(appInfo.stdout);
		const { stdout } = await this.simctl(
			[
				"spawn",
				udid,
				"log",
				"show",
				"--style",
				"compact",
				"--last",
				`${sinceMinutes}m`,
				"--process",
				executable,
			],
			30_000,
			// `--last 60m` on a chatty process (e.g. CFNetwork debug spam) can
			// produce well over the previous 4 MB cap before it's sliced down
			// to maxLines below, so simctl gets killed for exceeding maxBuffer.
			32 * 1024 * 1024,
		);
		return tailLines(stdout, maxLines);
	}

	async listApps(udid: string, includeSystem: boolean): Promise<MobileApp[]> {
		if (isPhysicalIosUdid(udid))
			return parsePhysicalIosApps(await this.physicalApps(udid), includeSystem);
		const { stdout } = await this.simctl(
			["listapps", udid],
			30_000,
			16 * 1024 * 1024,
		);
		// simctl emits an old-style plist; plutil is Apple's supported converter.
		const { stdout: json } = await run(
			"plutil",
			["-convert", "json", "-o", "-", "-"],
			{ input: stdout, maxBuffer: 16 * 1024 * 1024 },
		);
		return parseIosApps(json, includeSystem);
	}

	async getAppearance(udid: string): Promise<string> {
		return (await this.simctl(["ui", udid, "appearance"])).stdout.trim();
	}

	/** Xcode 27 `devicectl device settings appearance`, for Simulators and devices. */
	private async deviceAppearance(udid: string, flags: readonly string[]): Promise<void> {
		await this.devicectl(udid, ["device", "settings", "appearance", ...flags]);
	}

	async setAppearance(udid: string, mode: "light" | "dark"): Promise<void> {
		if (isPhysicalIosUdid(udid)) await this.deviceAppearance(udid, ["--mode", mode]);
		else await this.simctl(["ui", udid, "appearance", mode]);
	}

	async setContentSize(udid: string, size: string): Promise<void> {
		if (!isPhysicalIosUdid(udid)) {
			await this.simctl(["ui", udid, "content_size", size]);
			return;
		}
		if (size === "increment" || size === "decrement")
			throw new Error(
				`contentSize ${size} works only on iOS Simulators; pass a named size on a device`,
			);
		await this.deviceAppearance(udid, [
			"--text-size",
			size,
			...(size.startsWith("accessibility-")
				? ["--larger-accessibility-sizes", "on"]
				: []),
		]);
	}

	async setIncreaseContrast(udid: string, enabled: boolean): Promise<void> {
		if (isPhysicalIosUdid(udid))
			await this.deviceAppearance(udid, ["--increase-contrast", enabled ? "on" : "off"]);
		else
			await this.simctl([
				"ui",
				udid,
				"increase_contrast",
				enabled ? "enabled" : "disabled",
			]);
	}

	async addMedia(udid: string, paths: readonly string[]): Promise<void> {
		await this.simctl(["addmedia", udid, ...paths], 120_000);
	}

	async setPermission(
		udid: string,
		bundleId: string,
		service: string,
		action: "grant" | "revoke" | "reset",
	): Promise<void> {
		await this.simctl(["privacy", udid, action, service, bundleId]);
	}

	async setLocation(
		udid: string,
		location?: { latitude: number; longitude: number },
	): Promise<void> {
		if (isPhysicalIosUdid(udid)) {
			// The `=` form keeps devicectl from reading a negative value as an option.
			await this.devicectl(
				udid,
				location
					? [
							"device",
							"simulate",
							"location",
							"coordinate",
							`--latitude=${location.latitude}`,
							`--longitude=${location.longitude}`,
						]
					: ["device", "simulate", "location", "clear"],
			);
			return;
		}
		await this.simctl(
			location
				? [
						"location",
						udid,
						"set",
						`${location.latitude},${location.longitude}`,
					]
				: ["location", udid, "clear"],
		);
	}

	async sendPush(
		udid: string,
		bundleId: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		const output = join(tmpdir(), `mobile-mcp-${randomUUID()}.apns`);
		try {
			await writeFile(output, JSON.stringify(payload));
			await this.simctl(["push", udid, bundleId, output]);
		} finally {
			await unlink(output).catch(() => undefined);
		}
	}

	async setClipboard(udid: string, text: string): Promise<void> {
		if (isPhysicalIosUdid(udid))
			await this.devicectl(udid, ["device", "pasteboard", "copy"], text);
		else await this.simctl(["pbcopy", udid], 30_000, 2 * 1024 * 1024, text);
		// After `devicectl device pasteboard copy` has targeted a Simulator,
		// `simctl pbcopy` exits 0 without changing it until the next boot. A
		// busy Simulator can also show a good write late, so check a few times.
		for (let check = 1; (await this.getClipboard(udid)) !== text; check += 1) {
			if (check === CLIPBOARD_CHECKS)
				throw new Error(
					`The pasteboard of ios:${udid} did not change. If devicectl wrote to this Simulator's pasteboard, shut the Simulator down, boot it, and retry.`,
				);
			await sleep(CLIPBOARD_CHECK_MS);
		}
	}

	async getClipboard(udid: string): Promise<string> {
		if (!isPhysicalIosUdid(udid)) return (await this.simctl(["pbpaste", udid])).stdout;
		// `paste` prints a notice such as "Pasteboard is empty." in place of
		// text, so the stable JSON of `info` decides whether there is text.
		const { items } = await this.devicectlJson<{
			items?: Array<{ flavors?: Array<{ type?: string }> }>;
		}>(["device", "pasteboard", "info", "--device", udid]);
		if (!items?.length) return "";
		const types = items[0]?.flavors?.flatMap(({ type }) => (type ? [type] : [])) ?? [];
		if (!types.some((type) => PASTEBOARD_TEXT_TYPES.has(type)))
			throw new Error(
				`The pasteboard of ios:${udid} holds no text (${types.join(", ") || "no types"})`,
			);
		return this.devicectl(udid, ["device", "pasteboard", "paste"]);
	}

	async setStatusBar(
		udid: string,
		action: "clear" | "override",
		args: readonly string[] = [],
	): Promise<void> {
		await this.simctl(["status_bar", udid, action, ...args]);
	}

	async openUrl(udid: string, url: string): Promise<void> {
		await this.simctl(["openurl", udid, url]);
	}

	/**
	 * Pixels per point of the main display, from Xcode 27 `devicectl device
	 * info displays` (Simulators and devices). A display's scale never
	 * changes, so it is read once per device.
	 */
	async pointScale(udid: string): Promise<number> {
		const cached = this.pointScales.get(udid);
		if (cached) return cached;
		const { displays } = await this.devicectlJson<{
			displays?: Array<{ primary?: boolean; pointScale?: unknown }>;
		}>(["device", "info", "displays", "--device", udid]);
		const scale = (displays?.find((display) => display.primary) ?? displays?.[0])
			?.pointScale;
		if (typeof scale !== "number" || scale < 1)
			throw new Error(`devicectl reported no point scale for ios:${udid}`);
		this.pointScales.set(udid, scale);
		return scale;
	}

	/** Devices need Xcode 27 `devicectl device capture`; older Xcode falls back to WebDriverAgent. */
	async screenshot(udid: string): Promise<Buffer> {
		// Xcode 26 documents `-` as stdout but writes a literal file named `-`.
		const output = join(tmpdir(), `mobile-mcp-${randomUUID()}.png`);
		try {
			if (isPhysicalIosUdid(udid))
				await this.devicectl(udid, [
					"device",
					"capture",
					"screenshot",
					"--destination",
					output,
				]);
			else await this.simctl(["io", udid, "screenshot", "--type=png", output]);
			return await readFile(output);
		} finally {
			// safe to ignore: temp cleanup must not hide the screenshot result.
			await unlink(output).catch(() => undefined);
		}
	}
}
