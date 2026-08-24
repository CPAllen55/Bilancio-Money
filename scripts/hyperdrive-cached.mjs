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
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/* Node is run against wrangler's own entry point rather than the npx shim.
 *
 * The obvious version of this — spawn npx.cmd with shell:true, because Windows
 * cannot execute a .cmd otherwise — undoes the entire point of the file. With
 * shell:true Node concatenates the arguments back into a command line and hands
 * it to cmd.exe, so the connection string is parsed by a shell after all, and
 * Node says so: "arguments are not escaped, only concatenated". A password
 * containing & would be cut in half there.
 *
 * Going straight to the .js needs no shim and therefore no shell, on any
 * platform, and the string stays one argument from here to wrangler. */
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
if (!existsSync(wrangler)) {
  console.error("wrangler is not installed — run npm install first.");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [wrangler, "hyperdrive", "create", NAME, "--connection-string", url],
  { stdio: "inherit" },
);

child.on("exit", (code) => {
  if (code === 0) {
    console.log("\nCopy the id above into wrangler.jsonc, in the HYPERDRIVE_CACHED");
    console.log("entry that is commented out there, then commit and push.");
  }
  process.exit(code ?? 1);
});
