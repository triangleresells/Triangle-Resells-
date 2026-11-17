/** Prints when IG_ACCESS_TOKEN expires (never prints the token).  npx tsx --env-file=.env scripts/token-expiry.ts */
import { InstagramClient } from "../src/instagram.js";
const t = process.env.IG_ACCESS_TOKEN?.trim() ?? "";
console.log("token expires:", (await new InstagramClient(t, process.env.IG_API_VERSION || "v23.0").tokenExpiry()) ?? "unknown / never");
