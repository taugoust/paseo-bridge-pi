import assert from "node:assert/strict";
import test from "node:test";

import { unknownRpcCommandError } from "../extension/rpc-compat.ts";

test("uses Pi's exact clear_queue compatibility error", () => {
  assert.equal(unknownRpcCommandError("clear_queue"), "Unknown command: clear_queue");
});

test("normalizes a missing command name", () => {
  assert.equal(unknownRpcCommandError(undefined), "Unknown command: unknown");
});
