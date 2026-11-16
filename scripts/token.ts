// Prints a local development service token: bun scripts/token.ts <subject>
import { devToken } from "../src/auth";
const secret = process.env.DEV_AUTH_SECRET ?? "";
if (process.env.AUTH_MODE !== "dev" || secret.length < 32)
  throw new Error("Development tokens need AUTH_MODE=dev and DEV_AUTH_SECRET (see .env)");
console.log(await devToken(secret, process.argv[2] ?? "demo-user"));
