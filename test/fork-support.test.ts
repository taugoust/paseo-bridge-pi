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
