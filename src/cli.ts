#!/usr/bin/env node
import { runCli } from "./commands.js";
import { currentPlatformContext } from "./config.js";
import { runStdioServer } from "./server.js";

const exitCode = await runCli(process.argv.slice(2), {
  platform: currentPlatformContext(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  startServer: () => runStdioServer(),
});
// The server keeps the process alive through stdin; commands exit with their status.
if (process.argv.length > 2) process.exitCode = exitCode;
