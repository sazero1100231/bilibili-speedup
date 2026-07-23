import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "release");

if (path.dirname(output) !== root || path.basename(output) !== "release") {
  throw new Error(`Refusing to replace unexpected output path: ${output}`);
}

const runtimeFiles = [
  "LICENSE",
  "README.md",
  "README.en.md",
  "icons/icon-128.png",
  "rules/blocked-endpoints.json",
  "rules/cdn-pool.json",
  "rules/cosmetic-selectors.json",
  "rules/tracking-params.json",
  "src/background/service-worker.js",
  "src/content/bridge.js",
  "src/content/main-world.js",
  "src/lib/cdn-selection.js",
  "src/lib/cosmetic.js",
  "src/lib/defaults.js",
  "src/lib/dnr.js",
  "src/lib/probe-scheduler.js",
  "src/lib/prober.js",
  "src/lib/stream-policy.js",
  "src/lib/url-utils.js",
  "src/ui/common.css",
  "src/ui/diagnostics.html",
  "src/ui/diagnostics.js",
  "src/ui/options.html",
  "src/ui/options.js",
  "src/ui/popup-settings.js",
  "src/ui/popup.html",
  "src/ui/popup.js"
];

const releaseManifest = JSON.parse(
  readFileSync(path.join(root, "manifest.release.json"), "utf8")
);
const packageMetadata = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8")
);

if (releaseManifest.version !== packageMetadata.version) {
  throw new Error("Release manifest and package versions must match");
}
if (
  releaseManifest.permissions?.includes("declarativeNetRequestFeedback")
) {
  throw new Error("Release manifest must not expose DNR feedback");
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const relativePath of runtimeFiles) {
  const source = path.join(root, relativePath);
  const destination = path.join(output, relativePath);
  if (!existsSync(source)) {
    throw new Error(`Missing release input: ${relativePath}`);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

writeFileSync(
  path.join(output, "manifest.json"),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
  "utf8"
);

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(prefix, entry.name);
    return entry.isDirectory()
      ? listFiles(path.join(directory, entry.name), relativePath)
      : [relativePath];
  });
}

const expectedFiles = [...runtimeFiles, "manifest.json"].sort();
const actualFiles = listFiles(output).sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(
    `Unexpected release contents:\n${actualFiles.join("\n")}`
  );
}

const manifestFiles = [
  releaseManifest.background?.service_worker,
  releaseManifest.action?.default_popup,
  releaseManifest.options_page,
  ...Object.values(releaseManifest.icons ?? {}),
  ...Object.values(releaseManifest.action?.default_icon ?? {})
].filter(Boolean);

for (const relativePath of manifestFiles) {
  if (!existsSync(path.join(output, relativePath))) {
    throw new Error(`Manifest references missing release file: ${relativePath}`);
  }
}

console.log(
  `Release directory created: ${output} (${actualFiles.length} files)`
);
