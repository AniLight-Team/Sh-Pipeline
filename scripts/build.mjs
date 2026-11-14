import { spawnSync } from "node:child_process";

const commands = [["node_modules/vite/bin/vite.js", "build"]];
if (!process.argv.includes("--ui-only")) commands.push(["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json"]);
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
