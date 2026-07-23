import { isAllowedMediaHostname, uniqueStrings } from "./url-utils.js";

export function candidateHosts(cdnPool) {
  // Any host that can become a rewrite target must stay inside the Bilibili
  // media surface, even if a future pool edit or corrupted storage says otherwise.
  return uniqueStrings([
    ...cdnPool.preferred.map((entry) => entry.host),
    ...cdnPool.conditional.map((entry) => entry.host)
  ]).filter(isAllowedMediaHostname);
}

export function freshHealthyHosts(
  settings,
  runtime,
  cdnPool,
  now = Date.now()
) {
  const candidates = new Set(candidateHosts(cdnPool));
  const maxAgeMs = settings.acceleration.probeCacheMinutes * 60 * 1000;
  return uniqueStrings(runtime.rankedHosts).filter((host) => {
    const result = runtime.probeCache[host];
    return Boolean(
      candidates.has(host) &&
        result?.healthy &&
        Number.isFinite(result.measuredAt) &&
        now - result.measuredAt < maxAgeMs
    );
  });
}

export function chooseSelectedHost(settings, runtime, cdnPool, now = Date.now()) {
  const candidates = new Set(candidateHosts(cdnPool));
  if (
    settings.acceleration.strategy === "manual" &&
    candidates.has(settings.acceleration.manualHost)
  ) {
    return settings.acceleration.manualHost;
  }
  return freshHealthyHosts(settings, runtime, cdnPool, now)[0] ?? "";
}

export function healthyHosts(settings, runtime, cdnPool, now = Date.now()) {
  const fresh = freshHealthyHosts(settings, runtime, cdnPool, now);
  const candidates = new Set(candidateHosts(cdnPool));
  if (
    settings.acceleration.strategy === "manual" &&
    candidates.has(settings.acceleration.manualHost)
  ) {
    return uniqueStrings([settings.acceleration.manualHost, ...fresh]);
  }
  return fresh;
}
