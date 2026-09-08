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
  const matches = [];
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = textContent(entry.message.content).trim();
    if (!text) continue;
    const needle = `[Assistant] ${text}`;
    for (let start = historyBody.indexOf(needle); start !== -1; start = historyBody.indexOf(needle, start + 1)) {
      if (start && historyBody[start - 1] !== "\n") continue;
      const end = start + needle.length;
      const tail = historyBody.slice(end);
      // Match complete native text first: markers inside it are not delimiters.
      const trailingTools = /^\n+\[(?!Assistant\]|User\])[^\]\n]+\](?: |\n|$)/.test(tail)
        && !/^\[(?:Assistant|User)\]/m.test(tail);
      if (!tail || trailingTools) matches.push({ entry, start, end, trailingTools });
    }
  }
  return matches.filter((match) => !matches.some((other) => other.start < match.start && other.end > match.start));
}

// Query the running session, never infer its active leaf from JSONL append order.
// branch()/resetLeaf() can move the native cursor without writing a record.
export function readLiveForkSnapshot(sessionFile) {
  const key = crypto.createHash("sha256").update(path.resolve(sessionFile)).digest("hex");
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "paseo-bridge", "runtimes", `${key}.json`), "utf8"));
  } catch { /* Fall back to the ordinary session socket. */ }
  const dir = process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, "pi-paseo") : path.join(os.homedir(), ".pi", "paseo-bridge");
  const socketPath = `${record?.bridgeSocket || path.join(dir, `${key.slice(0, 20)}.sock`)}.fork`;
  const script = `
    const net = require('node:net');
    const socket = net.connect(process.argv[1]);
    let buffer = '';
    socket.setTimeout(5000, () => process.exit(2));
    socket.on('error', () => process.exit(2));
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\\n')) !== -1) {
        const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.id === 'fork-snapshot' && value.type === 'response') {
          process.stdout.write(JSON.stringify(value)); socket.end();
        }
      }
    });`;
  const result = spawnSync(process.execPath, ["-e", script, socketPath], { encoding: "utf8", timeout: 6000, maxBuffer: 64 * 1024 * 1024 });
  let response;
  try { response = JSON.parse(result.stdout); } catch { /* Fail closed below. */ }
  if (result.status !== 0 || !response?.success || response.data?.sessionFile !== path.resolve(sessionFile)) {
    throw new Error("could not obtain the current native branch snapshot; update the source bridge and retry");
  }
  return response.data;
}

function branchEntries(entries, leafId) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch = [], seen = new Set();
  for (let id = leafId; id; ) {
    if (seen.has(id) || !byId.has(id)) throw new Error("invalid native branch snapshot");
    seen.add(id);
    const entry = byId.get(id);
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

function validateToolContext(messages) {
  const pending = new Set();
  let batch = null;
  for (const message of messages) {
    if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) throw new Error("unmatched tool result in native fork context");
    } else {
      if (pending.size) throw new Error("incomplete tool exchange in native fork context; retry when complete");
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === "toolCall") {
          if (!block.id || pending.has(block.id)) throw new Error("invalid native tool call IDs");
          pending.add(block.id);
          batch = message;
        }
      }
    }
  }
  return pending.size ? batch : null;
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
    for (const { entry, trailingTools } of assistantEntries(session.entries, input.fork.body)) {
      matches.push({
        sourceAgent: agentsById.get(agentId),
        sourceAgentId: agentId,
        sourceSessionFile: sessionFile,
        sourceEntryId: entry.id,
        trailingTools,
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
  const match = matches[0];
  if (match.trailingTools) {
    const manifest = (input.readSnapshot ?? readLiveForkSnapshot)(match.sourceSessionFile);
    const snapshot = { ...readSession(match.sourceSessionFile), ...manifest };
    const anchors = assistantEntries(snapshot.entries, input.fork.body);
    if (anchors.length !== 1 || anchors[0].entry.id !== match.sourceEntryId) {
      throw new Error("the current native snapshot has ambiguous or missing assistant anchors");
    }
    const branch = branchEntries(snapshot.entries, snapshot.leafId);
    if (!branch.some((entry) => entry.id === match.sourceEntryId)) {
      throw new Error("the terminal assistant anchor is not on the current native branch");
    }
    if (!Array.isArray(snapshot.messages)) throw new Error("missing native session context in fork snapshot");
    const unfinished = validateToolContext(snapshot.messages);
    match.sourceEntryId = snapshot.leafId;
    if (unfinished) {
      const callIds = unfinished.content.filter((block) => block.type === "toolCall").map((block) => block.id);
      const index = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "assistant"
        && entry.message.content?.some((block) => block.type === "toolCall" && callIds.includes(block.id)));
      if (index < 1 || !branch.slice(0, index).some((entry) => entry.type === "message" && entry.message.role === "assistant")) {
        throw new Error("cannot safely trim unfinished tools to a completed native checkpoint");
      }
      match.sourceEntryId = branch[index - 1].id;
      match.trimmedIncompleteTools = true;
    }
    match.sourceSnapshot = { header: snapshot.header, entries: snapshot.entries };
  }
  return match;
}

export function createForkedSession(sourceSessionFile, sourceEntryId, snapshot) {
  const { header, entries } = snapshot ?? readSession(sourceSessionFile);
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
    readSnapshot: input.readSnapshot,
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
