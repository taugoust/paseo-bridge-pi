import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createForkedSession,
  parseForkPrompt,
  resolveForkPlan,
} from "../shim/fork-support.js";

function createSourceSession(root: string) {
  const cwd = path.join(root, "repo");
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(cwd, { recursive: true });
  const manager = SessionManager.create(cwd, sessions);
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "Original question" }], timestamp: Date.now() });
  const assistantId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Selected answer\nwith details" }],
    api: "responses",
    provider: "openai-codex",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  return { cwd, manager, assistantId, sessionFile: manager.getSessionFile()! };
}

test("parseForkPrompt extracts Paseo history and leaves only the new prompt", () => {
  const parsed = parseForkPrompt(`<chat-history-summary>
Chat history from a previous Paseo agent.
Source agent: Source task
Source directory: /repo

[User] Original question
[Read] src/index.ts
[Assistant] Selected answer
with details
</chat-history-summary>

Try another approach`);
  assert.deepEqual(parsed, {
    agentTitle: "Source task",
    cwd: "/repo",
    body: "[User] Original question\n[Read] src/index.ts\n[Assistant] Selected answer\nwith details",
    boundaryText: "Selected answer\nwith details",
    nextPrompt: "Try another approach",
  });
});

test("parseForkPrompt rejects ordinary prompts and malformed summaries", () => {
  assert.equal(parseForkPrompt("ordinary prompt"), null);
  assert.equal(parseForkPrompt("<chat-history-summary>other text</chat-history-summary>"), null);
});

test("parseForkPrompt tolerates history that discusses its own closing tag", () => {
  const parsed = parseForkPrompt(`<chat-history-summary>
Chat history from a previous Paseo agent.
Source directory: /repo

[Assistant] The marker is </chat-history-summary> and remains part of this response.
</chat-history-summary>

Next`);
  assert.equal(parsed?.boundaryText, "The marker is </chat-history-summary> and remains part of this response.");
  assert.equal(parsed?.nextPrompt, "Next");
});

test("resolveForkPlan maps same-workspace forks to panes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-fork-plan-"));
  try {
    const source = createSourceSession(root);
    const agentMapFile = path.join(root, "agents.json");
    fs.writeFileSync(agentMapFile, JSON.stringify({ [source.sessionFile]: "source-agent" }));
    const command = {
      type: "prompt",
      message: `<chat-history-summary>
Chat history from a previous Paseo agent.
Source agent: Source task
Source directory: ${source.cwd}

[User] Original question
[Assistant] Selected answer
with details
</chat-history-summary>

Continue differently`,
    };
    const plan = resolveForkPlan({
      command,
      targetAgentId: "target-agent",
      agentMapFile,
      agents: [
        { id: "source-agent", name: "Source task", cwd: source.cwd, workspaceId: "workspace-a" },
        { id: "target-agent", name: null, cwd: source.cwd, workspaceId: "workspace-a" },
      ],
    });
    assert.equal(plan?.sourceSessionFile, source.sessionFile);
    assert.equal(plan?.sourceEntryId, source.assistantId);
    assert.equal(plan?.placement, "pane");
    assert.equal(plan?.nextPrompt, "Continue differently");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveForkPlan maps different-workspace forks to windows and refuses ambiguity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-fork-window-"));
  try {
    const source = createSourceSession(root);
    const agentMapFile = path.join(root, "agents.json");
    fs.writeFileSync(agentMapFile, JSON.stringify({ [source.sessionFile]: "source-agent" }));
    const command = {
      type: "prompt",
      message: `<chat-history-summary>
Chat history from a previous Paseo agent.
Source agent: Source task
Source directory: ${source.cwd}

[Assistant] Selected answer
with details
</chat-history-summary>`,
    };
    const agents = [
      { id: "source-agent", name: "Source task", cwd: source.cwd, workspaceId: "workspace-a" },
      { id: "target-agent", name: null, cwd: source.cwd, workspaceId: "workspace-b" },
    ];
    assert.equal(resolveForkPlan({ command, targetAgentId: "target-agent", agentMapFile, agents })?.placement, "window");

    const manager = SessionManager.open(source.sessionFile);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Selected answer\nwith details" }],
      api: "responses",
      provider: "openai-codex",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    assert.throws(
      () => resolveForkPlan({ command, targetAgentId: "target-agent", agentMapFile, agents }),
      /multiple Pi session entries/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createForkedSession preserves the path through the selected assistant entry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-fork-create-"));
  try {
    const source = createSourceSession(root);
    const forkFile = createForkedSession(source.sessionFile, source.assistantId);
    assert.notEqual(forkFile, source.sessionFile);
    const fork = SessionManager.open(forkFile);
    assert.equal(fork.getLeafId(), source.assistantId);
    assert.deepEqual(
      fork.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.message.role),
      ["user", "assistant"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function forkFixture(root: string) {
  const source = createSourceSession(root);
  const agentMapFile = path.join(root, "agents.json");
  fs.writeFileSync(agentMapFile, JSON.stringify({ [source.sessionFile]: "source" }));
  const assistant = (text: string, calls: string[] = []) => source.manager.appendMessage({
    ...(source.manager.getEntry(source.assistantId) as any).message,
    content: [...(text ? [{ type: "text", text }] : []), ...calls.map(id => ({ type: "toolCall", id, name: "read", arguments: {} }))],
    stopReason: calls.length ? "toolUse" : "stop",
  });
  const result = (id: string) => source.manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false, timestamp: Date.now() });
  const resolve = (body: string) => resolveForkPlan({
    command: { message: `<chat-history-summary>\nChat history from a previous Paseo agent.\nSource directory: ${source.cwd}\n\n${body}\n</chat-history-summary>` },
    targetAgentId: "target", agentMapFile,
    agents: [{ id: "source", cwd: source.cwd }, { id: "target", cwd: source.cwd }],
    readSnapshot: () => ({ leafId: source.manager.getLeafId(), messages: source.manager.buildSessionContext().messages }),
  })!;
  return { ...source, assistant, result, resolve };
}

test("whole-agent trailing tools snapshot current native head, preserve complete tool turns and source bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-tools-"));
  try {
    const f = forkFixture(root);
    f.assistant("Second turn", ["one"]); f.result("one");
    f.assistant("", ["two"]); const head = f.result("two");
    const before = fs.readFileSync(f.sessionFile);
    const plan = f.resolve("[Assistant] Selected answer\nwith details\n[User] More\n[Assistant] Second turn\n[Read] file\n[Shell] command\n[Background job] running");
    assert.equal(plan.sourceEntryId, head);
    // Appends after submission must not leak into the captured fork.
    f.assistant("After submission");
    const afterAppend = fs.readFileSync(f.sessionFile);
    const fork = SessionManager.open(createForkedSession(f.sessionFile, plan.sourceEntryId, plan.sourceSnapshot));
    assert.equal(fork.getLeafId(), head);
    assert.equal(fork.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult").length, 2);
    assert.deepEqual(fs.readFileSync(f.sessionFile), afterAppend);
    assert.notDeepEqual(before, afterAppend);
    assert.equal(f.resolve("[Assistant] Selected answer\nwith details").sourceEntryId, f.assistantId);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("whole-agent uses in-memory branch cursor, refuses stale anchors and duplicate text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-branch-"));
  try {
    const f = forkFixture(root);
    const anchor = f.assistant("Anchor");
    f.assistant("", ["one"]); const current = f.result("one");
    f.manager.branch(f.assistantId);
    f.assistant("Historical unrelated branch");
    f.manager.branch(current); // No JSONL write: disk's last entry is unrelated.
    assert.equal(f.resolve("[Assistant] Anchor\n[Read] file").sourceEntryId, current);
    f.manager.branch(f.assistantId);
    assert.throws(() => f.resolve("[Assistant] Anchor\n[Read] file"), /not on the current native branch/);
    f.manager.branch(anchor); f.assistant("Anchor");
    assert.throws(() => f.resolve("[Assistant] Anchor\n[Read] file"), /multiple Pi session entries/);
    assert.throws(() => f.resolve("[Assistant] Missing\n[Read] file"), /could not match/);
    assert.throws(() => f.resolve("[Assistant] Anchor\n[Assistant] Missing\n[Read] file"), /could not match/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native full assistant text wins over embedded history markers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-markers-"));
  try {
    const f = forkFixture(root);
    f.assistant("embedded");
    const text = "Literal markers:\n[User] pretend\n[Assistant] embedded\n[Read] not a tool";
    const anchor = f.assistant(text);
    assert.equal(f.resolve(`[Assistant] ${text}`).sourceEntryId, anchor);
    const head = f.manager.appendCustomEntry("metadata", {});
    assert.equal(f.resolve(`[Assistant] ${text}\n[Shell] true`).sourceEntryId, head);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unfinished final tool batch trims only that batch, without synthetic results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-incomplete-"));
  try {
    const f = forkFixture(root);
    f.assistant("Anchor", ["complete"]); const safe = f.result("complete");
    f.assistant("", ["partial", "pending"]); f.result("partial");
    const before = fs.readFileSync(f.sessionFile);
    const plan = f.resolve("[Assistant] Anchor\n[Read] file\n[Background job] pending");
    assert.equal(plan.sourceEntryId, safe);
    assert.equal(plan.trimmedIncompleteTools, true);
    const fork = SessionManager.open(createForkedSession(f.sessionFile, plan.sourceEntryId, plan.sourceSnapshot));
    assert.equal(fork.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult").length, 1);
    assert.deepEqual(fs.readFileSync(f.sessionFile), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
