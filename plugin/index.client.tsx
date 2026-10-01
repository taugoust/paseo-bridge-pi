import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeClient } from "./client/main";
import { contributeHarness } from "./client/harness";
import { contributeForegroundTasks } from "./client/foreground-tasks";

export default function contribute(client: PluginClientContext) {
  const stopPrompts = contributeClient(client);
  try {
    const stopHarness = contributeHarness(client);
    const stopForegroundTasks = contributeForegroundTasks(client);
    return () => { stopForegroundTasks(); stopHarness(); stopPrompts(); };
  } catch (error) {
    stopPrompts();
    throw error;
  }
}
