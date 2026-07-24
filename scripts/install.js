import os from "node:os";
import {
  extensionDir,
  isOurShimCommand,
  norm,
  paseoConfigPath,
  piSettingsPath,
  readJson,
  samePath,
  shimPath,
  writeJson,
} from "./config.js";

// Note: npm also runs this as the "install" lifecycle hook during a plain
// `npm install`, so checking out the repo and installing dependencies
// registers the bridge in one step.
//
// When this package is installed *by pi* (pi install git:/npm:), pi manages
// extension discovery itself and runs npm install in the package dir - do
// nothing there, or the extension would be registered twice.
const normalizedDir = norm(extensionDir).toLowerCase();
const tmpDir = norm(os.tmpdir()).toLowerCase();
const piManaged =
  normalizedDir.includes("/.pi/agent/git/") ||
  normalizedDir.includes("/.pi/agent/npm/") ||
  normalizedDir.includes("/.pi/git/") ||
  normalizedDir.includes("/.pi/npm/") ||
  normalizedDir.includes("/.pi/agent/tmp/") ||
  normalizedDir.startsWith(`${tmpDir}/`);
if (piManaged) {
  console.log("paseo-bridge-pi: installed as a pi package. Run /paseo-bridge install inside pi to set up the Paseo shim.");
  process.exit(0);
}

let changed = false;

// 1. Register the pi extension via ~/.pi/agent/settings.json `extensions`.
const settings = readJson(piSettingsPath) ?? {};
settings.extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
if (settings.extensions.some((entry) => samePath(entry, extensionDir))) {
  console.log(`pi extension already registered in ${piSettingsPath}`);
} else {
  settings.extensions.push(extensionDir);
  writeJson(piSettingsPath, settings);
  console.log(`registered pi extension ${extensionDir} in ${piSettingsPath}`);
  changed = true;
}

// 2. Point Paseo's pi provider command at the shim.
const config = readJson(paseoConfigPath) ?? {};
config.agents = config.agents ?? {};
config.agents.providers = config.agents.providers ?? {};
const currentCommand = config.agents.providers.pi?.command;
if (isOurShimCommand(currentCommand)) {
  console.log(`paseo shim already registered in ${paseoConfigPath}`);
} else if (currentCommand) {
  console.error(`ERROR: ${paseoConfigPath} already overrides the pi provider command:`);
  console.error(`  ${JSON.stringify(currentCommand)}`);
  console.error("Remove agents.providers.pi.command manually, then re-run `npm run install`.");
  process.exit(1);
} else {
  config.agents.providers.pi = {
    ...(config.agents.providers.pi ?? {}),
    command: [norm(process.execPath), shimPath],
  };
  writeJson(paseoConfigPath, config);
  console.log(`registered paseo pi provider shim in ${paseoConfigPath}`);
  changed = true;
}

if (changed) {
  console.log("\nDone. Restart the Paseo daemon to apply: paseo restart");
  console.log("(restarting interrupts agents that are currently running)");
} else {
  console.log("\nNothing to do - already installed.");
}
