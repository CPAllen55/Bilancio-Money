/**
 * Creates the caching Hyperdrive config, without anybody having to paste a
 * connection string into a shell.
 *
 *   npm run hyperdrive:cached
 *
 * The string is read from .env and handed to wrangler as an argv element
 * rather than as part of a command line, so nothing in it — the ? and & of a
 * query string, a $ or a & in a password — can be interpreted by PowerShell on
 * the way through. That is the entire reason this file exists: doing it by hand
 * is three lines of quoting that have to be exactly right, and getting it
 * subtly wrong produces a config that fails later rather than now.
 *
 * The result is a SECOND Hyperdrive config onto the same database as the
 * existing one, with caching left on. See wrangler.jsonc for why there are two.
 */
import "dotenv/config";
import { spawn } from "node:child_process";

const NAME = "bilancio-cached";

const url = process.env.DATABASE_URL_PROD;
if (!url) {
  console.error("No DATABASE_URL_PROD in .env — nothing to point the config at.");
  process.exit(1);
}
if (!url.startsWith("postgresql://") && !url.startsWith("postgres://")) {
  console.error("DATABASE_URL_PROD does not look like a connection string.");
  process.exit(1);
}
if (url.includes("*")) {
  console.error("DATABASE_URL_PROD contains a *, which usually means the password was copied while it was still masked.");
  process.exit(1);
}

// The password, never printed. Everything else is safe to show, and showing it
// is how you confirm this is production rather than the dev branch.
const shown = url.replace(/:[^:@/]+@/, ":****@");
console.log(`Creating Hyperdrive config "${NAME}", caching ON, pointed at:`);
console.log(`  ${shown}\n`);

/* windows needs the .cmd shim, and shell:true with it — but the connection
   string still travels as its own argv entry, so it is never parsed. */
const isWindows = process.platform === "win32";
const child = spawn(
  isWindows ? "npx.cmd" : "npx",
  ["wrangler", "hyperdrive", "create", NAME, "--connection-string", url],
  { stdio: "inherit", shell: isWindows },
);

child.on("exit", (code) => {
  if (code === 0) {
    console.log("\nCopy the id above into wrangler.jsonc, in the HYPERDRIVE_CACHED");
    console.log("entry that is commented out there, then commit and push.");
  }
  process.exit(code ?? 1);
});
