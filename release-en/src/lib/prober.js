import {
  getHostname,
  hostnameMatches,
  isAllowedMediaUrl,
  mediaRouteKey,
  replaceHostname,
  uniqueStrings
} from "./url-utils.js";

export const PROBE_BYTES = 262144;
export const PROBE_TIMEOUT_MS = 3000;

function normalizedProbeTiming(value, fallback) {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const ttfbMs = Number(value.ttfbMs);
  const transferDurationMs = Number(value.transferDurationMs);
  const durationMs = Number(value.durationMs);
  if (
    !Number.isFinite(ttfbMs) ||
    !Number.isFinite(transferDurationMs) ||
    !Number.isFinite(durationMs) ||
    ttfbMs < 0 ||
    transferDurationMs < 0 ||
    durationMs <= 0 ||
    ttfbMs > durationMs ||
    transferDurationMs > durationMs ||
    Math.abs(durationMs - ttfbMs - transferDurationMs) > 5
  ) {
    return fallback;
  }
  return {
    ttfbMs: Math.max(0, Math.round(ttfbMs)),
    transferDurationMs: Math.max(0, Math.round(transferDurationMs)),
    durationMs: Math.max(1, Math.round(durationMs))
  };
}

async function readAtMost(response, byteLimit) {
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer.slice(0, byteLimit));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (received < byteLimit) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const length = Math.min(value.byteLength, byteLimit - received);
      chunks.push(value.subarray(0, length));
      received += length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256Hex(bytes, digestImpl = globalThis.crypto?.subtle?.digest) {
  if (typeof digestImpl !== "function") {
    return "";
  }
  const digest = await digestImpl.call(
    globalThis.crypto?.subtle,
    "SHA-256",
    bytes
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function probeUrl({
  targetUrl,
  host,
  fetchImpl,
  timeoutMs,
  now,
  referenceHash = "",
  digestImpl,
  signal,
  onBytes
}) {
  if (!isAllowedMediaUrl(targetUrl)) {
    return {
      host,
      targetUrl: "",
      healthy: false,
      compatible: false,
      status: 0,
      bytes: 0,
      ttfbMs: 0,
      transferDurationMs: 0,
      durationMs: 0,
      throughputBps: 0,
      measuredAt: Date.now(),
      error: "probe target outside the allowed media surface"
    };
  }
  const controller = new AbortController();
  const abortFromExternal = () =>
    controller.abort(signal?.reason ?? "probe cancelled");
  if (signal?.aborted) {
    abortFromExternal();
  } else {
    signal?.addEventListener?.("abort", abortFromExternal, { once: true });
  }
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const startedAt = now();
  try {
    const response = await fetchImpl(targetUrl, {
      method: "GET",
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal
    });
    const headersAt = now();
    const sample = await readAtMost(response, PROBE_BYTES);
    try {
      onBytes?.(sample.byteLength);
    } catch {
      // Accounting hooks cannot alter probe policy.
    }
    const completedAt = now();
    const fallbackTiming = {
      ttfbMs: Math.max(0, Math.round(headersAt - startedAt)),
      transferDurationMs: Math.max(1, Math.round(completedAt - headersAt)),
      durationMs: Math.max(1, Math.round(completedAt - startedAt))
    };
    const timing = normalizedProbeTiming(
      response.probeTiming,
      fallbackTiming
    );
    // Representation bitrate is a payload-rate requirement. Use the
    // page-side body interval so CDN latency and extension IPC remain
    // separately observable. A zero-resolution body interval falls back to
    // the conservative total page-fetch duration instead of becoming 1 ms.
    const throughputDurationMs =
      timing.transferDurationMs > 0
        ? timing.transferDurationMs
        : timing.durationMs;
    const finalUrl = response.url || targetUrl;
    let finalTargetMatches = false;
    try {
      const requested = new URL(targetUrl);
      const final = new URL(finalUrl);
      finalTargetMatches =
        isAllowedMediaUrl(final.href) &&
        final.protocol === requested.protocol &&
        final.host === requested.host &&
        final.pathname === requested.pathname &&
        final.search === requested.search;
    } catch {
      finalTargetMatches = false;
    }
    const healthy =
      (response.status === 206 || response.status === 200) &&
      sample.byteLength === PROBE_BYTES &&
      finalTargetMatches;
    const sampleHash = healthy ? await sha256Hex(sample, digestImpl) : "";
    const compatible = Boolean(
      healthy && sampleHash && (!referenceHash || sampleHash === referenceHash)
    );
    return {
      host,
      targetUrl,
      healthy,
      compatible,
      status: response.status,
      bytes: sample.byteLength,
      sampleHash,
      ttfbMs: timing.ttfbMs,
      transferDurationMs: timing.transferDurationMs,
      durationMs: timing.durationMs,
      throughputBps: Math.round(
        (sample.byteLength * 8 * 1000) / throughputDurationMs
      ),
      measuredAt: Date.now()
    };
  } catch (error) {
    return {
      host,
      targetUrl,
      healthy: false,
      compatible: false,
      status: 0,
      bytes: 0,
      sampleHash: "",
      ttfbMs: timeoutMs,
      transferDurationMs: 0,
      durationMs: timeoutMs,
      throughputBps: 0,
      measuredAt: Date.now(),
      error: error instanceof Error ? error.message.slice(0, 160) : String(error)
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abortFromExternal);
  }
}

export async function probeHost({
  mediaUrl,
  host,
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  now = () => performance.now(),
  referenceHash = "",
  digestImpl,
  signal,
  onBytes
}) {
  const targetUrl = replaceHostname(mediaUrl, host);
  return probeUrl({
    targetUrl,
    host,
    fetchImpl,
    timeoutMs,
    now,
    referenceHash,
    digestImpl,
    signal,
    onBytes
  });
}

async function runPool(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run())
  );
  return output;
}

function rotate(values, offset) {
  if (!values.length) {
    return [];
  }
  const start =
    ((Math.trunc(Number(offset) || 0) % values.length) + values.length) %
    values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}

export async function probeMediaPath({
  mediaUrl,
  pool,
  cache = {},
  cacheMinutes = 30,
  fetchImpl = fetch,
  nowEpoch = Date.now,
  digestImpl,
  signal,
  onBytes,
  maxCandidates = 2,
  candidateConcurrency = 1,
  candidateOffset = 0,
  referenceEvidence = null
}) {
  if (!isAllowedMediaUrl(mediaUrl)) {
    throw new Error("Probe URL is outside the allowed media host surface");
  }
  const poolHosts = uniqueStrings([
    ...pool.preferred.map((entry) => entry.host),
    ...pool.conditional.map((entry) => entry.host)
  ]);
  const poolHostSet = new Set(poolHosts);
  const blockedPatterns = (pool.blocked ?? []).map((entry) => entry.pattern);
  const referenceHost = getHostname(mediaUrl);
  const hosts = rotate(poolHosts, candidateOffset).filter(
    (host) =>
      host !== referenceHost &&
      !hostnameMatches(host, blockedPatterns)
  );
  const maxAgeMs = cacheMinutes * 60 * 1000;
  const now = nowEpoch();
  const routeKey = mediaRouteKey(mediaUrl);
  const observedHash = String(
    referenceEvidence?.sampleHash ?? ""
  ).toLowerCase();
  const observedStatus = Number(referenceEvidence?.status) || 0;
  const observedBytes = Number(referenceEvidence?.bytes) || 0;
  if (
    referenceEvidence &&
    (
      !/^[0-9a-f]{64}$/.test(observedHash) ||
      (observedStatus !== 200 && observedStatus !== 206) ||
      observedBytes < PROBE_BYTES
    )
  ) {
    throw new Error("Invalid observed probe reference");
  }
  // A successful page media request is stronger evidence than repeating the
  // same signed URL from the extension network context, where Bilibili may
  // return 403 because the request lacks the player's origin/referrer state.
  // Only the already-downloaded byte-zero hash is reused; every replacement
  // host still has to return a full matching 256 KiB sample.
  const reference = referenceEvidence
    ? {
        host: referenceHost,
        targetUrl: mediaUrl,
        healthy: true,
        compatible: true,
        status: observedStatus,
        bytes: PROBE_BYTES,
        sampleHash: observedHash,
        ttfbMs: 0,
        transferDurationMs: 0,
        durationMs: 0,
        throughputBps: 0,
        measuredAt: now
      }
    : await probeUrl({
        targetUrl: mediaUrl,
        host: referenceHost,
        fetchImpl,
        timeoutMs: PROBE_TIMEOUT_MS,
        now: () => performance.now(),
        digestImpl,
        signal,
        onBytes
      });
  const referenceResult = {
    ...reference,
    source: referenceEvidence ? "observed-reference" : "reference",
    eligible: !hostnameMatches(reference.host, blockedPatterns)
  };
  if (!reference.healthy || !reference.sampleHash) {
    return {
      // Preserve the bounded failure evidence for diagnostics and candidate
      // ordering. Returning an empty result made a 403/short-body reference
      // indistinguishable from a probe that never ran.
      results: [referenceResult],
      cache: { ...cache },
      rankedHosts: [],
      selectedHost: "",
      reference
    };
  }
  // The exact signed URL used as the byte reference is itself a valid probe
  // result. Dropping it makes a healthy official backup invisible whenever
  // all synthesized pool candidates reject the signature (commonly HTTP 403).
  const freshResults = [];
  const staleHosts = [];
  for (const host of hosts) {
    const cacheKey = `${routeKey}|${host}`;
    const cached = cache[cacheKey];
    if (cached && now - cached.measuredAt < maxAgeMs) {
      freshResults.push({
        ...cached,
        source: "cache",
        eligible: true,
        compatible:
          Boolean(cached.healthy) &&
          Boolean(cached.sampleHash) &&
          cached.sampleHash === reference.sampleHash,
        targetUrl: replaceHostname(mediaUrl, host)
      });
    } else {
      if (staleHosts.length < Math.max(0, Number(maxCandidates) || 0)) {
        staleHosts.push(host);
      }
    }
  }
  const measured = (await runPool(
    staleHosts,
    Math.max(1, Number(candidateConcurrency) || 1),
    (host) =>
    probeHost({
      mediaUrl,
      host,
      fetchImpl,
      referenceHash: reference.sampleHash,
      digestImpl,
      signal,
      onBytes
    })
  )).map((result) => ({
    ...result,
    source: "pool",
    eligible: true
  }));
  const results = [referenceResult, ...freshResults, ...measured];
  const nextCache = { ...cache };
  for (const result of measured) {
    const {
      targetUrl: _targetUrl,
      source: _source,
      eligible: _eligible,
      ...cacheEntry
    } = result;
    nextCache[`${routeKey}|${result.host}`] = cacheEntry;
  }
  const ranked = results
    .filter(
      (result) =>
        result.eligible &&
        poolHostSet.has(result.host) &&
        result.healthy &&
        result.compatible
    )
    .sort(
      (left, right) =>
        right.throughputBps - left.throughputBps || left.ttfbMs - right.ttfbMs
    );
  return {
    results,
    cache: nextCache,
    rankedHosts: ranked.map((result) => result.host),
    selectedHost: ranked[0]?.host ?? "",
    reference
  };
}
