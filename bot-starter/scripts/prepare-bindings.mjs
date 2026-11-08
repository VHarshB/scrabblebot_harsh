import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const source = new URL("../../src/module_bindings/", import.meta.url);
const target = new URL("../src/module_bindings/", import.meta.url);
mkdirSync(target, { recursive: true });
function copy(source, target) {
  mkdirSync(target, { recursive: true });
  for (const item of readdirSync(source, { withFileTypes: true })) {
    const name = item.name;
    if (item.isDirectory()) {
      copy(new URL(name + "/", source), new URL(name + "/", target));
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(new URL(name, source), "utf8").replace(
      /(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
      (_, a, b, c) => a + b + (/\.[a-z]+$/i.test(b) ? "" : ".js") + c,
    );
    writeFileSync(new URL(name, target), text);
  }
}
copy(source, target);
