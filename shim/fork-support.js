import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CHAT_HISTORY_OPEN = "<chat-history-summary>";
const CHAT_HISTORY_CLOSE = "</chat-history-summary>";

function normalizePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const expanded = trimmed === "~"
    ? os.homedir()
    : trimmed.startsWith("~/")
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed;
  return path.resolve(expanded);
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export function parseForkPrompt(message) {
  if (typeof message !== "string") return null;
  const start = message.indexOf(CHAT_HISTORY_OPEN);
  if (start === -1) return null;
  const endStart = message.lastIndexOf(CHAT_HISTORY_CLOSE);
  if (endStart === -1) return null;
  const end = endStart + CHAT_HISTORY_CLOSE.length;
  const history = message.slice(start + CHAT_HISTORY_OPEN.length, endStart).trim();
  const lines = history.split("\n");
  if (lines[0]?.trim() !== "Chat history from a previous Paseo agent.") return null;

  let agentTitle = null;
  let cwd = null;
  let bodyStart = 1;
  for (; bodyStart < lines.length; bodyStart += 1) {
    const line = lines[bodyStart];
    if (!line.trim()) {
      bodyStart += 1;
      break;
    }
    if (line.startsWith("Source agent: ")) agentTitle = line.slice("Source agent: ".length).trim() || null;
    else if (line.startsWith("Source directory: ")) cwd = line.slice("Source directory: ".length).trim() || null;
  }

  const body = lines.slice(bodyStart).join("\n").trim();
  const assistantMarker = "[Assistant] ";
  const assistantStart = body.lastIndexOf(`\n${assistantMarker}`);
  const boundaryText = assistantStart === -1
    ? body.startsWith(assistantMarker) ? body.slice(assistantMarker.length).trim() : null
    : body.slice(assistantStart + 1 + assistantMarker.length).trim();
  if (!boundaryText) return null;

  const before = message.slice(0, start).trim();
  const after = message.slice(end).trim();
  return {
    agentTitle,
    cwd,
    body,
    boundaryText,
    nextPrompt: [before, after].filter(Boolean).join("\n\n"),
  };
}

function readAgentMap(agentMapFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(agentMapFile, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function listPaseoAgents(options = {}) {
  const cli = options.paseoCli || process.env.PASEO_CLI || "paseo";
  const hostArgs = process.env.PASEO_HOST ? ["--host", process.env.PASEO_HOST] : [];
  const result = spawnSync(cli, ["agent", "ls", "-g", "--json", ...hostArgs], {
    encoding: "utf8",
    env: process.env,
    timeout: options.timeoutMs ?? 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`could not list Paseo agents: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) throw new Error("Paseo agent list did not return an array");
  return parsed;
}

function matchingSourceAgents(fork, targetAgentId, agents) {
  const expectedCwd = normalizePath(fork.cwd);
  return agents.filter((agent) => {
    if (!agent || agent.id === targetAgentId) return false;
    if (fork.agentTitle && agent.name !== fork.agentTitle) return false;
    if (expectedCwd && normalizePath(agent.cwd) !== expectedCwd) return false;
    return true;
  });
}

function readSession(sessionFile) {
  const records = fs.readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const header = records.find((entry) => entry?.type === "session");
  if (!header || typeof header.cwd !== "string") throw new Error(`invalid Pi session: ${sessionFile}`);
  return { header, entries: records.filter((entry) => entry?.type !== "session") };
}

function assistantEntries(entries, historyBody) {
  return entries.filter((entry) => {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") return false;
    const text = textContent(entry.message.content).trim();
    return Boolean(text) && historyBody.endsWith(`[Assistant] ${text}`);
  });
}

export function resolveForkSource(input) {
  const agentMapFile = input.agentMapFile ?? path.join(os.homedir(), ".pi", "paseo-bridge", "agents.json");
  const agentMap = readAgentMap(agentMapFile);
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const sourceAgents = matchingSourceAgents(input.fork, input.targetAgentId, input.agents);
  const sourceIds = new Set(sourceAgents.map((agent) => agent.id));
  const matches = [];

  for (const [sessionFile, agentId] of Object.entries(agentMap)) {
    if (!sourceIds.has(agentId) || !fs.existsSync(sessionFile)) continue;
    let session;
    try {
      session = readSession(sessionFile);
    } catch {
      continue;
    }
    if (input.fork.cwd && normalizePath(session.header.cwd) !== normalizePath(input.fork.cwd)) continue;
    for (const entry of assistantEntries(session.entries, input.fork.body)) {
      matches.push({
        sourceAgent: agentsById.get(agentId),
        sourceAgentId: agentId,
        sourceSessionFile: sessionFile,
        sourceEntryId: entry.id,
        sourceWorkspaceId: agentsById.get(agentId)?.workspaceId ?? null,
      });
    }
  }

  if (matches.length === 0) {
    throw new Error("could not match the Paseo fork context to an attached Pi session entry");
  }
  if (matches.length > 1) {
    throw new Error("the Paseo fork context matched multiple Pi session entries; refusing an ambiguous fork");
  }
  return matches[0];
}

export function createForkedSession(sourceSessionFile, sourceEntryId) {
  const { header, entries } = readSession(sourceSessionFile);
  const byId = new Map(entries.filter((entry) => typeof entry?.id === "string").map((entry) => [entry.id, entry]));
  const reversed = [];
  let currentId = sourceEntryId;
  const seen = new Set();
  while (currentId) {
    if (seen.has(currentId)) throw new Error("cycle in Pi session entry parents");
    seen.add(currentId);
    const entry = byId.get(currentId);
    if (!entry) throw new Error(`entry ${currentId} was not found in ${sourceSessionFile}`);
    reversed.push(entry);
    currentId = entry.parentId ?? null;
  }
  const branch = reversed.reverse().filter((entry) => entry.type !== "label");
  let parentId = null;
  const rechained = branch.map((entry) => {
    const result = { ...entry, parentId };
    parentId = entry.id;
    return result;
  });
  if (!rechained.some((entry) => entry.type === "message" && entry.message?.role === "assistant")) {
    throw new Error("cannot persist a fork without an assistant message");
  }

  const timestamp = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  const output = path.join(path.dirname(sourceSessionFile), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const forkHeader = {
    type: "session",
    version: header.version,
    id: sessionId,
    timestamp,
    cwd: header.cwd,
    parentSession: sourceSessionFile,
  };
  const content = [forkHeader, ...rechained].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  fs.writeFileSync(output, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return output;
}

export function resolveForkPlan(input) {
  const fork = parseForkPrompt(input.command?.message);
  if (!fork) return null;
  const agents = input.agents ?? listPaseoAgents(input);
  const targetAgent = agents.find((agent) => agent.id === input.targetAgentId);
  if (!targetAgent) throw new Error(`new Paseo agent ${input.targetAgentId} was not found`);
  const source = resolveForkSource({
    fork,
    targetAgentId: input.targetAgentId,
    agents,
    agentMapFile: input.agentMapFile,
  });
  return {
    ...source,
    targetAgentId: input.targetAgentId,
    targetWorkspaceId: targetAgent.workspaceId ?? null,
    placement: source.sourceWorkspaceId && source.sourceWorkspaceId === targetAgent.workspaceId ? "pane" : "window",
    nextPrompt: fork.nextPrompt,
    fork,
  };
}
