import type { z } from "zod";
import type { workflowSnapshotSchema } from "../shared/workflows";
import type { DelegatedGoal } from "./delegated-goals";
type Snapshot = z.infer<typeof workflowSnapshotSchema>;
export type AssignedTicket = Pick<DelegatedGoal, "text" | "status" | "summary"> & {
  assigned: true;
  id: string;
  tasks: NonNullable<NonNullable<Snapshot["goal"]>["tasks"]>;
  child?: never; revision?: number; story?: never;
  activationId?: string;
  waitDeadline?: number | null;
  lastTaskUpdateAt?: number | null;
  lastWake?: NonNullable<Snapshot["goal"]>["lastWake"];
  lastBlocker?: NonNullable<Snapshot["goal"]>["lastBlocker"];
  sourceGoalId?: string; policyRevision?: number;
  continuationLimits?: DelegatedGoal["continuationLimits"];
  effectiveLimits?: DelegatedGoal["continuationLimits"];
  waiting?: string | null; tokensUsed?: number; tokenBudget?: number | null;
  automaticTurns?: number; noProgressTurns?: number;
};
/** Presentation only: never create registry records, revisions, or execution links. */
export function assignedTickets(goal: Snapshot["goal"], completed: NonNullable<Snapshot["completedGoals"]> = []): AssignedTicket[] {
  const records: AssignedTicket[] = completed.filter(item => item.id !== goal?.id).map(item => ({
    assigned: true, id: `assigned:${item.id}`, text: item.text,
    status: item.status === "completed" ? "complete" : "cleared", summary: item.summary, tasks: item.tasks,
  }));
  if (goal) records.unshift({
    ...goal, assigned: true, sourceGoalId: goal.id, id: `assigned:${goal.id}`, tasks: goal.tasks ?? [],
  });
  return records;
}
