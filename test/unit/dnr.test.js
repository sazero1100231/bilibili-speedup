import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_DYNAMIC_RULES,
  compileDynamicRules,
  compileSessionMediaRules
} from "../../src/lib/dnr.js";
import { normalizeSettings } from "../../src/lib/defaults.js";

async function json(path) {
  return JSON.parse(
    await readFile(new URL(`../../${path}`, import.meta.url), "utf8")
  );
}

test("dynamic rules are stable, unique, and below quota", async () => {
  const [tracking, endpoints, pool] = await Promise.all([
    json("rules/tracking-params.json"),
    json("rules/blocked-endpoints.json"),
    json("rules/cdn-pool.json")
  ]);
  const settings = normalizeSettings(undefined, endpoints.endpoints);
  const rules = compileDynamicRules({
    settings,
    trackingParams: tracking.params.map((entry) => entry.param),
    endpoints: endpoints.endpoints,
    blockedHosts: pool.blocked,
    selectedHost: pool.preferred[0].host
  });
  assert.equal(rules.length, 5);
  assert.ok(rules.length <= MAX_DYNAMIC_RULES);
  assert.equal(new Set(rules.map((rule) => rule.id)).size, rules.length);
  assert.deepEqual(
    rules.map((rule) => rule.id),
    [1001, 1002, 2001, 2002, 2003]
  );
  for (const rule of rules) {
    if (rule.id >= 2001 && rule.id <= 2099) {
      assert.deepEqual(rule.condition.initiatorDomains, [
        "bilibili.com",
        "b23.tv"
      ]);
    }
    if (rule.id >= 3001 && rule.id <= 3099) {
      assert.deepEqual(rule.condition.initiatorDomains, ["bilibili.com"]);
    }
  }
});

test("media fallback rules are tab-scoped and redirect to an exact signed URL", () => {
  const source =
    "https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s?upsig=source";
  const target =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=target";
  const rules = compileSessionMediaRules({
    tabId: 27,
    routes: [{ urls: [source, target] }],
    degradedRoutes: {
      "/path/video.m4s": ["upos-sz-mirrorcosov.bilivideo.com"]
    },
    startId: 4_000_000
  });
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].condition.tabIds, [27]);
  assert.equal(rules[0].action.redirect.url, target);
  assert.equal(
    rules[0].action.redirect.url.includes("upsig=source"),
    false
  );
  assert.match(source, new RegExp(rules[0].condition.regexFilter));
});

test("media degradation is isolated to one representation", () => {
  const videoSource =
    "https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s?upsig=video-source";
  const videoTarget =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=video-target";
  const audioSource =
    "https://upos-sz-mirrorcosov.bilivideo.com/path/audio.m4s?upsig=audio-source";
  const audioTarget =
    "https://upos-hz-mirrorakam.akamaized.net/path/audio.m4s?hdnts=audio-target";
  const rules = compileSessionMediaRules({
    tabId: 27,
    routes: [
      { urls: [videoSource, videoTarget] },
      { urls: [audioSource, audioTarget] }
    ],
    degradedRoutes: {
      "/path/video.m4s": ["upos-sz-mirrorcosov.bilivideo.com"]
    },
    startId: 4_000_000
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].action.redirect.url, videoTarget);
  assert.doesNotMatch(audioSource, new RegExp(rules[0].condition.regexFilter));
});

test("same-path concurrent presentations use exact signed source rules", () => {
  const sourceA =
    "https://upos-sz-mirrorcosov.bilivideo.com/path/shared.m4s?upsig=A";
  const sourceB =
    "https://upos-sz-mirrorcosov.bilivideo.com/path/shared.m4s?upsig=B";
  const targetA =
    "https://upos-hz-mirrorakam.akamaized.net/path/shared.m4s?hdnts=A";
  const targetB =
    "https://upos-hz-mirrorakam.akamaized.net/path/shared.m4s?hdnts=B";
  const rules = compileSessionMediaRules({
    tabId: 27,
    routes: [
      {
        stateKey: "presentation-a::/path/shared.m4s",
        presentationId: "presentation-a",
        urls: [sourceA, targetA]
      },
      {
        stateKey: "presentation-b::/path/shared.m4s",
        presentationId: "presentation-b",
        urls: [sourceB, targetB]
      }
    ],
    degradedRoutes: {
      "presentation-a::/path/shared.m4s": [
        "upos-sz-mirrorcosov.bilivideo.com"
      ]
    },
    startId: 4_000_000
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].action.redirect.url, targetA);
  const sourcePattern = new RegExp(rules[0].condition.regexFilter);
  assert.match(sourceA, sourcePattern);
  assert.doesNotMatch(sourceB, sourcePattern);
  assert.equal(targetB === rules[0].action.redirect.url, false);
});

test("session fallback never selects a statically blocked backup as target", () => {
  const failedSource =
    "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?upsig=source";
  const blockedBackup =
    "https://upos-sz-mirroraliov.bilivideo.com/path/video.m4s?upsig=blocked";
  const safeBackup =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=safe";
  const rules = compileSessionMediaRules({
    tabId: 27,
    routes: [{ urls: [failedSource, blockedBackup, safeBackup] }],
    degradedRoutes: {
      "/path/video.m4s": ["upos-sz-mirrorcos.bilivideo.com"]
    },
    blockedHostPatterns: ["^upos-.*ov\\.bilivideo\\.com$"],
    startId: 4_000_000
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].action.redirect.url, safeBackup);
});

test("global dynamic rules never compile host-substitution media redirects", async () => {
  const [tracking, endpoints, pool] = await Promise.all([
    json("rules/tracking-params.json"),
    json("rules/blocked-endpoints.json"),
    json("rules/cdn-pool.json")
  ]);
  const settings = normalizeSettings(undefined, endpoints.endpoints);
  const rules = compileDynamicRules({
    settings,
    trackingParams: tracking.params.map((entry) => entry.param),
    endpoints: endpoints.endpoints,
    blockedHosts: pool.blocked,
    selectedHost: "evil.example.com"
  });
  assert.equal(
    rules.some((rule) => rule.id >= 3001 && rule.id <= 3099),
    false
  );
});

test("global disable compiles no rules", async () => {
  const endpoints = await json("rules/blocked-endpoints.json");
  const settings = normalizeSettings(undefined, endpoints.endpoints);
  settings.globalEnabled = false;
  assert.deepEqual(
    compileDynamicRules({
      settings,
      trackingParams: ["vd_source"],
      endpoints: endpoints.endpoints,
      blockedHosts: [],
      selectedHost: "upos-sz-mirrorcos.bilivideo.com"
    }),
    []
  );
});

test("URL cleaning excludes passport and preserves a single transform rule payload", async () => {
  const [tracking, endpoints] = await Promise.all([
    json("rules/tracking-params.json"),
    json("rules/blocked-endpoints.json")
  ]);
  const settings = normalizeSettings(undefined, endpoints.endpoints);
  settings.acceleration.enabled = false;
  settings.privacy.telemetryBlocking = false;
  const rules = compileDynamicRules({
    settings,
    trackingParams: tracking.params.map((entry) => entry.param),
    endpoints: endpoints.endpoints,
    blockedHosts: [],
    selectedHost: ""
  });
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].condition.excludedRequestDomains, [
    "passport.bilibili.com"
  ]);
  assert.ok(
    rules[0].action.redirect.transform.queryTransform.removeParams.includes(
      "vd_source"
    )
  );
});
