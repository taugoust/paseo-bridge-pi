import assert from "node:assert/strict";
import test from "node:test";
import { workerTask } from "../client/worker-task.ts";

const prompt = (task: string, acceptance: string) =>
  `Parent instructions:\nTask: ${task}\n\nAcceptance criteria: ${acceptance}\nReport useful findings with notify_parent and your outcome with task_outcome.`;

test("a worker's first parent message reads as its task and acceptance criteria", () => {
  assert.deepEqual(workerTask(prompt("Fix the tests.\n\nKeep the guards.", '["All tests pass","No pushes"]')),
    { task: "Fix the tests.\n\nKeep the guards.", acceptance: ["All tests pass", "No pushes"] });
  assert.deepEqual(workerTask("Task: Without the heading\n\nAcceptance criteria: []\nrest"), { task: "Without the heading", acceptance: [] });
});

test("anything else is shown as written, never partly parsed", () => {
  assert.equal(workerTask("Please review this request."), undefined);
  assert.equal(workerTask(prompt("Bad criteria", '["unterminated"')), undefined);
  assert.equal(workerTask(prompt("Not strings", "[1,2]")), undefined);
  assert.equal(workerTask(prompt("Not a list", '{"a":1}')), undefined);
  assert.equal(workerTask(`Note first\n${prompt("Late task", "[]")}`), undefined, "the task must open the message");
});
