import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { run, runBinary, sleep } from "./exec.js";

export interface AndroidDevice {
	id: string;
	name: string;
	platform: "android";
	state: "online" | "offline" | "shutdown";
	version?: string;
	avd?: string;
}

export type AndroidKey =
	| "HOME"
	| "BACK"
	| "ENTER"
	| "APP_SWITCH"
	| "VOLUME_UP"
	| "VOLUME_DOWN";

const KEYCODES: Record<AndroidKey, string> = {
	HOME: "KEYCODE_HOME",
	BACK: "KEYCODE_BACK",
	ENTER: "KEYCODE_ENTER",
	APP_SWITCH: "KEYCODE_APP_SWITCH",
	VOLUME_UP: "KEYCODE_VOLUME_UP",
	VOLUME_DOWN: "KEYCODE_VOLUME_DOWN",
};

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

	async rotate(serial: string): Promise<void> {
		await this.command(serial, ["emu", "rotate"]);
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
			await this.command(
				serial,
				["shell", "uiautomator", "dump", "--compressed", remotePath],
				15_000,
			);
			return (
				await this.command(
					serial,
					["exec-out", "cat", remotePath],
					10_000,
					8 * 1024 * 1024,
				)
			).stdout;
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
