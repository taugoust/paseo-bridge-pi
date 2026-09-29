import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeClient } from "./client/main";
import { contributeHarness } from "./client/harness";

export default function contribute(client: PluginClientContext) {
  const stopPrompts = contributeClient(client);
  try {
    const stopHarness = contributeHarness(client);
    return () => { stopHarness(); stopPrompts(); };
  } catch (error) {
    stopPrompts();
    throw error;
  }
}
