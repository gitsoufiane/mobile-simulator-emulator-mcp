import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError, run } from "../src/exec.js";

test("handles a child closing stdin before input drains", async () => {
	await run(process.execPath, ["-e", "process.exit(0)"], {
		input: "x".repeat(5 * 1024 * 1024),
	});
});

test("surfaces the real failure instead of xcrun's benign getpwuid_r noise", async () => {
	// xcrun simctl spawn ... log show prints this warning on stderr even
	// when the process is killed for an unrelated reason (timeout here);
	// it must not be mistaken for the actual error message.
	await assert.rejects(
		run(
			process.execPath,
			[
				"-e",
				"process.stderr.write(process.env.NOISE); setTimeout(() => {}, 1000);",
			],
			{
				timeoutMs: 20,
				env: {
					...process.env,
					NOISE: "getpwuid_r did not find a match for uid 501\n",
				},
			},
		),
		(error: unknown) => {
			assert.ok(error instanceof CommandError);
			assert.doesNotMatch(error.message, /getpwuid_r/u);
			return true;
		},
	);
});
