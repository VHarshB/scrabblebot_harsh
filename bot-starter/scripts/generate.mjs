import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../../", import.meta.url));
const local = fileURLToPath(
  new URL("../../.tools/spacetime/spacetimedb-cli.exe", import.meta.url),
);
const executable =
  process.platform === "win32" && existsSync(local) ? local : "spacetime";
const result = spawnSync(
  executable,
  [
    "generate",
    "--lang",
    "typescript",
    "--out-dir",
    "src/module_bindings",
    "--module-path",
    "spacetimedb",
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
