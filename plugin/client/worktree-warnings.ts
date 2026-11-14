// Short summaries for the Worktrees tab's warnings. Pi sends one or more
// warning lines; each kind gets its own plain summary instead of one generic text.
const summaries: [RegExp, string][] = [
  [/^(Still loading some worktrees|Worktree (discovery|inventory) timed out)/, "Still loading some worktrees; showing what was found so far."],
  [/^Some Goal worktree ancestry is unavailable/, "Some worktrees couldn't be matched to their goal."],
  [/^Cannot list worktrees for /, "Some repositories' worktrees couldn't be read."],
  [/^Repository discovery is limited/, "Only nearby repositories are shown."],
  [/^Showing the first 100 worktrees/, "Showing the first 100 worktrees."],
];

export function worktreeWarningSummary(error: string): string {
  const found: string[] = [];
  for (const line of error.split("\n").map(line => line.trim()).filter(Boolean)) {
    const summary = summaries.find(([pattern]) => pattern.test(line))?.[1] ?? "Some worktrees couldn't be listed.";
    if (!found.includes(summary)) found.push(summary);
  }
  return found.join(" ") || "Some worktrees couldn't be listed.";
}
