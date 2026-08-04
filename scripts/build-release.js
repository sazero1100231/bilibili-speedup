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
import { CJK_PATTERN, translateToEnglish } from "./ui-en-locale.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Two sibling bundles are produced:
//   release/     Traditional Chinese, copied verbatim from src.
//   release-en/  English operator UI, for users who prefer an English build
//                without cloning and building the project.
const bundles = [
  { dir: "release", english: false },
  { dir: "release-en", english: true }
];

// Files whose operator-facing Chinese text is translated to English in the
// English bundle. Everything else is copied verbatim in both bundles.
const englishUiFiles = new Set([
  "rules/blocked-endpoints.json",
  "src/ui/diagnostics.html",
  "src/ui/diagnostics.js",
  "src/ui/options.html",
  "src/ui/options.js",
  "src/ui/popup.html",
  "src/ui/popup.js"
]);

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
if (releaseManifest.permissions?.includes("declarativeNetRequestFeedback")) {
  throw new Error("Release manifest must not expose DNR feedback");
}

// Translate and fail loudly if any Chinese slips through, so a bundle labelled
// English can never ship mixed-language text.
function toEnglish(relativePath, content) {
  const translated = translateToEnglish(content);
  const leftover = translated.match(CJK_PATTERN);
  if (leftover) {
    const index = translated.indexOf(leftover[0]);
    const context = translated.slice(Math.max(0, index - 30), index + 30);
    throw new Error(
      `Untranslated text in ${relativePath}: …${context}… ` +
        "(add the missing run to scripts/ui-en-locale.js)"
    );
  }
  return translated;
}

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(prefix, entry.name);
    return entry.isDirectory()
      ? listFiles(path.join(directory, entry.name), relativePath)
      : [relativePath];
  });
}

function buildBundle({ dir, english }) {
  const output = path.resolve(root, dir);
  if (path.dirname(output) !== root || path.basename(output) !== dir) {
    throw new Error(`Refusing to replace unexpected output path: ${output}`);
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
    if (english && englishUiFiles.has(relativePath)) {
      writeFileSync(
        destination,
        toEnglish(relativePath, readFileSync(source, "utf8")),
        "utf8"
      );
    } else {
      copyFileSync(source, destination);
    }
  }

  const manifestJson = `${JSON.stringify(releaseManifest, null, 2)}\n`;
  writeFileSync(
    path.join(output, "manifest.json"),
    english ? toEnglish("manifest.json", manifestJson) : manifestJson,
    "utf8"
  );

  const expectedFiles = [...runtimeFiles, "manifest.json"].sort();
  const actualFiles = listFiles(output).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Unexpected ${dir} contents:\n${actualFiles.join("\n")}`);
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
      throw new Error(`Manifest references missing ${dir} file: ${relativePath}`);
    }
  }

  console.log(
    `${english ? "English " : ""}bundle created: ${output} (${actualFiles.length} files)`
  );
}

for (const bundle of bundles) {
  buildBundle(bundle);
}
