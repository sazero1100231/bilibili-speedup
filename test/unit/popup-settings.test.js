import assert from "node:assert/strict";
import test from "node:test";
import { mergePopupSettings } from "../../src/ui/popup-settings.js";

test("popup merge preserves concurrent options-page settings", () => {
  const latest = {
    globalEnabled: true,
    acceleration: {
      enabled: true,
      playurlRewrite: false,
      dnrFallback: false,
      strategy: "manual",
      manualHost: "upos.example",
      probeCacheMinutes: 60
    },
    privacy: {
      urlCleaning: true,
      telemetryBlocking: true,
      cosmeticFiltering: false,
      endpointToggles: { "data-log-web": false }
    },
    diagnostics: { enabled: false, maxSessions: 42 }
  };
  const merged = mergePopupSettings(latest, {
    globalEnabled: false,
    accelerationEnabled: false,
    urlCleaning: false,
    telemetryBlocking: false
  });
  assert.equal(merged.globalEnabled, false);
  assert.equal(merged.acceleration.enabled, false);
  assert.equal(merged.acceleration.playurlRewrite, false);
  assert.equal(merged.acceleration.strategy, "manual");
  assert.equal(merged.privacy.cosmeticFiltering, false);
  assert.deepEqual(merged.privacy.endpointToggles, {
    "data-log-web": false
  });
  assert.deepEqual(merged.diagnostics, {
    enabled: false,
    maxSessions: 42
  });
});
