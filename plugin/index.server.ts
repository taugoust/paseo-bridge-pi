import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createHandlers, readOperatorDescriptor } from "./server/operator";
import { permissionGateSetRpc, permissionGateStatusRpc } from "./shared/permission-gate";
import { harnessJobsListRpc, harnessJobsOutputRpc, harnessSubagentsListRpc, harnessSubagentReportRpc, harnessStatusRpc } from "./shared/harness-readonly";
import { createHarnessReadOnlyHandlers } from "./server/harness-readonly";
import { createForegroundTasksHandlers } from "./server/foreground-tasks";
import { foregroundTasksRpc, foregroundTasksStatusRpc } from "./shared/foreground-tasks";

export default function contribute(server: PluginServerContext) {
  const handlers = createHandlers(readOperatorDescriptor);
  server.handle(permissionGateStatusRpc, handlers.status);
  server.handle(permissionGateSetRpc, handlers.set);
  const readonly = createHarnessReadOnlyHandlers();
  server.handle(harnessStatusRpc, readonly.status);
  server.handle(harnessJobsListRpc, readonly.jobsList);
  server.handle(harnessJobsOutputRpc, readonly.jobsOutput);
  server.handle(harnessSubagentsListRpc, readonly.subagentsList);
  server.handle(harnessSubagentReportRpc, readonly.subagentReport);
  const foregroundTasks = createForegroundTasksHandlers();
  server.handle(foregroundTasksStatusRpc, foregroundTasks.status);
  server.handle(foregroundTasksRpc, foregroundTasks.control);
  return () => {};
}
