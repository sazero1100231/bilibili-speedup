import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const release = process.argv.includes("--release");

function run(relativePath, args = []) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, relativePath), ...args],
    {
      cwd: root,
      env: process.env,
      stdio: "inherit"
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("test/run-stream-concurrency.js");
run("test/e2e/extension-smoke.js", release ? ["--release"] : []);

console.log(
  `Stream concurrency ${release ? "release" : "development"} fixture gate passed. ` +
    "This deterministic gate does not replace live evidence; public UGC T22 is audited separately, and authenticated/member targets remain a user-run manual matrix."
);
