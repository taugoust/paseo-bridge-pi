import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createHandlers, readOperatorDescriptor } from "./server/operator";
import { permissionGateSetRpc, permissionGateStatusRpc } from "./shared/permission-gate";

export default function contribute(server: PluginServerContext) {
  const handlers = createHandlers(readOperatorDescriptor);
  server.handle(permissionGateStatusRpc, handlers.status);
  server.handle(permissionGateSetRpc, handlers.set);
  return () => {};
}
