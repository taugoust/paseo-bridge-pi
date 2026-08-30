import assert from "node:assert/strict";
import test from "node:test";
import { SubagentTaskProjection, projectSubagentMessages } from "../extension/subagent-task-projection.ts";

test("projects parallel children into independent live task executions", () => {
  const projection = new SubagentTaskProjection();
  const starts = projection.project({
    type: "tool_execution_start",
    toolCallId: "parent",
    toolName: "subagent",
    args: { tasks: [{ task: "inspect", model: "fast" }, { task: "test" }] },
  });
  assert.deepEqual(
    starts.map((event) => [event.type, event.toolCallId, event.args]),
    [
      ["tool_execution_start", "parent::paseo-child::0", { task: "inspect", agent: "fast" }],
      ["tool_execution_start", "parent::paseo-child::1", { task: "test" }],
    ],
  );

  const updates = projection.project({
    type: "tool_execution_update",
    toolCallId: "parent",
    toolName: "subagent",
    partialResult: {
      details: {
        results: [
          { task: "inspect", lastAssistantText: "found files", terminal: { state: "running" } },
          { task: "test", lastToolCall: { name: "bash", args: { command: "npm test" } }, terminal: { state: "running" } },
        ],
      },
    },
  });
  assert.equal(updates[0].partialResult.content[0].text, "found files");
  assert.match(updates[1].partialResult.content[0].text, /Running bash.*npm test/);

  const ends = projection.project({
    type: "tool_execution_end",
    toolCallId: "parent",
    toolName: "subagent",
    result: {
      details: {
        results: [
          { task: "inspect", final: "done", exitCode: 0, terminal: { state: "completed" } },
          { task: "test", errorMessage: "failed", exitCode: 1, terminal: { state: "failed" } },
        ],
      },
    },
  });
  assert.equal(ends[0].isError, false);
  assert.equal(ends[1].isError, true);
  assert.equal(ends[0].result.content[0].text, "done");
});

test("projects historical messages with the same stable child ids", () => {
  const projected = projectSubagentMessages([
    {
      role: "assistant",
      content: [
        { type: "text", text: "delegating" },
        { type: "toolCall", id: "call-1", name: "subagent", arguments: { chain: [{ task: "first" }, { task: "second" }] } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "subagent",
      content: [{ type: "text", text: "aggregate" }],
      details: {
        mode: "chain",
        results: [
          { step: 1, task: "first", final: "one", terminal: { state: "completed", exitCode: 0 } },
          { step: 2, task: "second", final: "two", terminal: { state: "completed", exitCode: 0 } },
        ],
      },
    },
  ]) as any[];
  assert.deepEqual(
    projected[0].content.filter((part: any) => part.type === "toolCall").map((part: any) => part.id),
    ["call-1::paseo-child::0", "call-1::paseo-child::1"],
  );
  assert.equal(projected[1].toolCallId, "call-1::paseo-child::0");
  assert.equal(projected[2].toolCallId, "call-1::paseo-child::1");
  assert.equal(projected[2].content[0].text, "two");
});

test("deduplicates unchanged siblings and rate-limits streaming text", () => {
  let now = 1_000;
  const projection = new SubagentTaskProjection(() => now);
  projection.project({
    type: "tool_execution_start",
    toolCallId: "stream",
    toolName: "subagent",
    args: { tasks: [{ task: "one" }, { task: "two" }] },
  });
  const update = (firstText: string, secondText = "idle") => projection.project({
    type: "tool_execution_update",
    toolCallId: "stream",
    toolName: "subagent",
    partialResult: { details: { results: [
      { task: "one", lastAssistantText: firstText, terminal: { state: "running" } },
      { task: "two", lastAssistantText: secondText, terminal: { state: "running" } },
    ] } },
  });
  assert.equal(update("a").length, 2);
  now += 100;
  assert.equal(update("ab").length, 0);
  now += 500;
  const next = update("abc");
  assert.equal(next.length, 1);
  assert.equal(next[0].toolCallId, "stream::paseo-child::0");
});

test("drops cumulative child transcripts and bounds projected timeline details", () => {
  const projection = new SubagentTaskProjection();
  projection.project({
    type: "tool_execution_start",
    toolCallId: "large",
    toolName: "subagent",
    args: { task: "inspect" },
  });
  const [update] = projection.project({
    type: "tool_execution_update",
    toolCallId: "large",
    toolName: "subagent",
    partialResult: {
      details: {
        results: [{
          task: "inspect",
          lastAssistantText: "x".repeat(100_000),
          messages: Array.from({ length: 100 }, () => ({ role: "assistant", content: "private transcript" })),
          completedTools: Array.from({ length: 100 }, () => ({ name: "bash", result: "large" })),
          usage: { input: 12, output: 34 },
          terminal: { state: "running" },
        }],
      },
    },
  });
  assert.equal("messages" in update.partialResult.details, false);
  assert.equal("completedTools" in update.partialResult.details, false);
  assert.deepEqual(update.partialResult.details.usage, { input: 12, output: 34 });
  assert.ok(Buffer.byteLength(JSON.stringify(update), "utf8") < 24 * 1024);
});

test("leaves non-subagent and draft disposition events unchanged", () => {
  const projection = new SubagentTaskProjection();
  const bash = { type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "true" } };
  const draft = { type: "tool_execution_start", toolCallId: "d", toolName: "subagent", args: { action: "review" } };
  assert.deepEqual(projection.project(bash), [bash]);
  assert.deepEqual(projection.project(draft), [draft]);
});
