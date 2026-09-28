import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;

export interface RunOptions {
	timeoutMs?: number;
	maxBuffer?: number;
	env?: NodeJS.ProcessEnv;
	input?: string;
}

export class CommandError extends Error {
	constructor(
		message: string,
		readonly command: string,
		readonly args: readonly string[],
		readonly stdout: string,
		readonly stderr: string,
	) {
		super(message);
		this.name = "CommandError";
	}
}

function runFile(
	command: string,
	args: readonly string[],
	options: RunOptions,
	encoding: BufferEncoding | "buffer",
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			command,
			[...args],
			{
				encoding,
				timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
				env: options.env,
			},
			(error, stdout, stderr) => {
				if (!error) {
					resolve({ stdout, stderr });
					return;
				}

				const textOut = Buffer.isBuffer(stdout)
					? stdout.toString("utf8")
					: stdout;
				const textErr = Buffer.isBuffer(stderr)
					? stderr.toString("utf8")
					: stderr;
				// xcrun/simctl print this harmless directory-services warning on
				// stderr even when the real failure is a timeout or maxBuffer
				// overrun; stripping it stops it from masking the actual cause.
				const meaningfulErr = textErr
					.replaceAll(/^getpwuid_r did not find a match for uid \d+$/gmu, "")
					.trim();
				const detail = meaningfulErr || error.message || textOut.trim();
				reject(
					new CommandError(
						`${command} failed: ${detail}`,
						command,
						args,
						textOut,
						textErr,
					),
				);
			},
		);
		const stdin = child.stdin;
		if (options.input !== undefined && stdin) {
			// The process callback reports the real failure if the child exits early.
			stdin.on("error", () => undefined);
			stdin.end(options.input);
		}
	});
}

export async function run(
	command: string,
	args: readonly string[],
	options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
	const result = await runFile(command, args, options, "utf8");
	return { stdout: result.stdout as string, stderr: result.stderr as string };
}

export async function runBinary(
	command: string,
	args: readonly string[],
	options: RunOptions = {},
): Promise<Buffer> {
	const result = await runFile(command, args, options, "buffer");
	return result.stdout as Buffer;
}

/** Returns the last `maxLines` lines, ignoring the trailing newline. */
export function tailLines(text: string, maxLines: number): string {
	return text.trimEnd().split(/\r?\n/u).slice(-maxLines).join("\n");
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
