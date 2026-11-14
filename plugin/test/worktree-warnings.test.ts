import assert from "node:assert/strict";
import test from "node:test";
import { worktreeWarningSummary } from "../client/worktree-warnings.ts";

test("each worktree warning gets its own summary", () => {
  for (const timeout of [
    "Still loading some worktrees; showing what was found so far. Open a repository directly for a narrower view.",
    "Worktree discovery timed out; cached or partial data is shown. Open a repository directly for a narrower view.",
    "Worktree inventory timed out; open a repository directly for a narrower view.",
  ]) assert.equal(worktreeWarningSummary(timeout), "Still loading some worktrees; showing what was found so far.");
  assert.equal(worktreeWarningSummary("Some Goal worktree ancestry is unavailable; only verified associations are shown."),
    "Some worktrees couldn't be matched to their goal.");
  assert.equal(worktreeWarningSummary("Cannot list worktrees for /a\nCannot list worktrees for /b"),
    "Some repositories' worktrees couldn't be read.", "repeated kinds appear once");
  assert.equal(worktreeWarningSummary("Showing the first 100 worktrees; open a repository directly to inspect more.\nSomething new"),
    "Showing the first 100 worktrees. Some worktrees couldn't be listed.");
});
