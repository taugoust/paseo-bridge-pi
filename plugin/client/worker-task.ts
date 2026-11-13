/** The task a worker was started with, read from its first parent message.
 *
 * pi-agent-extensions starts a worker with "Parent instructions:" followed by the task, its
 * acceptance criteria as JSON, then fixed instructions about reporting. Only the task and the
 * criteria are worth showing. Any other message, or one that doesn't parse, returns undefined
 * and is shown as is. */
export function workerTask(text: string): { task: string; acceptance: string[] } | undefined {
  const match = /^(?:Parent instructions:\n)?Task: ([\s\S]*?)\n\nAcceptance criteria: (\[.*\])\n/.exec(text);
  if (!match) return undefined;
  try {
    const acceptance: unknown = JSON.parse(match[2]);
    if (!Array.isArray(acceptance) || !acceptance.every(item => typeof item === "string")) return undefined;
    return { task: match[1].trim(), acceptance };
  } catch {
    return undefined;
  }
}
