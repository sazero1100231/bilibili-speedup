import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  mainWorldModulesEnabled,
  normalizeRuntimeState,
  normalizeSettings,
  pageModulesEnabled
} from "../../src/lib/defaults.js";

async function json(path) {
  return JSON.parse(
    await readFile(new URL(`../../${path}`, import.meta.url), "utf8")
  );
}

test("settings are bounded and unknown fields are discarded", () => {
  const settings = normalizeSettings({
    globalEnabled: true,
    acceleration: {
      probeCacheMinutes: 999,
      strategy: "invalid",
      injected: true
    },
    diagnostics: { maxSessions: 9999 },
    unknown: true
  });
  assert.equal(settings.acceleration.probeCacheMinutes, 120);
  assert.equal(settings.acceleration.strategy, "auto");
  assert.equal(settings.diagnostics.maxSessions, 500);
  assert.equal("unknown" in settings, false);
  assert.equal("injected" in settings.acceleration, false);
});

test("page and MAIN-world registration follow module switches", () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  assert.equal(pageModulesEnabled(settings), true);
  assert.equal(mainWorldModulesEnabled(settings), true);
  settings.globalEnabled = false;
  assert.equal(pageModulesEnabled(settings), false);
  assert.equal(mainWorldModulesEnabled(settings), false);
});

test("runtime normalization preserves controlled dynamic maps", () => {
  const runtime = normalizeRuntimeState({
    probeCache: {
      "upos.example": {
        host: "upos.example",
        healthy: true,
        measuredAt: 123
      }
    },
    dnrMatchCounts: { 3001: 7 }
  });
  assert.equal(runtime.probeCache["upos.example"].healthy, true);
  assert.equal(runtime.dnrMatchCounts[3001], 7);
});

test("every human-maintained rule entry contains a rationale", async () => {
  const [pool, tracking, endpoints, cosmetic, dnr] = await Promise.all([
    json("rules/cdn-pool.json"),
    json("rules/tracking-params.json"),
    json("rules/blocked-endpoints.json"),
    json("rules/cosmetic-selectors.json"),
    json("rules/dnr-static.json")
  ]);
  const entries = [
    ...pool.preferred,
    ...pool.conditional,
    ...pool.blocked,
    ...tracking.params,
    ...tracking.protected_params,
    ...endpoints.endpoints,
    ...cosmetic.selectors,
    ...dnr.rule_classes
  ];
  assert.ok(entries.length > 40);
  for (const entry of entries) {
    assert.equal(typeof entry.rationale, "string");
    assert.ok(entry.rationale.length >= 4);
  }
});
