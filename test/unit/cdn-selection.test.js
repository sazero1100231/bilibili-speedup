import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  chooseSelectedHost,
  freshHealthyHosts,
  healthyHosts
} from "../../src/lib/cdn-selection.js";
import {
  normalizeRuntimeState,
  normalizeSettings
} from "../../src/lib/defaults.js";

const pool = JSON.parse(
  await readFile(new URL("../../rules/cdn-pool.json", import.meta.url), "utf8")
);

test("auto strategy exposes no selected host before a healthy probe", () => {
  const settings = normalizeSettings();
  const runtime = normalizeRuntimeState();
  assert.equal(chooseSelectedHost(settings, runtime, pool), "");
  assert.deepEqual(healthyHosts(settings, runtime, pool), []);
});

test("auto strategy accepts only fresh healthy probe results", () => {
  const now = Date.now();
  const settings = normalizeSettings();
  const runtime = normalizeRuntimeState({
    selectedHost: pool.preferred[0].host,
    rankedHosts: [pool.preferred[0].host, pool.preferred[1].host],
    probeCache: {
      [pool.preferred[0].host]: {
        host: pool.preferred[0].host,
        healthy: true,
        measuredAt: now - 1000
      },
      [pool.preferred[1].host]: {
        host: pool.preferred[1].host,
        healthy: true,
        measuredAt: now - 31 * 60 * 1000
      }
    }
  });
  assert.deepEqual(freshHealthyHosts(settings, runtime, pool, now), [
    pool.preferred[0].host
  ]);
  assert.equal(
    chooseSelectedHost(settings, runtime, pool, now),
    pool.preferred[0].host
  );
});

test("candidate pool entries outside the Bilibili media surface are discarded", () => {
  const now = Date.now();
  const settings = normalizeSettings();
  const poisonedPool = {
    preferred: [{ host: "evil.example.com" }, ...pool.preferred],
    conditional: pool.conditional
  };
  const runtime = normalizeRuntimeState({
    rankedHosts: ["evil.example.com", pool.preferred[0].host],
    probeCache: {
      "evil.example.com": {
        host: "evil.example.com",
        healthy: true,
        measuredAt: now
      },
      [pool.preferred[0].host]: {
        host: pool.preferred[0].host,
        healthy: true,
        measuredAt: now
      }
    }
  });
  assert.deepEqual(freshHealthyHosts(settings, runtime, poisonedPool, now), [
    pool.preferred[0].host
  ]);
  assert.equal(
    chooseSelectedHost(settings, runtime, poisonedPool, now),
    pool.preferred[0].host
  );

  settings.acceleration.strategy = "manual";
  settings.acceleration.manualHost = "evil.example.com";
  assert.equal(
    chooseSelectedHost(settings, normalizeRuntimeState(), poisonedPool, now),
    ""
  );
});

test("manual strategy is an explicit opt-in that may precede probing", () => {
  const settings = normalizeSettings();
  settings.acceleration.strategy = "manual";
  settings.acceleration.manualHost = pool.preferred[2].host;
  const runtime = normalizeRuntimeState();
  assert.equal(
    chooseSelectedHost(settings, runtime, pool),
    pool.preferred[2].host
  );
  assert.deepEqual(healthyHosts(settings, runtime, pool), [
    pool.preferred[2].host
  ]);
});
