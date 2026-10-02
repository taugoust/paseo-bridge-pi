#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const expectedHost = process.env.TEST_EXPECT_HOST;
const expectedHome = process.env.TEST_EXPECT_HOME;
if (expectedHost !== undefined) {
  if (args.join(" ") !== `agent ls -g --json --host ${expectedHost}`) process.exit(21);
  if (process.env.PASEO_HOST !== expectedHost || "PASEO_HOME" in process.env) process.exit(22);
} else {
  if (args.join(" ") !== "agent ls -g --json --home /fixture/home") process.exit(23);
  if (process.env.PASEO_HOME !== "/fixture/home" || process.env.PASEO_HOST !== undefined) process.exit(24);
}
process.stdout.write(JSON.stringify([{ id: "fixture-agent" }]));
