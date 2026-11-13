import type { z } from "zod";
import type { workflowSnapshotSchema } from "../shared/workflows";
import type { DelegatedGoal } from "./delegated-goals";
type Snapshot = z.infer<typeof workflowSnapshotSchema>;
export type AssignedTicket = Pick<DelegatedGoal, "text" | "status" | "summary"> & {
  binding: "current-session";
  /** Compatibility alias; presentation logic should use binding. */
  assigned: true;
  /** Stable source identity from the owning session; never a React key. */
  sourceId: string;
  /** Session-scoped selection identity retained for UI compatibility. */
  id: string;
  reactKey: string;
  tasks: NonNullable<NonNullable<Snapshot["goal"]>["tasks"]>;
  child?: never; revision?: number; story?: never;
  activationId?: string;
  endedAt?: number;
  waitDeadline?: number | null;
  lastTaskUpdateAt?: number | null;
  lastWake?: NonNullable<Snapshot["goal"]>["lastWake"];
  lastBlocker?: NonNullable<Snapshot["goal"]>["lastBlocker"];
  sourceGoalId?: string; policyRevision?: number;
  continuationLimits?: DelegatedGoal["continuationLimits"];
  effectiveLimits?: DelegatedGoal["continuationLimits"];
  waiting?: string | null; tokensUsed?: number; tokenBudget?: number | null;
  automaticTurns?: number; noProgressTurns?: number;
  prs?: DelegatedGoal["prs"]; checks?: DelegatedGoal["checks"];
};
/** Presentation only: never create registry records, revisions, or execution links. */
export function assignedTickets(goal: Snapshot["goal"], completed: NonNullable<Snapshot["completedGoals"]> = []): AssignedTicket[] {
  const records: AssignedTicket[] = completed.filter(item => item.id !== goal?.id).map(item => ({
    binding: "current-session", assigned: true, sourceId: item.id, id: `assigned:${item.id}`, reactKey: `current-session:${item.id}`, text: item.text,
    status: item.status === "completed" ? "complete" : "cleared", summary: item.summary, tasks: item.tasks, endedAt: item.endedAt,
  }));
  if (goal) records.unshift({
    ...goal, binding: "current-session", assigned: true, sourceId: goal.id, sourceGoalId: goal.id,
    id: `assigned:${goal.id}`, reactKey: `current-session:${goal.id}`, tasks: goal.tasks ?? [],
  });
  return records;
}
