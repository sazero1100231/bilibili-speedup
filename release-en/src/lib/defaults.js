export const STORAGE_KEYS = Object.freeze({
  settings: "settings",
  runtime: "runtimeState",
  diagnostics: "diagnostics"
});

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  globalEnabled: true,
  acceleration: {
    enabled: true,
    playurlRewrite: true,
    dnrFallback: true,
    strategy: "auto",
    manualHost: "",
    probeCacheMinutes: 30
  },
  privacy: {
    urlCleaning: true,
    telemetryBlocking: true,
    cosmeticFiltering: true,
    endpointToggles: {
      "data-log-web": true,
      "data-v2-log": true,
      "commercial-cm": true,
      "click-interface": false
    }
  },
  diagnostics: {
    enabled: false,
    maxSessions: 500
  }
});

export const DEFAULT_RUNTIME_STATE = Object.freeze({
  selectedHost: "",
  rankedHosts: [],
  probeCache: {},
  lastProbeAt: 0,
  dnrMatchCounts: {}
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isPlainObject(base)) {
    return structuredClone(override ?? base);
  }
  const result = structuredClone(base);
  if (!isPlainObject(override)) {
    return result;
  }
  for (const [key, value] of Object.entries(override)) {
    if (!(key in result)) {
      continue;
    }
    if (isPlainObject(result[key]) && isPlainObject(value)) {
      result[key] = deepMerge(result[key], value);
    } else if (Array.isArray(result[key]) && Array.isArray(value)) {
      result[key] = structuredClone(value);
    } else if (typeof value === typeof result[key]) {
      result[key] = value;
    }
  }
  return result;
}

export function normalizeSettings(input, endpointCatalog = []) {
  const settings = deepMerge(DEFAULT_SETTINGS, input);
  settings.schemaVersion = 1;
  settings.acceleration.strategy =
    settings.acceleration.strategy === "manual" ? "manual" : "auto";
  settings.acceleration.probeCacheMinutes = Math.min(
    120,
    Math.max(5, Number(settings.acceleration.probeCacheMinutes) || 30)
  );
  settings.diagnostics.maxSessions = Math.min(
    500,
    Math.max(10, Number(settings.diagnostics.maxSessions) || 500)
  );
  for (const endpoint of endpointCatalog) {
    if (typeof settings.privacy.endpointToggles[endpoint.id] !== "boolean") {
      settings.privacy.endpointToggles[endpoint.id] = endpoint.default_enabled;
    }
  }
  return settings;
}

export function normalizeRuntimeState(input) {
  const runtime = deepMerge(DEFAULT_RUNTIME_STATE, input);
  if (isPlainObject(input?.probeCache)) {
    runtime.probeCache = structuredClone(input.probeCache);
  }
  if (isPlainObject(input?.dnrMatchCounts)) {
    runtime.dnrMatchCounts = structuredClone(input.dnrMatchCounts);
  }
  return runtime;
}

export function pageModulesEnabled(settings) {
  if (!settings.globalEnabled) {
    return false;
  }
  return Boolean(
    (settings.acceleration.enabled && settings.acceleration.playurlRewrite) ||
      settings.privacy.urlCleaning ||
      settings.privacy.telemetryBlocking ||
      settings.privacy.cosmeticFiltering ||
      settings.diagnostics.enabled
  );
}

export function mainWorldModulesEnabled(settings) {
  if (!settings.globalEnabled) {
    return false;
  }
  return Boolean(
    (settings.acceleration.enabled && settings.acceleration.playurlRewrite) ||
      settings.privacy.urlCleaning ||
      settings.privacy.telemetryBlocking
  );
}
