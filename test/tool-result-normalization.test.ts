import assert from "node:assert/strict";
import test from "node:test";

import { normalizePiEventForPaseo } from "../extension/tool-result-normalization.ts";

function failed(result: unknown) {
  return {
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    isError: true,
    result,
  };
}

test("unwraps text-only failed Pi tool results for Paseo", () => {
  const event = failed({
    content: [{ type: "text", text: "command failed\nCommand exited with code 1" }],
    details: {},
  });

  assert.deepEqual(normalizePiEventForPaseo(event), {
    ...event,
    result: "command failed\nCommand exited with code 1",
  });
});

test("joins multiple text blocks without changing their contents", () => {
  const event = failed({ content: [{ type: "text", text: "first" }, { type: "text", text: "second\n" }] });
  assert.equal((normalizePiEventForPaseo(event) as typeof event).result, "first\nsecond\n");
});

test("leaves successful tool results untouched", () => {
  const event = { ...failed({ content: [{ type: "text", text: "ok" }], details: {} }), isError: false };
  assert.equal(normalizePiEventForPaseo(event), event);
});

test("preserves failed results with meaningful details", () => {
  const event = failed({ content: [{ type: "text", text: "failed" }], details: { diff: "patch" } });
  assert.equal(normalizePiEventForPaseo(event), event);
});

test("preserves failed results with additional result metadata", () => {
  const event = failed({ content: [{ type: "text", text: "failed" }], details: {}, exitCode: 1 });
  assert.equal(normalizePiEventForPaseo(event), event);
});

test("preserves non-text and empty failed results", () => {
  const imageEvent = failed({ content: [{ type: "image", data: "..." }], details: {} });
  const emptyEvent = failed({ content: [], details: {} });
  assert.equal(normalizePiEventForPaseo(imageEvent), imageEvent);
  assert.equal(normalizePiEventForPaseo(emptyEvent), emptyEvent);
});
