import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
if (!compilerPath) {
  throw new Error("Set PASEO_PLUGIN_COMPILER to Paseo 0.10 server/plugins/compiler.js to run the host plugin compiler.");
}
const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundles = await compilePlugin({
  client: resolve(root, "index.client.tsx"),
  server: resolve(root, "index.server.ts"),
});
if (!bundles.clientBundle || !bundles.serverBundle) throw new Error("Paseo compiler did not emit both plugin bundles");
console.log(`Paseo plugin compile passed (client ${bundles.clientBundle.length} bytes, server ${bundles.serverBundle.length} bytes).`);
