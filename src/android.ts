import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { run, runBinary, sleep } from "./exec.js";
import type { MobileApp } from "./ios.js";

export interface AndroidDevice {
	id: string;
	name: string;
	platform: "android";
	state: "online" | "offline" | "shutdown";
	version?: string;
	avd?: string;
}

export const KEYCODES = {
	HOME: "KEYCODE_HOME",
	BACK: "KEYCODE_BACK",
	ENTER: "KEYCODE_ENTER",
	APP_SWITCH: "KEYCODE_APP_SWITCH",
	VOLUME_UP: "KEYCODE_VOLUME_UP",
	VOLUME_DOWN: "KEYCODE_VOLUME_DOWN",
	DELETE: "KEYCODE_DEL",
	TAB: "KEYCODE_TAB",
	ESCAPE: "KEYCODE_ESCAPE",
	MENU: "KEYCODE_MENU",
	SEARCH: "KEYCODE_SEARCH",
	POWER: "KEYCODE_POWER",
	DPAD_UP: "KEYCODE_DPAD_UP",
	DPAD_DOWN: "KEYCODE_DPAD_DOWN",
	DPAD_LEFT: "KEYCODE_DPAD_LEFT",
	DPAD_RIGHT: "KEYCODE_DPAD_RIGHT",
	DPAD_CENTER: "KEYCODE_DPAD_CENTER",
} as const satisfies Record<string, string>;

export type AndroidKey = keyof typeof KEYCODES;

function sdkBinary(relativePath: string, fallback: string): string {
	const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
	if (!sdk) return fallback;
	const suffix = process.platform === "win32" ? ".exe" : "";
	const candidate = join(sdk, ...relativePath.split("/")) + suffix;
	return existsSync(candidate) ? candidate : fallback;
}

export function quoteAndroidShellArgument(value: string): string {
	if (/[\0\n\r]/u.test(value))
		throw new Error(
			"Android shell arguments cannot contain control characters",
		);
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function parseAndroidPackages(stdout: string): string[] {
	return stdout
		.split(/\r?\n/u)
		.flatMap((line) => {
			const name = line.trim().startsWith("package:")
				? line.trim().slice("package:".length).trim()
				: "";
			return name ? [name] : [];
		})
		.sort((left, right) => left.localeCompare(right));
}

/**
 * `mCurrentFocus` is authoritative when a window has focus, but it reads
 * `null` while the device is locked or animating, so `mFocusedApp` is the
 * documented fallback for the activity that owns the foreground task.
 */
export function parseAndroidForegroundApp(stdout: string): {
	appId: string;
	activity?: string;
} {
	const focus =
		/mCurrentFocus=Window\{[^}]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\}/u.exec(
			stdout,
		) ??
		/mFocusedApp=ActivityRecord\{[^}]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)[\s}]/u.exec(
			stdout,
		);
	if (!focus?.[1])
		throw new Error("Could not read a foreground app from dumpsys window");
	return { appId: focus[1], ...(focus[2] ? { activity: focus[2] } : {}) };
}

/**
 * `uiautomator dump` and `adb exec-out cat` both exit 0 on failure, so their
 * output is the only signal that a dump actually happened. Without these
 * checks a "No such file" message is returned as if it were the UI tree.
 */
export function validateAndroidUiTree(
	dump: string,
	tree: string,
	remotePath: string,
): string {
	if (!dump.includes(remotePath)) {
		throw new Error(
			`uiautomator could not dump the UI (is the screen on and unlocked?): ${dump.trim() || "no output"}`,
		);
	}
	if (!tree.includes("<hierarchy")) {
		throw new Error(
			`Android returned no UI hierarchy: ${tree.trim().slice(0, 200) || "empty output"}`,
		);
	}
	return tree;
}

function safeMediaName(path: string): string {
	const name = basename(path);
	if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name))
		throw new Error(
			`Media file name must be 1-128 characters of A-Z a-z 0-9 . _ - : ${name}`,
		);
	return name;
}

export class AndroidController {
	readonly adb = sdkBinary("platform-tools/adb", "adb");
	readonly emulator = sdkBinary("emulator/emulator", "emulator");
	private bootQueue: Promise<void> = Promise.resolve();

	private command(
		serial: string,
		args: readonly string[],
		timeoutMs = 30_000,
		maxBuffer = 2 * 1024 * 1024,
	) {
		return run(this.adb, ["-s", serial, ...args], { timeoutMs, maxBuffer });
	}

	async listAvds(): Promise<string[]> {
		const { stdout } = await run(this.emulator, ["-list-avds"]);
		return stdout
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean);
	}

	private async rawDevices(): Promise<
		Array<{ serial: string; state: string; details: string }>
	> {
		const { stdout } = await run(this.adb, ["devices", "-l"]);
		return stdout
			.split(/\r?\n/u)
			.slice(1)
			.flatMap((line) => {
				const match = /^(emulator-\d+)\s+(\S+)(?:\s+(.*))?$/u.exec(line.trim());
				return match?.[1] && match[2]
					? [{ serial: match[1], state: match[2], details: match[3] ?? "" }]
					: [];
			});
	}

	private async avdName(serial: string): Promise<string | undefined> {
		try {
			const { stdout } = await this.command(serial, ["emu", "avd", "name"]);
			return stdout.split(/\r?\n/u)[0]?.trim() || undefined;
		} catch {
			// Optional metadata: keep the reachable emulator in discovery results.
			return undefined;
		}
	}

	async listDevices(): Promise<AndroidDevice[]> {
		const attached = await this.rawDevices();
		const online = await Promise.all(
			attached.map(async ({ serial, state, details }) => {
				const avd = state === "device" ? await this.avdName(serial) : undefined;
				let version: string | undefined;
				if (state === "device") {
					try {
						version = (
							await this.command(serial, [
								"shell",
								"getprop",
								"ro.build.version.release",
							])
						).stdout.trim();
					} catch {
						// Optional metadata: device state remains authoritative.
						version = undefined;
					}
				}
				const model = /(?:^|\s)model:(\S+)/u.exec(details)?.[1];
				return {
					id: `android:${serial}`,
					name: avd ?? model ?? serial,
					platform: "android" as const,
					state:
						state === "device" ? ("online" as const) : ("offline" as const),
					...(version ? { version } : {}),
					...(avd ? { avd } : {}),
				};
			}),
		);

		const runningAvds = new Set(
			online.flatMap((device) => (device.avd ? [device.avd] : [])),
		);
		const shutdown = (await this.listAvds())
			.filter((name) => !runningAvds.has(name))
			.map(
				(name): AndroidDevice => ({
					id: `android-avd:${name}`,
					name,
					platform: "android",
					state: "shutdown",
					avd: name,
				}),
			);
		return [...online, ...shutdown];
	}

	async boot(avd: string, timeoutMs: number): Promise<string> {
		const result = this.bootQueue.then(() => this.bootUnlocked(avd, timeoutMs));
		this.bootQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async bootUnlocked(avd: string, timeoutMs: number): Promise<string> {
		const attached = await this.rawDevices();
		const usedPorts = new Set(
			attached.map(({ serial }) => Number(serial.slice("emulator-".length))),
		);
		const port = Array.from(
			{ length: 65 },
			(_, index) => 5554 + index * 2,
		).find((candidate) => !usedPorts.has(candidate));
		if (!port)
			throw new Error("No free Android Emulator console port is available");

		const child = spawn(this.emulator, ["-avd", avd, "-port", String(port)], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		const serial = `emulator-${port}`;
		const spawnFailure = new Promise<never>((_, reject) => {
			child.once("error", (error) =>
				reject(new Error(`Failed to start Android Emulator: ${error.message}`)),
			);
			child.once("exit", (code) => {
				if (code !== null && code !== 0)
					reject(
						new Error(
							`Android Emulator exited during startup with code ${code}`,
						),
					);
			});
		});
		try {
			await Promise.race([this.waitForBoot(serial, timeoutMs), spawnFailure]);
			return serial;
		} catch (error) {
			await this.command(serial, ["emu", "kill"], 5_000).catch(() => {
				child.kill("SIGTERM");
			});
			throw error;
		}
	}

	private async waitForBoot(serial: string, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const poll = async (): Promise<void> => {
			if (Date.now() >= deadline)
				throw new Error(
					`${serial} did not finish booting within ${timeoutMs}ms`,
				);
			try {
				const { stdout } = await this.command(
					serial,
					["shell", "getprop", "sys.boot_completed"],
					5_000,
				);
				if (stdout.trim() === "1") return;
			} catch {
				// ADB is expected to reject commands until the emulator daemon is reachable.
			}
			await sleep(1_000);
			return poll();
		};
		return poll();
	}

	async shutdown(serial: string): Promise<void> {
		await this.command(serial, ["emu", "kill"]);
	}

	async install(serial: string, appPath: string): Promise<void> {
		await this.command(serial, ["install", "-r", appPath], 120_000);
	}

	async launch(serial: string, packageName: string): Promise<void> {
		const { stdout } = await this.command(serial, [
			"shell",
			"monkey",
			"-p",
			packageName,
			"-c",
			"android.intent.category.LAUNCHER",
			"1",
		]);
		if (!stdout.includes("Events injected: 1"))
			throw new Error(`No launchable activity found for ${packageName}`);
	}

	async terminate(serial: string, packageName: string): Promise<void> {
		await this.command(serial, ["shell", "am", "force-stop", packageName]);
	}

	async resetAppData(serial: string, packageName: string): Promise<void> {
		const { stdout } = await this.command(serial, [
			"shell",
			"pm",
			"clear",
			packageName,
		]);
		if (stdout.trim() !== "Success")
			throw new Error(`Android did not clear data for ${packageName}`);
	}

	async getLogs(
		serial: string,
		packageName: string,
		sinceMinutes: number,
		maxLines: number,
	): Promise<string> {
		const { stdout: packages } = await this.command(serial, [
			"shell",
			"cmd",
			"package",
			"list",
			"packages",
			"-U",
			packageName,
		]);
		const prefix = `package:${packageName} uid:`;
		const uid = packages
			.split(/\r?\n/u)
			.find((line) => line.startsWith(prefix))
			?.slice(prefix.length)
			.trim();
		if (!uid || !/^\d+$/u.test(uid))
			throw new Error(`${packageName} is not installed on ${serial}`);
		const since = ((Date.now() - sinceMinutes * 60_000) / 1_000).toFixed(3);
		return (
			await this.command(
				serial,
				[
					"logcat",
					"-d",
					"-T",
					since,
					"-m",
					String(maxLines),
					`--uid=${uid}`,
					"-v",
					"threadtime",
				],
				30_000,
				4 * 1024 * 1024,
			)
		).stdout;
	}

	async setPermission(
		serial: string,
		packageName: string,
		permission: string,
		action: "grant" | "revoke",
	): Promise<void> {
		await this.command(serial, [
			"shell",
			"pm",
			action,
			packageName,
			permission,
		]);
	}

	async setLocation(
		serial: string,
		latitude: number,
		longitude: number,
	): Promise<void> {
		await this.command(serial, [
			"emu",
			"geo",
			"fix",
			String(longitude),
			String(latitude),
		]);
	}

	async uninstall(serial: string, packageName: string): Promise<void> {
		await this.command(serial, ["uninstall", packageName], 120_000);
	}

	async setBattery(
		serial: string,
		capacity: number,
		charging: boolean,
	): Promise<void> {
		await this.command(serial, ["emu", "power", "capacity", String(capacity)]);
		await this.command(serial, ["emu", "power", "ac", charging ? "on" : "off"]);
		let status = "discharging";
		if (charging) status = capacity === 100 ? "full" : "charging";
		await this.command(serial, ["emu", "power", "status", status]);
	}

	async sendSms(
		serial: string,
		phoneNumber: string,
		text: string,
	): Promise<void> {
		await this.command(serial, ["emu", "sms", "send", phoneNumber, text]);
	}

	async fingerprint(
		serial: string,
		action: "touch" | "remove",
		fingerId?: number,
	): Promise<void> {
		await this.command(serial, [
			"emu",
			"finger",
			action,
			...(action === "touch" ? [String(fingerId)] : []),
		]);
	}

	async setNetwork(
		serial: string,
		speed: string,
		delay: string,
	): Promise<void> {
		await this.command(serial, ["emu", "network", "speed", speed]);
		await this.command(serial, ["emu", "network", "delay", delay]);
	}

	async setConnectivity(
		serial: string,
		target: "airplane" | "wifi" | "data",
		enabled: boolean,
	): Promise<void> {
		if (target === "airplane")
			// cmd connectivity airplane-mode: API 30+; "enable" = radios off.
			await this.command(serial, [
				"shell",
				"cmd",
				"connectivity",
				"airplane-mode",
				enabled ? "enable" : "disable",
			]);
		else
			await this.command(serial, [
				"shell",
				"svc",
				target,
				enabled ? "enable" : "disable",
			]);
	}

	async rotate(serial: string): Promise<void> {
		await this.command(serial, ["emu", "rotate"]);
	}

	async listApps(serial: string, includeSystem: boolean): Promise<MobileApp[]> {
		const listing = async (flag: string): Promise<string[]> =>
			parseAndroidPackages(
				(
					await this.command(
						serial,
						["shell", "pm", "list", "packages", flag],
						30_000,
						4 * 1024 * 1024,
					)
				).stdout,
			);
		const user = await listing("-3");
		const system = includeSystem ? await listing("-s") : [];
		return [
			...user.map((appId) => ({ appId, name: appId, system: false })),
			...system.map((appId) => ({ appId, name: appId, system: true })),
		].sort((left, right) => left.appId.localeCompare(right.appId));
	}

	async foregroundApp(
		serial: string,
	): Promise<{ appId: string; activity?: string }> {
		const { stdout } = await this.command(
			serial,
			["shell", "dumpsys", "window"],
			20_000,
			8 * 1024 * 1024,
		);
		return parseAndroidForegroundApp(stdout);
	}

	async getAppearance(serial: string): Promise<"light" | "dark"> {
		const { stdout } = await this.command(serial, [
			"shell",
			"cmd",
			"uimode",
			"night",
		]);
		return /:\s*(yes|true)/iu.test(stdout) ? "dark" : "light";
	}

	async setAppearance(serial: string, mode: "light" | "dark"): Promise<void> {
		await this.command(serial, [
			"shell",
			"cmd",
			"uimode",
			"night",
			mode === "dark" ? "yes" : "no",
		]);
	}

	async setFontScale(serial: string, scale: number): Promise<void> {
		await this.command(serial, [
			"shell",
			"settings",
			"put",
			"system",
			"font_scale",
			String(scale),
		]);
	}

	async addMedia(serial: string, paths: readonly string[]): Promise<void> {
		for (const path of paths) {
			const remote = `/sdcard/Pictures/${safeMediaName(path)}`;
			await this.command(serial, ["push", path, remote], 120_000);
			await this.command(serial, [
				"shell",
				"am",
				"broadcast",
				"-a",
				"android.intent.action.MEDIA_SCANNER_SCAN_FILE",
				"-d",
				quoteAndroidShellArgument(`file://${remote}`),
			]);
		}
	}

	async screenInfo(serial: string): Promise<{
		width: number;
		height: number;
		density?: number;
		orientation: "portrait" | "landscape";
	}> {
		const { width, height } = await this.screenSize(serial);
		const { stdout } = await this.command(serial, ["shell", "wm", "density"]);
		const density = /density:\s*(\d+)/u.exec(stdout)?.[1];
		return {
			width,
			height,
			...(density ? { density: Number(density) } : {}),
			orientation: height >= width ? "portrait" : "landscape",
		};
	}

	async longPress(
		serial: string,
		x: number,
		y: number,
		durationMs: number,
	): Promise<void> {
		await this.validatePoint(serial, x, y);
		// `input swipe` with identical start/end points is the documented
		// long-press primitive; `input tap` has no duration argument.
		await this.command(serial, [
			"shell",
			"input",
			"swipe",
			String(x),
			String(y),
			String(x),
			String(y),
			String(durationMs),
		]);
	}

	async openUrl(serial: string, url: string): Promise<void> {
		await this.command(serial, [
			"shell",
			"am",
			"start",
			"-W",
			"-a",
			"android.intent.action.VIEW",
			"-d",
			quoteAndroidShellArgument(url),
		]);
	}

	async screenshot(serial: string): Promise<Buffer> {
		return runBinary(this.adb, ["-s", serial, "exec-out", "screencap", "-p"], {
			timeoutMs: 30_000,
			maxBuffer: 20 * 1024 * 1024,
		});
	}

	async uiTree(serial: string): Promise<string> {
		const remotePath = "/sdcard/mobile-mcp-ui.xml";
		try {
			const { stdout: dump } = await this.command(
				serial,
				["shell", "uiautomator", "dump", "--compressed", remotePath],
				15_000,
			);
			const { stdout: tree } = await this.command(
				serial,
				["exec-out", "cat", remotePath],
				10_000,
				8 * 1024 * 1024,
			);
			return validateAndroidUiTree(dump, tree, remotePath);
		} finally {
			// safe to ignore: remote temp cleanup must not hide the UI-tree result.
			await this.command(
				serial,
				["shell", "rm", "-f", remotePath],
				5_000,
			).catch(() => undefined);
		}
	}

	private async screenSize(
		serial: string,
	): Promise<{ width: number; height: number }> {
		const { stdout } = await this.command(serial, ["shell", "wm", "size"]);
		const matches = [
			...stdout.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/gu),
		];
		const match = matches.at(-1);
		if (!match?.[1] || !match[2])
			throw new Error(`Could not read screen size from ${serial}`);
		return { width: Number(match[1]), height: Number(match[2]) };
	}

	private async validatePoint(
		serial: string,
		x: number,
		y: number,
	): Promise<void> {
		const { width, height } = await this.screenSize(serial);
		if (x >= width || y >= height)
			throw new Error(
				`Coordinates (${x}, ${y}) exceed screen size ${width}x${height}`,
			);
	}

	async tap(serial: string, x: number, y: number): Promise<void> {
		await this.validatePoint(serial, x, y);
		await this.command(serial, ["shell", "input", "tap", String(x), String(y)]);
	}

	async swipe(
		serial: string,
		fromX: number,
		fromY: number,
		toX: number,
		toY: number,
		durationMs: number,
	): Promise<void> {
		await Promise.all([
			this.validatePoint(serial, fromX, fromY),
			this.validatePoint(serial, toX, toY),
		]);
		await this.command(serial, [
			"shell",
			"input",
			"swipe",
			String(fromX),
			String(fromY),
			String(toX),
			String(toY),
			String(durationMs),
		]);
	}

	async typeText(serial: string, text: string): Promise<void> {
		if (!/^[\x20-\x7E]*$/u.test(text)) {
			throw new Error(
				"Android `input text` supports printable ASCII only; use an ASCII test value",
			);
		}
		const encoded = text.replaceAll("%", "\\%").replaceAll(" ", "%s");
		await this.command(serial, [
			"shell",
			"input",
			"text",
			quoteAndroidShellArgument(encoded),
		]);
	}

	async pressKey(serial: string, key: AndroidKey): Promise<void> {
		await this.command(serial, ["shell", "input", "keyevent", KEYCODES[key]]);
	}
}
