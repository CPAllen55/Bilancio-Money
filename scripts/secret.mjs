/**
 * Putting a secret into Cloudflare from a file, rather than through a shell.
 *
 * Pasting a multi-line secret -- a service account's JSON, a .p8 key -- into
 * PowerShell mangles it: quotes are eaten, newlines become spaces, and what
 * arrives is not what was copied. This reads the file as bytes and hands it to
 * wrangler on stdin, so nothing interprets it on the way.
 *
 *   npm run secret -- FCM_SERVICE_ACCOUNT C:\Users\you\Downloads\key.json
 *
 * The value is never printed, and the file is left where it is: deleting
 * somebody's only copy of a key is not this script's decision.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [name, file] = process.argv.slice(2);

if (!name || !file) {
  console.error("Usage: npm run secret -- <NAME> <path to file>");
  process.exit(1);
}
if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
  console.error(`"${name}" is not a secret name. They are capitals and underscores.`);
  process.exit(1);
}

let value;
try {
  value = readFileSync(file, "utf8").trim();
} catch (err) {
  console.error(`Could not read ${file}: ${err.message}`);
  process.exit(1);
}
if (!value) {
  console.error(`${file} is empty.`);
  process.exit(1);
}

/* A sanity check that the right file was named, without showing it. JSON keys
   are the common case here and a truncated download is the common mistake. */
if (value.startsWith("{")) {
  try {
    const parsed = JSON.parse(value);
    console.log(`Read ${file}: JSON for ${parsed.client_email ?? "an account"}.`);
  } catch {
    console.error(`${file} starts like JSON but will not parse. Download it again.`);
    process.exit(1);
  }
} else {
  console.log(`Read ${file}: ${value.length} characters.`);
}

console.log(`Setting ${name} on the production Worker…`);
const run = spawnSync("npx", ["wrangler", "secret", "put", name], {
  input: value,
  stdio: ["pipe", "inherit", "inherit"],
  shell: process.platform === "win32",
});
process.exit(run.status ?? 1);
