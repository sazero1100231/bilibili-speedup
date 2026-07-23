import assert from "node:assert/strict";
import test from "node:test";
import {
  PROBE_BYTES,
  probeHost,
  probeMediaPath
} from "../../src/lib/prober.js";

const mediaUrl =
  "https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s?deadline=1";

test("probeHost sends one 256 KiB Range request and calculates throughput", async () => {
  const calls = [];
  const samples = [0, 40, 140];
  const result = await probeHost({
    mediaUrl,
    host: "upos-sz-mirrorcos.bilivideo.com",
    now: () => samples.shift(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(new Uint8Array(PROBE_BYTES), { status: 206 });
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Range, `bytes=0-${PROBE_BYTES - 1}`);
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(result.healthy, true);
  assert.equal(result.status, 206);
  assert.equal(result.bytes, PROBE_BYTES);
  assert.equal(result.ttfbMs, 40);
  assert.equal(result.transferDurationMs, 100);
  assert.equal(result.durationMs, 140);
  assert.equal(
    result.throughputBps,
    Math.round((PROBE_BYTES * 8 * 1000) / 100)
  );
});

test("probeHost uses page timing instead of extension message latency", async () => {
  const response = new Response(new Uint8Array(PROBE_BYTES), {
    status: 206
  });
  Object.defineProperty(response, "probeTiming", {
    value: {
      ttfbMs: 40,
      transferDurationMs: 60,
      durationMs: 100
    }
  });
  const samples = [0, 600, 900];
  const result = await probeHost({
    mediaUrl,
    host: "candidate.bilivideo.com",
    now: () => samples.shift(),
    fetchImpl: async () => response
  });

  assert.equal(result.ttfbMs, 40);
  assert.equal(result.transferDurationMs, 60);
  assert.equal(result.durationMs, 100);
  assert.equal(
    result.throughputBps,
    Math.round((PROBE_BYTES * 8 * 1000) / 60)
  );
});

test("probeHost treats a zero-resolution page body interval conservatively", async () => {
  const response = new Response(new Uint8Array(PROBE_BYTES), {
    status: 206
  });
  Object.defineProperty(response, "probeTiming", {
    value: {
      ttfbMs: 264,
      transferDurationMs: 0,
      durationMs: 264
    }
  });
  const result = await probeHost({
    mediaUrl,
    host: "candidate.bilivideo.com",
    fetchImpl: async () => response
  });

  assert.equal(result.transferDurationMs, 0);
  assert.equal(
    result.throughputBps,
    Math.round((PROBE_BYTES * 8 * 1000) / 264)
  );
});

test("probeHost rejects inconsistent page timing and measures locally", async () => {
  const response = new Response(new Uint8Array(PROBE_BYTES), {
    status: 206
  });
  Object.defineProperty(response, "probeTiming", {
    value: {
      ttfbMs: 20,
      transferDurationMs: -1,
      durationMs: 19
    }
  });
  const samples = [0, 40, 140];
  const result = await probeHost({
    mediaUrl,
    host: "candidate.bilivideo.com",
    now: () => samples.shift(),
    fetchImpl: async () => response
  });

  assert.equal(result.ttfbMs, 40);
  assert.equal(result.transferDurationMs, 100);
  assert.equal(result.durationMs, 140);
});

test("probeMediaPath reuses fresh per-host cache and ranks measured hosts", async () => {
  const now = Date.now();
  const cache = {
    "/path/video.m4s|cached.bilivideo.com": {
      host: "cached.bilivideo.com",
      healthy: true,
      compatible: true,
      status: 206,
      bytes: PROBE_BYTES,
      sampleHash: "00",
      ttfbMs: 25,
      durationMs: 100,
      throughputBps: 1_000_000_000_000,
      measuredAt: now - 1000
    }
  };
  const calls = [];
  const result = await probeMediaPath({
    mediaUrl,
    pool: {
      preferred: [
        { host: "cached.bilivideo.com" },
        { host: "measured.bilivideo.com" }
      ],
      conditional: []
    },
    cache,
    cacheMinutes: 30,
    nowEpoch: () => now,
    digestImpl: async () => new Uint8Array([0]).buffer,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(new Uint8Array(PROBE_BYTES), { status: 206 });
    }
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /mirrorcosov\.bilivideo\.com/);
  assert.match(calls[1], /measured\.bilivideo\.com/);
  assert.equal(result.rankedHosts[0], "cached.bilivideo.com");
  assert.equal(result.selectedHost, "cached.bilivideo.com");
});

test("probeMediaPath rejects network targets outside the Bilibili media surface", async () => {
  await assert.rejects(
    () =>
      probeMediaPath({
        mediaUrl: "https://example.com/video.m4s",
        pool: { preferred: [], conditional: [] }
      }),
    /outside the allowed/
  );
});

test("a fast candidate is rejected when its 256 KiB sample is not byte-identical", async () => {
  const result = await probeMediaPath({
    mediaUrl,
    pool: {
      preferred: [{ host: "candidate.bilivideo.com" }],
      conditional: []
    },
    cache: {},
    cacheMinutes: 0,
    fetchImpl: async (url) => {
      const fill = new URL(url).hostname.startsWith("candidate") ? 2 : 1;
      return new Response(new Uint8Array(PROBE_BYTES).fill(fill), {
        status: 206
      });
    }
  });
  assert.equal(result.results.length, 2);
  const candidate = result.results.find((entry) => entry.source === "pool");
  assert.equal(candidate.healthy, true);
  assert.equal(candidate.compatible, false);
  assert.deepEqual(result.rankedHosts, []);
});

test("a healthy exact reference remains selected when the first pool candidates return 403", async () => {
  const referenceUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=official";
  const calls = [];
  const result = await probeMediaPath({
    mediaUrl: referenceUrl,
    pool: {
      preferred: [
        { host: "upos-sz-mirrorcos.bilivideo.com" },
        { host: "upos-sz-mirrorcosb.bilivideo.com" }
      ],
      conditional: [
        { host: "upos-hz-mirrorakam.akamaized.net" }
      ],
      blocked: []
    },
    cache: {},
    cacheMinutes: 0,
    fetchImpl: async (url) => {
      const host = new URL(url).hostname;
      calls.push(host);
      if (host === "upos-hz-mirrorakam.akamaized.net") {
        return new Response(new Uint8Array(PROBE_BYTES), { status: 206 });
      }
      return new Response("signature rejected", { status: 403 });
    }
  });
  assert.deepEqual(calls, [
    "upos-hz-mirrorakam.akamaized.net",
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-sz-mirrorcosb.bilivideo.com"
  ]);
  assert.equal(result.results[0].source, "reference");
  assert.equal(result.results[0].healthy, true);
  assert.equal(result.results[0].compatible, true);
  assert.equal(
    result.selectedHost,
    "upos-hz-mirrorakam.akamaized.net"
  );
  assert.deepEqual(result.rankedHosts, [
    "upos-hz-mirrorakam.akamaized.net"
  ]);
});

test("a failed exact reference remains visible and does not authorize candidates", async () => {
  const result = await probeMediaPath({
    mediaUrl,
    pool: {
      preferred: [{ host: "candidate.bilivideo.com" }],
      conditional: [],
      blocked: []
    },
    fetchImpl: async () =>
      new Response("signature rejected", { status: 403 })
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].source, "reference");
  assert.equal(result.results[0].status, 403);
  assert.equal(result.results[0].healthy, false);
  assert.equal(result.results[0].compatible, false);
  assert.deepEqual(result.rankedHosts, []);
});

test("observed byte-zero evidence skips the reference fetch but still hash-gates candidates", async () => {
  const calls = [];
  let accountedBytes = 0;
  const result = await probeMediaPath({
    mediaUrl,
    pool: {
      preferred: [{ host: "candidate.bilivideo.com" }],
      conditional: [],
      blocked: []
    },
    cache: {},
    cacheMinutes: 0,
    digestImpl: async () => new Uint8Array(32).buffer,
    referenceEvidence: {
      sampleHash: "00".repeat(32),
      status: 206,
      bytes: PROBE_BYTES
    },
    onBytes(bytes) {
      accountedBytes += bytes;
    },
    fetchImpl: async (url) => {
      calls.push(new URL(url).hostname);
      return new Response(new Uint8Array(PROBE_BYTES), { status: 206 });
    }
  });

  assert.deepEqual(calls, ["candidate.bilivideo.com"]);
  assert.equal(accountedBytes, PROBE_BYTES);
  assert.equal(result.results[0].source, "observed-reference");
  assert.equal(result.results[0].targetUrl, mediaUrl);
  assert.equal(result.results[1].compatible, true);
  assert.deepEqual(result.rankedHosts, ["candidate.bilivideo.com"]);
});

test("malformed observed evidence fails closed before any candidate request", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      probeMediaPath({
        mediaUrl,
        pool: {
          preferred: [{ host: "candidate.bilivideo.com" }],
          conditional: []
        },
        referenceEvidence: {
          sampleHash: "not-a-sha256",
          status: 206,
          bytes: PROBE_BYTES
        },
        fetchImpl: async () => {
          calls += 1;
          return new Response(new Uint8Array(PROBE_BYTES), { status: 206 });
        }
      }),
    /Invalid observed probe reference/
  );
  assert.equal(calls, 0);
});

test("candidateOffset rotates later probes beyond a permanently failing prefix", async () => {
  const calls = [];
  await probeMediaPath({
    mediaUrl,
    pool: {
      preferred: [
        { host: "first.bilivideo.com" },
        { host: "second.bilivideo.com" },
        { host: "third.bilivideo.com" },
        { host: "fourth.bilivideo.com" }
      ],
      conditional: [],
      blocked: []
    },
    cache: {},
    cacheMinutes: 0,
    maxCandidates: 2,
    candidateOffset: 2,
    fetchImpl: async (url) => {
      calls.push(new URL(url).hostname);
      return new Response(new Uint8Array(PROBE_BYTES), { status: 206 });
    }
  });
  assert.deepEqual(calls, [
    "upos-sz-mirrorcosov.bilivideo.com",
    "third.bilivideo.com",
    "fourth.bilivideo.com"
  ]);
});

test("a short range body is never healthy even when its bytes match", async () => {
  const result = await probeHost({
    mediaUrl,
    host: "candidate.bilivideo.com",
    fetchImpl: async () =>
      new Response(new Uint8Array(PROBE_BYTES - 1), { status: 206 })
  });
  assert.equal(result.bytes, PROBE_BYTES - 1);
  assert.equal(result.healthy, false);
  assert.equal(result.compatible, false);
});

test("a response whose final URL leaves the requested route is rejected", async () => {
  const result = await probeHost({
    mediaUrl,
    host: "candidate.bilivideo.com",
    fetchImpl: async () => {
      const response = new Response(new Uint8Array(PROBE_BYTES), {
        status: 206
      });
      Object.defineProperty(response, "url", {
        value: "https://evil.example/video.m4s?deadline=1"
      });
      return response;
    }
  });
  assert.equal(result.bytes, PROBE_BYTES);
  assert.equal(result.healthy, false);
  assert.equal(result.compatible, false);
});

test("an external lifecycle abort reaches the active probe fetch", async () => {
  const controller = new AbortController();
  let fetchAborted = false;
  const resultPromise = probeHost({
    mediaUrl:
      "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?token=abort",
    host: "upos-sz-mirrorcos.bilivideo.com",
    signal: controller.signal,
    fetchImpl(_url, init) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            fetchAborted = true;
            reject(new DOMException("cancelled", "AbortError"));
          },
          { once: true }
        );
      });
    }
  });
  controller.abort("navigation");
  const result = await resultPromise;
  assert.equal(fetchAborted, true);
  assert.equal(result.healthy, false);
  assert.equal(result.status, 0);
});
