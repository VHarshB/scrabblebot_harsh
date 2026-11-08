import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
