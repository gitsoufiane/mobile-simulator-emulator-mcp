import assert from "node:assert/strict";
import { test } from "node:test";
import { parseListenPort } from "../src/index.js";

test("parseListenPort: stdio default, port parsing, and validation", () => {
	assert.equal(parseListenPort([]), undefined);
	assert.equal(parseListenPort(["--listen"]), 3000);
	assert.equal(parseListenPort(["--listen", "8931"]), 8931);
	assert.equal(parseListenPort(["--listen", "--other-flag"]), 3000);
	assert.throws(() => parseListenPort(["--listen", "0"]));
	assert.throws(() => parseListenPort(["--listen", "70000"]));
	assert.throws(() => parseListenPort(["--listen", "notaport"]));
});
