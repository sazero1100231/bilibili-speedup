import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSafeCosmeticSelector } from "../src/lib/cosmetic.js";
import { compileDynamicRules, MAX_DYNAMIC_RULES } from "../src/lib/dnr.js";
import { normalizeSettings } from "../src/lib/defaults.js";
import {
  CJK_PATTERN,
  translateToEnglish
} from "../scripts/ui-en-locale.js";
import {
  isAllowedMediaHostname,
  isAllowedMediaUrl
} from "../src/lib/url-utils.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function json(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const fullPath = path.join(directory, name);
    return statSync(fullPath).isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const manifest = json("manifest.json");
const releaseManifest = json("manifest.release.json");
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, [
  "declarativeNetRequest",
  "declarativeNetRequestFeedback",
  "storage",
  "scripting"
]);
assert.deepEqual(manifest.host_permissions, [
  "*://*.bilibili.com/*",
  "https://*.bilivideo.com/*",
  "https://upos-hz-mirrorakam.akamaized.net/*",
  "https://*.bilivideo.cn/*",
  "*://b23.tv/*"
]);
assert.equal(releaseManifest.manifest_version, 3);
for (const candidate of [manifest, releaseManifest]) {
  const csp = candidate.content_security_policy?.extension_pages ?? "";
  assert.ok(csp.includes("script-src 'self'"), "Missing strict script-src CSP");
  assert.ok(csp.includes("object-src 'none'"), "Missing object-src 'none' CSP");
}
assert.deepEqual(releaseManifest.permissions, [
  "declarativeNetRequest",
  "storage",
  "scripting"
]);
assert.deepEqual(releaseManifest.host_permissions, manifest.host_permissions);
assert.equal(
  releaseManifest.permissions.includes("declarativeNetRequestFeedback"),
  false
);
for (const forbidden of ["tabs", "history", "cookies", "<all_urls>"]) {
  assert.equal(manifest.permissions.includes(forbidden), false);
  assert.equal(manifest.host_permissions.includes(forbidden), false);
}

for (const reference of [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page
]) {
  assert.ok(existsSync(path.join(root, reference)), `Missing ${reference}`);
}
for (const iconPath of Object.values(manifest.icons ?? {})) {
  assert.ok(existsSync(path.join(root, iconPath)), `Missing ${iconPath}`);
}
assert.deepEqual(releaseManifest.icons, manifest.icons);
const icon = readFileSync(path.join(root, manifest.icons["128"]));
assert.equal(icon.subarray(1, 4).toString("ascii"), "PNG");
assert.equal(icon.readUInt32BE(16), 128);
assert.equal(icon.readUInt32BE(20), 128);

const sourceFiles = walk(path.join(root, "src")).filter((file) =>
  /\.(?:js|html|css)$/.test(file)
);
const forbiddenPatterns = [
  [/\beval\s*\(/, "eval"],
  [/\bnew\s+Function\b/, "new Function"],
  [/import\s*\(\s*["']https?:\/\//i, "remote dynamic import"],
  [/<script[^>]+src=["']https?:\/\//i, "remote script"],
  [/<link[^>]+href=["']https?:\/\//i, "remote stylesheet"],
  [/@import\s+(?:url\()?["']?https?:\/\//i, "remote CSS import"],
  [/\bchrome\.cookies\b/, "cookies API"],
  [/\bdocument\.cookie\b/, "cookie access"]
];
for (const file of sourceFiles) {
  const source = readFileSync(file, "utf8");
  for (const [pattern, label] of forbiddenPatterns) {
    assert.equal(pattern.test(source), false, `${label} found in ${file}`);
  }
  if (file.endsWith(".html")) {
    for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      assert.equal(match[1].trim(), "", `Inline script found in ${file}`);
    }
  }
}

const packageJson = json("package.json");
assert.equal(packageJson.dependencies, undefined);
assert.equal(packageJson.devDependencies, undefined);
assert.equal(packageJson.version, manifest.version);
assert.equal(releaseManifest.version, manifest.version);

assert.equal(
  manifest.host_permissions.some((permission) =>
    permission.includes("*.akamaized.net")
  ),
  false,
  "Akamai permission must name the Bilibili-controlled host explicitly"
);
for (const rejected of [
  "http://a.bilivideo.com/path/video.m4s",
  "https://fixture:@a.bilivideo.com/path/video.m4s",
  "https://a.bilivideo.com/path/video.m4s#fragment",
  "https://tenant.akamaized.net/path/video.m4s"
]) {
  assert.equal(isAllowedMediaUrl(rejected), false, rejected);
}
assert.equal(
  isAllowedMediaUrl(
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?token=x"
  ),
  true
);
const proberSource = readFileSync(
  path.join(root, "src/lib/prober.js"),
  "utf8"
);
assert.ok(proberSource.includes('redirect: "error"'));
assert.equal(proberSource.includes('redirect: "follow"'), false);

const pool = json("rules/cdn-pool.json");
const tracking = json("rules/tracking-params.json");
const endpoints = json("rules/blocked-endpoints.json");
const cosmetic = json("rules/cosmetic-selectors.json");
const dnrCatalog = json("rules/dnr-static.json");
const ruleEntries = [
  ...pool.preferred,
  ...pool.conditional,
  ...pool.blocked,
  ...tracking.params,
  ...tracking.protected_params,
  ...endpoints.endpoints,
  ...cosmetic.selectors,
  ...dnrCatalog.rule_classes
];
for (const entry of ruleEntries) {
  assert.ok(
    typeof entry.rationale === "string" && entry.rationale.length >= 4,
    `Missing rationale: ${JSON.stringify(entry)}`
  );
}

for (const entry of [...pool.preferred, ...pool.conditional]) {
  assert.ok(
    isAllowedMediaHostname(entry.host),
    `CDN candidate outside the Bilibili media surface: ${entry.host}`
  );
}
for (const entry of pool.blocked) {
  assert.equal(
    Object.hasOwn(entry, "dnr_id") || Object.hasOwn(entry, "dnr_regex"),
    false,
    "Blocked-host catalog must not compile legacy global media redirects"
  );
}
assert.ok(
  dnrCatalog.rule_classes.some(
    (entry) => entry.id_range === "4000000-4999999"
  ),
  "Missing tab-scoped session media-rule audit range"
);
for (const entry of cosmetic.selectors) {
  assert.ok(
    isSafeCosmeticSelector(entry.selector),
    `Cosmetic selector could escape the hiding-only guarantee: ${entry.selector}`
  );
}

const allEnabledSettings = normalizeSettings(undefined, endpoints.endpoints);
for (const endpoint of endpoints.endpoints) {
  allEnabledSettings.privacy.endpointToggles[endpoint.id] = true;
}
const dynamicRules = compileDynamicRules({
  settings: allEnabledSettings,
  trackingParams: tracking.params.map((entry) => entry.param),
  endpoints: endpoints.endpoints,
  blockedHosts: pool.blocked,
  selectedHost: pool.preferred[0].host
});
assert.ok(dynamicRules.length <= MAX_DYNAMIC_RULES);
assert.equal(
  new Set(dynamicRules.map((rule) => rule.id)).size,
  dynamicRules.length
);
for (const rule of dynamicRules) {
  if (rule.condition.regexFilter) {
    assert.doesNotThrow(() => new RegExp(rule.condition.regexFilter));
    assert.equal(
      /\(\?<?[=!]/.test(rule.condition.regexFilter),
      false,
      `Lookaround is not RE2-compatible in rule ${rule.id}`
    );
  }
}

for (const required of [
  "test/run-security-boundary.js",
  "test/run-stream-concurrency.js",
  "test/e2e/stream-concurrency-smoke.js",
  "test/e2e/live-stream-soak.js"
]) {
  assert.ok(existsSync(path.join(root, required)), `Missing ${required}`);
}
assert.equal(
  packageJson.scripts["test:stream-concurrency"],
  "node test/run-stream-concurrency.js"
);
assert.equal(
  packageJson.scripts["test:e2e:stream-concurrency"],
  "node test/e2e/stream-concurrency-smoke.js"
);
assert.equal(
  packageJson.scripts["test:live-soak"],
  "node test/e2e/live-stream-soak.js"
);
assert.ok(
  existsSync(path.join(root, "scripts/build-release.js")),
  "Missing release builder"
);

const releaseDirectory = path.join(root, "release");
const englishReleaseDirectory = path.join(root, "release-en");
assert.ok(existsSync(releaseDirectory), "Missing Traditional Chinese release");
assert.ok(existsSync(englishReleaseDirectory), "Missing English release");
const relativeBundleFiles = (directory) =>
  walk(directory)
    .map((file) => path.relative(directory, file).split(path.sep).join("/"))
    .sort();
assert.deepEqual(
  relativeBundleFiles(englishReleaseDirectory),
  relativeBundleFiles(releaseDirectory),
  "English and Traditional Chinese bundles must contain the same files"
);
const builtReleaseManifest = json("release/manifest.json");
const builtEnglishManifest = json("release-en/manifest.json");
assert.equal(builtReleaseManifest.version, packageJson.version);
assert.equal(builtEnglishManifest.version, packageJson.version);
const englishUiFiles = [
  "rules/blocked-endpoints.json",
  "src/ui/diagnostics.html",
  "src/ui/diagnostics.js",
  "src/ui/options.html",
  "src/ui/options.js",
  "src/ui/popup.html",
  "src/ui/popup.js"
];
for (const relativePath of englishUiFiles) {
  const source = readFileSync(path.join(root, relativePath), "utf8");
  const translated = translateToEnglish(source);
  assert.equal(
    CJK_PATTERN.test(translated),
    false,
    `Untranslated English UI text in ${relativePath}`
  );
  assert.equal(
    readFileSync(path.join(englishReleaseDirectory, relativePath), "utf8"),
    translated,
    `Stale English release file: ${relativePath}`
  );
}
const expectedEnglishManifest = translateToEnglish(
  `${JSON.stringify(releaseManifest, null, 2)}\n`
);
assert.equal(CJK_PATTERN.test(expectedEnglishManifest), false);
assert.equal(
  readFileSync(path.join(englishReleaseDirectory, "manifest.json"), "utf8"),
  expectedEnglishManifest,
  "Stale English release manifest"
);

console.log(
  `Validated MV3 manifest, ${sourceFiles.length} source files, ${ruleEntries.length} auditable rules, and ${dynamicRules.length} worst-case DNR rules.`
);
