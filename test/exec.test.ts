import { test } from "node:test";
import { run } from "../src/exec.js";

test("handles a child closing stdin before input drains", async () => {
	await run(process.execPath, ["-e", "process.exit(0)"], {
		input: "x".repeat(5 * 1024 * 1024),
	});
});
