import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
const storageState = {};
const storageSetLog = [];
const dynamicRules = [];
const sessionRules = [];
const sessionRuleUpdateLog = [];
const sessionRuleCountHistory = [];
const tabMessageLog = [];
let registeredScripts = [];
let registerScriptCalls = 0;
let unregisterScriptCalls = 0;
let messageListener;
let storageChangedListener;
let tabRemovedListener;
let failNextSessionRuleUpdate = false;

function replaceArray(target, values) {
  target.splice(0, target.length, ...values);
}

function selectedStorage(keys) {
  if (keys === null || keys === undefined) {
    return structuredClone(storageState);
  }
  const names = Array.isArray(keys)
    ? keys
    : typeof keys === "string"
      ? [keys]
      : Object.keys(keys);
  return Object.fromEntries(
    names
      .filter((key) => Object.hasOwn(storageState, key))
      .map((key) => [key, structuredClone(storageState[key])])
  );
}

globalThis.chrome = {
  runtime: {
    getURL(path) {
      return `mock-extension://${path}`;
    },
    getManifest() {
      return { version: "test" };
    },
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      }
    },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} }
  },
  storage: {
    local: {
      async get(keys) {
        return selectedStorage(keys);
      },
      async set(values) {
        storageSetLog.push(Object.keys(values));
        Object.assign(storageState, structuredClone(values));
      }
    },
    onChanged: {
      addListener(listener) {
        storageChangedListener = listener;
      }
    }
  },
  declarativeNetRequest: {
    async isRegexSupported() {
      return { isSupported: true };
    },
    async getDynamicRules() {
      return structuredClone(dynamicRules);
    },
    async updateDynamicRules({ removeRuleIds, addRules }) {
      replaceArray(
        dynamicRules,
        dynamicRules
          .filter((rule) => !removeRuleIds.includes(rule.id))
          .concat(structuredClone(addRules))
      );
    },
    async getSessionRules() {
      return structuredClone(sessionRules);
    },
    async updateSessionRules({ removeRuleIds, addRules }) {
      if (failNextSessionRuleUpdate) {
        failNextSessionRuleUpdate = false;
        throw new Error("synthetic session-rule failure");
      }
      sessionRuleUpdateLog.push({
        removeRuleIds: [...removeRuleIds],
        addRules: structuredClone(addRules)
      });
      replaceArray(
        sessionRules,
        sessionRules
          .filter((rule) => !removeRuleIds.includes(rule.id))
          .concat(structuredClone(addRules))
      );
      sessionRuleCountHistory.push(
        sessionRules.filter(
          (rule) => rule.id >= 4_000_000 && rule.id <= 4_999_999
        ).length
      );
    }
  },
  scripting: {
    async getRegisteredContentScripts({ ids } = {}) {
      return structuredClone(
        ids?.length
          ? registeredScripts.filter((script) => ids.includes(script.id))
          : registeredScripts
      );
    },
    async unregisterContentScripts({ ids }) {
      unregisterScriptCalls += 1;
      registeredScripts = registeredScripts.filter(
        (script) => !ids.includes(script.id)
      );
    },
    async registerContentScripts(scripts) {
      registerScriptCalls += 1;
      registeredScripts.push(...structuredClone(scripts));
    },
    async removeCSS() {},
    async insertCSS() {}
  },
  tabs: {
    async sendMessage(tabId, message, options) {
      tabMessageLog.push({
        tabId,
        message: structuredClone(message),
        options: structuredClone(options)
      });
      if (message.type === "CANCEL_PAGE_PROBE_FETCH") {
        return {
          ok: true,
          type: "PAGE_PROBE_FETCH_CANCELLED",
          version: 1,
          probeId: message.probeId,
          sessionId: message.sessionId,
          found: true
        };
      }
      if (message.type === "RUN_PAGE_PROBE_FETCH") {
        try {
          const startedAt = performance.now();
          const response = await globalThis.fetch(message.targetUrl, {
            method: "GET",
            headers: { Range: "bytes=0-262143" },
            credentials: "omit",
            cache: "no-store",
            redirect: "error"
          });
          const headersAt = performance.now();
          const source = new Uint8Array(await response.arrayBuffer());
          const completedAt = performance.now();
          const bytes = source.subarray(0, 262_144);
          const measuredTiming = {
            ttfbMs: Math.max(0, Math.round(headersAt - startedAt)),
            transferDurationMs: Math.max(
              0,
              Math.round(completedAt - headersAt)
            ),
            durationMs: Math.max(1, Math.round(completedAt - startedAt))
          };
          const timing = response.probeTiming ?? measuredTiming;
          const messageDelayMs = Math.max(
            0,
            Number(response.probeMessageDelayMs) || 0
          );
          if (messageDelayMs) {
            await new Promise((resolve) =>
              setTimeout(resolve, messageDelayMs)
            );
          }
          return {
            ok: true,
            type: "PAGE_PROBE_FETCH_RESULT",
            version: 1,
            probeId: message.probeId,
            sessionId: message.sessionId,
            status: response.status,
            finalUrl: response.url || message.targetUrl,
            bytes: bytes.byteLength,
            ttfbMs: timing.ttfbMs,
            transferDurationMs: timing.transferDurationMs,
            durationMs: timing.durationMs,
            bodyBase64: Buffer.from(bytes).toString("base64")
          };
        } catch (error) {
          return {
            ok: false,
            type: "PAGE_PROBE_FETCH_RESULT",
            version: 1,
            probeId: message.probeId,
            sessionId: message.sessionId,
            error: String(error?.message ?? error)
          };
        }
      }
      return { ok: true };
    },
    onRemoved: {
      addListener(listener) {
        tabRemovedListener = listener;
      }
    }
  }
};

globalThis.fetch = async (rawUrl) => {
  const path = String(rawUrl).replace("mock-extension://", "");
  const body = await readFile(new URL(`../../${path}`, import.meta.url));
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

await import(`../../src/background/service-worker.js?test=${Date.now()}`);

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

await waitFor(
  () => storageState.settings && registeredScripts.length === 2,
  "service-worker initialization"
);
globalThis.fetch = originalFetch;

function sendWithSender(message, sender) {
  return new Promise((resolve, reject) => {
    const accepted = messageListener(
      message,
      sender,
      (response) => {
        if (response?.ok) {
          resolve(response);
        } else {
          reject(new Error(response?.error ?? "message failed"));
        }
      }
    );
    if (!accepted) {
      reject(new Error("service worker did not accept async response"));
    }
  });
}

function send(message, tabId) {
  return sendWithSender(message, {
    tab: { id: tabId },
    frameId: 0,
    documentId: `document-${tabId}`
  });
}

function sendWithBoundTab(message, tabId) {
  return sendWithSender(
    { ...message, routingTabId: tabId },
    { frameId: 0, documentId: `document-${tabId}` }
  );
}

const sourceUrl =
  "https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s?upsig=source";
const backupUrl =
  "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=backup";
const audioSourceUrl =
  "https://upos-sz-mirrorcosov.bilivideo.com/path/audio.m4s?upsig=audio-source";
const audioBackupUrl =
  "https://upos-hz-mirrorakam.akamaized.net/path/audio.m4s?hdnts=audio-backup";

test("search pages cannot start playback routing sessions", async () => {
  const tabId = 90;
  await assert.rejects(
    () =>
      send(
        {
          type: "START_PLAYBACK_SESSION",
          sessionId: "search-preview-session",
          sessionEpoch: 1,
          pageUrl:
            "https://search.bilibili.com/all?keyword=music&search_source=5"
        },
        tabId
      ),
    /Unsupported playback page/
  );

  const response = await send(
    {
      type: "GET_RUNTIME_CONFIG",
      pageUrl: "https://search.bilibili.com/all?keyword=music"
    },
    tabId
  );
  assert.equal(response.config.playbackSessionId, "");
  assert.equal(response.config.routingTabId, null);
  assert.equal(
    sessionRules.some((rule) => rule.condition.tabIds?.includes(tabId)),
    false
  );
});

test("a full navigation to search evicts stale media rules for the tab", async () => {
  const tabId = 91;
  const sessionId = "playback-before-search";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVSEARCHCLEANUP"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          routeKey: "/path/video.m4s",
          urls: [sourceUrl, backupUrl],
          bandwidth: 1_000_000,
          kind: "video"
        }
      ]
    },
    tabId
  );
  await send(
    {
      type: "HOST_DEGRADED",
      sessionId,
      host: "upos-sz-mirrorcosov.bilivideo.com",
      routeKey: "/path/video.m4s",
      reason: "search-navigation-test"
    },
    tabId
  );
  assert.ok(
    sessionRules.some((rule) => rule.condition.tabIds?.includes(tabId))
  );

  const response = await send(
    {
      type: "GET_RUNTIME_CONFIG",
      pageUrl: "https://search.bilibili.com/all?keyword=music"
    },
    tabId
  );
  assert.equal(response.config.playbackSessionId, "");
  assert.equal(
    sessionRules.some((rule) => rule.condition.tabIds?.includes(tabId)),
    false
  );
  await assert.rejects(
    () =>
      send(
        {
          type: "REGISTER_MEDIA_ROUTES",
          sessionId,
          routes: []
        },
        tabId
      ),
    /(?:Missing|Stale or unknown) playback session/
  );
});

test("SPA playback exit explicitly stops the current routing session", async () => {
  const tabId = 92;
  const sessionId = "playback-spa-stop";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVSPASTOP"
    },
    tabId
  );
  const response = await send(
    {
      type: "STOP_PLAYBACK_SESSION",
      sessionId
    },
    tabId
  );
  assert.equal(response.stopped, true);
  assert.equal(response.sessionId, sessionId);
  assert.equal(response.config.playbackSessionId, "");
});

test("a healthy exact reference survives two synthetic candidate 403 responses", async () => {
  const tabId = 100;
  const sessionId = "session-reference-health";
  const presentationId = "bvid-BVREFERENCE:cid-1";
  const referenceUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/reference.m4s?hdnts=official";
  const audioReferenceUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/reference-audio.m4s?hdnts=official-audio";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVREFERENCE"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey: "/path/reference.m4s",
          urls: [referenceUrl],
          kind: "video"
        },
        {
          presentationId,
          routeKey: "/path/reference-audio.m4s",
          urls: [audioReferenceUrl],
          kind: "audio"
        }
      ]
    },
    tabId
  );

  const requestedHosts = [];
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    requestedHosts.push(host);
    if (host === "upos-hz-mirrorakam.akamaized.net") {
      return new Response(new Uint8Array(262144), { status: 206 });
    }
    return new Response("signature rejected", { status: 403 });
  };
  try {
    const pageProbeBaseline = tabMessageLog.length;
    const response = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey: "/path/reference.m4s",
        mediaUrl: referenceUrl
      },
      tabId
    );
    assert.deepEqual(requestedHosts, [
      "upos-hz-mirrorakam.akamaized.net",
      "upos-sz-upcdnbda2.bilivideo.com",
      "upos-sz-mirrorcos.bilivideo.com",
    ]);
    assert.equal(
      response.config.selectedHost,
      "upos-hz-mirrorakam.akamaized.net"
    );
    assert.deepEqual(
      response.config.compatibleRoutes[
        `${presentationId}::/path/reference.m4s`
      ],
      [referenceUrl]
    );
    assert.ok(
      response.config.probeResults.some(
        (entry) =>
          entry.host === "upos-hz-mirrorakam.akamaized.net" &&
          entry.healthy
      )
    );
    const pageProbes = tabMessageLog
      .slice(pageProbeBaseline)
      .filter(
        (entry) => entry.message.type === "RUN_PAGE_PROBE_FETCH"
      );
    assert.equal(pageProbes.length, 3);
    assert.ok(
      pageProbes.every(
        (entry) =>
          entry.options.documentId === `document-${tabId}` &&
          entry.message.version === 1 &&
          entry.message.sessionId === sessionId
      )
    );
    const audioResponse = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey: "/path/reference-audio.m4s",
        mediaUrl: audioReferenceUrl
      },
      tabId
    );
    assert.deepEqual(requestedHosts.slice(3), [
      "upos-hz-mirrorakam.akamaized.net",
      "upos-sz-upcdnbda2.bilivideo.com",
      "upos-sz-mirrorcos.bilivideo.com",
    ]);
    assert.deepEqual(
      audioResponse.config.compatibleRoutes[
        `${presentationId}::/path/reference-audio.m4s`
      ],
      [audioReferenceUrl]
    );
  } finally {
    globalThis.fetch = originalFetch;
    await send({ type: "CLEAR_PROBE_CACHE" }, tabId);
    tabRemovedListener(tabId);
  }
});

test("a failed reference does not advance the exact route candidate cursor", async () => {
  const tabId = 108;
  const sessionId = "session-reference-retry-cursor";
  const presentationId = "bvid-BVREFERENCEFAIL:cid-1";
  const routeKey = "/path/reference-retry.m4s";
  const referenceUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/reference-retry.m4s?hdnts=official";
  const matchingBytes = new Uint8Array(262144);
  const observedReference = {
    status: 206,
    bytes: matchingBytes.byteLength,
    hash: createHash("sha256").update(matchingBytes).digest("hex")
  };
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVREFERENCEFAIL"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey,
          urls: [referenceUrl],
          kind: "video"
        }
      ]
    },
    tabId
  );

  const requestedHosts = [];
  let referenceHealthy = false;
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    requestedHosts.push(host);
    if (host === "upos-hz-mirrorakam.akamaized.net") {
      return referenceHealthy
        ? new Response(matchingBytes, { status: 206 })
        : new Response("reference rejected", { status: 403 });
    }
    if (host === "upos-sz-upcdnbda2.bilivideo.com") {
      return new Response(matchingBytes, { status: 206 });
    }
    return new Response("signature rejected", { status: 403 });
  };
  try {
    await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: referenceUrl
      },
      tabId
    );
    assert.deepEqual(requestedHosts, [
      "upos-hz-mirrorakam.akamaized.net"
    ]);

    referenceHealthy = true;
    const response = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: referenceUrl,
        referenceEvidence: observedReference
      },
      tabId
    );
    assert.deepEqual(requestedHosts.slice(1), [
      "upos-hz-mirrorakam.akamaized.net",
      "upos-sz-upcdnbda2.bilivideo.com",
      "upos-sz-mirrorcos.bilivideo.com"
    ]);
    assert.ok(
      response.config.compatibleRoutes[
        `${presentationId}::${routeKey}`
      ].some(
        (url) =>
          new URL(url).hostname === "upos-sz-upcdnbda2.bilivideo.com"
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
    await send({ type: "CLEAR_PROBE_CACHE" }, tabId);
    tabRemovedListener(tabId);
  }
});

test("a registered unblocked exact backup replaces a stale blocked probe reference", async () => {
  const tabId = 101;
  const sessionId = "session-safe-probe-reference";
  const presentationId = "bvid-BVSAFEPROBE:cid-1";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVSAFEPROBE"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey: "/path/video.m4s",
          urls: [sourceUrl, backupUrl],
          kind: "video"
        }
      ]
    },
    tabId
  );

  const requestedHosts = [];
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    requestedHosts.push(host);
    return host === "upos-hz-mirrorakam.akamaized.net"
      ? new Response(new Uint8Array(262144), { status: 206 })
      : new Response("signature rejected", { status: 403 });
  };
  try {
    const response = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey: "/path/video.m4s",
        mediaUrl: sourceUrl
      },
      tabId
    );

    assert.equal(
      requestedHosts[0],
      "upos-hz-mirrorakam.akamaized.net"
    );
    assert.equal(
      requestedHosts.includes("upos-sz-mirrorcosov.bilivideo.com"),
      false
    );
    assert.deepEqual(
      response.config.compatibleRoutes[
        `${presentationId}::/path/video.m4s`
      ],
      [backupUrl]
    );
  } finally {
    globalThis.fetch = originalFetch;
    await send({ type: "CLEAR_PROBE_CACHE" }, tabId);
    tabRemovedListener(tabId);
  }
});

test("observed byte-zero evidence bypasses a 403-prone reference fetch and authorizes only matching candidates", async () => {
  const tabId = 106;
  const sessionId = "session-observed-reference";
  const presentationId = "bvid-BVOBSERVED";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVOBSERVED"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey: "/path/video.m4s",
          urls: [sourceUrl, backupUrl],
          kind: "video"
        }
      ]
    },
    tabId
  );

  const sample = new Uint8Array(262_144).fill(9);
  const referenceHash = createHash("sha256")
    .update(sample)
    .digest("hex");
  const requestedHosts = [];
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    requestedHosts.push(host);
    return host === "upos-sz-upcdnbda2.bilivideo.com"
      ? new Response(sample, { status: 206 })
      : new Response("signature rejected", { status: 403 });
  };
  try {
    const response = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey: "/path/video.m4s",
        mediaUrl: backupUrl,
        observedReference: true,
        referenceHash,
        referenceStatus: 206,
        referenceBytes: 262_144
      },
      tabId
    );

    assert.equal(
      requestedHosts.includes("upos-hz-mirrorakam.akamaized.net"),
      false
    );
    assert.deepEqual(requestedHosts, [
      "upos-sz-upcdnbda2.bilivideo.com",
      "upos-sz-mirrorcos.bilivideo.com"
    ]);
    const compatible =
      response.config.compatibleRoutes[
        `${presentationId}::/path/video.m4s`
      ];
    assert.ok(compatible.includes(backupUrl));
    assert.ok(
      compatible.some(
        (url) =>
          new URL(url).hostname ===
          "upos-sz-upcdnbda2.bilivideo.com"
      )
    );
    assert.ok(
      response.config.probeResults.some(
        (entry) =>
          entry.host === "upos-hz-mirrorakam.akamaized.net" &&
          entry.healthy
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
    await send({ type: "CLEAR_PROBE_CACHE" }, tabId);
    tabRemovedListener(tabId);
  }
});

test("recovery reuses only the exact session route reference after its registered host is degraded", async () => {
  const tabId = 310;
  const sessionId = "session-recovery-reference";
  const presentationId = "bvid-BVRECOVERYREF";
  const routeKey = "/path/recovery-reference.m4s";
  const referenceUrl =
    "https://upos-sz-mirror08c.bilivideo.com/path/recovery-reference.m4s?hdnts=official";
  const sample = new Uint8Array(262_144).fill(31);
  const referenceHash = createHash("sha256").update(sample).digest("hex");
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVRECOVERYREF"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey,
          urls: [referenceUrl],
          kind: "video"
        }
      ]
    },
    tabId
  );

  const requestedHosts = [];
  globalThis.fetch = async (url) => {
    requestedHosts.push(new URL(url).hostname);
    return new Response(sample, { status: 206 });
  };
  try {
    const initial = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: referenceUrl,
        observedReference: true,
        referenceHash,
        referenceStatus: 206,
        referenceBytes: sample.byteLength
      },
      tabId
    );
    assert.equal(initial.probeOutcome.coveredPoolCandidates, 2);
    assert.equal(initial.probeOutcome.candidatePoolSize, 8);
    assert.equal(
      requestedHosts.includes("upos-hz-mirrorakam.akamaized.net"),
      false
    );
    assert.equal(
      requestedHosts.includes("upos-sz-mirror08c.bilivideo.com"),
      false
    );
    const allCandidateHosts = [...requestedHosts];

    await send(
      {
        type: "HOST_DEGRADED",
        sessionId,
        presentationId,
        routeKey,
        host: "upos-sz-mirror08c.bilivideo.com",
        reason: "body-stalled"
      },
      tabId
    );
    requestedHosts.length = 0;
    const recovery = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: referenceUrl,
        recovery: true
      },
      tabId
    );
    assert.equal(recovery.probeOutcome.attemptedPoolCandidates, 2);
    assert.equal(recovery.probeOutcome.coveredPoolCandidates, 4);
    assert.equal(recovery.probeOutcome.poolExhausted, false);
    assert.equal(requestedHosts.length, 2);
    assert.equal(
      requestedHosts.includes("upos-sz-mirror08c.bilivideo.com"),
      false
    );
    allCandidateHosts.push(...requestedHosts);
    requestedHosts.length = 0;
    const secondRecovery = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: referenceUrl,
        recovery: true
      },
      tabId
    );
    assert.equal(secondRecovery.probeOutcome.coveredPoolCandidates, 6);
    assert.equal(secondRecovery.probeOutcome.poolExhausted, false);
    allCandidateHosts.push(...requestedHosts);
    requestedHosts.length = 0;
    const finalRecovery = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: referenceUrl,
        recovery: true
      },
      tabId
    );
    assert.equal(finalRecovery.probeOutcome.coveredPoolCandidates, 8);
    assert.equal(finalRecovery.probeOutcome.poolExhausted, true);
    allCandidateHosts.push(...requestedHosts);
    assert.equal(allCandidateHosts.length, 8);
    assert.equal(new Set(allCandidateHosts).size, 8);
    assert.equal(
      allCandidateHosts.includes("upos-sz-mirror08c.bilivideo.com"),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
    await send({ type: "CLEAR_PROBE_CACHE" }, tabId);
    tabRemovedListener(tabId);
  }
});

test("observed exact-route evidence survives scheduler rejection for a later recovery", async () => {
  const tabId = 312;
  const sessionId = "session-budgeted-reference";
  const presentationId = "bvid-BVBUDGETEDREF";
  const fillRouteKey = "/path/budget-fill.m4s";
  const recoveryRouteKey = "/path/budgeted-reference.m4s";
  const fillUrl =
    "https://upos-sz-mirror07c.bilivideo.com/path/budget-fill.m4s?token=fill";
  const recoveryUrl =
    "https://upos-sz-mirror08c.bilivideo.com/path/budgeted-reference.m4s?token=recovery";
  const fillSample = new Uint8Array(262_144).fill(37);
  const recoverySample = new Uint8Array(262_144).fill(41);
  const fillHash = createHash("sha256").update(fillSample).digest("hex");
  const recoveryHash = createHash("sha256")
    .update(recoverySample)
    .digest("hex");
  const originalDateNow = Date.now;
  let now = originalDateNow();
  Date.now = () => now;
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVBUDGETEDREF"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey: fillRouteKey,
          urls: [fillUrl],
          kind: "video"
        },
        {
          presentationId,
          routeKey: recoveryRouteKey,
          urls: [recoveryUrl],
          kind: "video"
        }
      ]
    },
    tabId
  );

  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    const sample = new URL(url).pathname === fillRouteKey
      ? fillSample
      : recoverySample;
    return new Response(sample, { status: 206 });
  };
  try {
    for (let index = 0; index < 4; index += 1) {
      await send(
        {
          type: "PROBE_MEDIA",
          sessionId,
          presentationId,
          routeKey: fillRouteKey,
          mediaUrl: fillUrl,
          observedReference: true,
          referenceHash: fillHash,
          referenceStatus: 206,
          referenceBytes: fillSample.byteLength
        },
        tabId
      );
    }
    assert.equal(requestedUrls.length, 8);
    const beforeRejectedProbe = requestedUrls.length;
    await assert.rejects(
      () =>
        send(
          {
            type: "PROBE_MEDIA",
            sessionId,
            presentationId,
            routeKey: recoveryRouteKey,
            mediaUrl: recoveryUrl,
            observedReference: true,
            referenceHash: recoveryHash,
            referenceStatus: 206,
            referenceBytes: recoverySample.byteLength
          },
          tabId
        ),
      /probe byte budget exceeded/i
    );
    assert.equal(requestedUrls.length, beforeRejectedProbe);

    await send(
      {
        type: "HOST_DEGRADED",
        sessionId,
        presentationId,
        routeKey: recoveryRouteKey,
        host: "upos-sz-mirror08c.bilivideo.com",
        reason: "body-stalled"
      },
      tabId
    );
    now += 60_001;
    const recovery = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey: recoveryRouteKey,
        mediaUrl: recoveryUrl,
        recovery: true
      },
      tabId
    );
    const recoveryRequests = requestedUrls.slice(beforeRejectedProbe);
    assert.equal(recovery.probeOutcome.attemptedPoolCandidates, 2);
    assert.equal(recoveryRequests.length, 2);
    assert.equal(
      recoveryRequests.some(
        (url) =>
          new URL(url).hostname === "upos-sz-mirror08c.bilivideo.com"
      ),
      false
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    await send({ type: "CLEAR_PROBE_CACHE" }, tabId);
    tabRemovedListener(tabId);
  }
});

test("a byte-compatible candidate below the representation throughput requirement is not authorized", async () => {
  const tabId = 109;
  const sessionId = "session-underpowered-candidate";
  const presentationId = "bvid-BVUNDERPOWERED";
  const routeKey = "/path/high-bitrate.m4s";
  const referenceUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/high-bitrate.m4s?hdnts=official";
  const sample = new Uint8Array(262_144).fill(11);
  const referenceHash = createHash("sha256").update(sample).digest("hex");
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVUNDERPOWERED"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey,
          urls: [referenceUrl],
          kind: "video",
          bandwidth: 15_436_971
        }
      ]
    },
    tabId
  );

  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    if (host === "upos-sz-upcdnbda2.bilivideo.com") {
      const response = new Response(sample, { status: 206 });
      Object.defineProperty(response, "probeTiming", {
        value: {
          ttfbMs: 10,
          transferDurationMs: 140,
          durationMs: 150
        }
      });
      return response;
    }
    return new Response("signature rejected", { status: 403 });
  };
  try {
    const response = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: referenceUrl,
        observedReference: true,
        referenceHash,
        referenceStatus: 206,
        referenceBytes: 262_144
      },
      tabId
    );
    assert.deepEqual(
      response.config.compatibleRoutes[`${presentationId}::${routeKey}`],
      []
    );
    const bda = response.config.probeResults.find(
      (entry) => entry.host === "upos-sz-upcdnbda2.bilivideo.com"
    );
    assert.equal(bda.compatible, true);
    assert.equal(bda.routeQualified, false);
    assert.equal(bda.healthy, false);
    assert.equal(bda.throughputBps, 14_979_657);
    assert.equal(bda.requiredBps, 19_296_214);
    assert.equal(response.probeOutcome.compatiblePoolCandidates, 1);
    assert.equal(response.probeOutcome.underpoweredPoolCandidates, 1);
    assert.equal(response.config.selectedHost, "");
  } finally {
    globalThis.fetch = originalFetch;
    await send({ type: "CLEAR_PROBE_CACHE" }, tabId);
    tabRemovedListener(tabId);
  }
});

test("page payload timing excludes extension message delay from route capacity", async () => {
  const tabId = 309;
  const sessionId = "session-page-probe-timing";
  const presentationId = "bvid-BV1234567890:cid-timing";
  const routeKey = "/path/page-timing.m4s";
  const referenceUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/page-timing.m4s?hdnts=official";
  const sample = new Uint8Array(262_144).fill(17);
  const referenceHash = createHash("sha256").update(sample).digest("hex");
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV1234567890"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey,
          urls: [referenceUrl],
          kind: "video",
          bandwidth: 15_436_971
        }
      ]
    },
    tabId
  );

  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    if (host === "upos-sz-upcdnbda2.bilivideo.com") {
      const response = new Response(sample, { status: 206 });
      Object.defineProperties(response, {
        probeTiming: {
          value: {
            ttfbMs: 264,
            transferDurationMs: 80,
            durationMs: 344
          }
        },
        probeMessageDelayMs: { value: 500 }
      });
      return response;
    }
    return new Response("signature rejected", { status: 403 });
  };
  try {
    const response = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: referenceUrl,
        observedReference: true,
        referenceHash,
        referenceStatus: 206,
        referenceBytes: 262_144
      },
      tabId
    );
    const candidate = response.config.probeResults.find(
      (entry) => entry.host === "upos-sz-upcdnbda2.bilivideo.com"
    );
    assert.equal(candidate.ttfbMs, 264);
    assert.equal(candidate.transferDurationMs, 80);
    assert.equal(candidate.durationMs, 344);
    assert.equal(candidate.throughputBps, 26_214_400);
    assert.equal(candidate.requiredBps, 19_296_214);
    assert.equal(candidate.routeQualified, true);
    assert.equal(candidate.healthy, true);
    assert.equal(
      response.config.selectedHost,
      "upos-sz-upcdnbda2.bilivideo.com"
    );
    assert.equal(response.probeOutcome.underpoweredPoolCandidates, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await send({ type: "CLEAR_PROBE_CACHE" }, tabId);
    tabRemovedListener(tabId);
  }
});

test("a later bandwidth update revokes a candidate qualified while route capacity was unknown", async () => {
  const tabId = 110;
  const sessionId = "session-late-bandwidth";
  const presentationId = "bvid-BVLATEBANDWIDTH";
  const routeKey = "/path/late-bandwidth.m4s";
  const pageUrl = "https://www.bilibili.com/video/BVLATEBANDWIDTH";
  const referenceUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/late-bandwidth.m4s?hdnts=official";
  const sample = new Uint8Array(262_144).fill(19);
  const referenceHash = createHash("sha256").update(sample).digest("hex");
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey,
          urls: [referenceUrl],
          kind: "video",
          bandwidth: 0
        }
      ]
    },
    tabId
  );

  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    if (host === "upos-sz-upcdnbda2.bilivideo.com") {
      const response = new Response(sample, { status: 206 });
      Object.defineProperty(response, "probeTiming", {
        value: {
          ttfbMs: 10,
          transferDurationMs: 40,
          durationMs: 50
        }
      });
      return response;
    }
    return new Response("signature rejected", { status: 403 });
  };
  try {
    const first = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: referenceUrl,
        observedReference: true,
        referenceHash,
        referenceStatus: 206,
        referenceBytes: 262_144
      },
      tabId
    );
    assert.ok(
      first.config.compatibleRoutes[`${presentationId}::${routeKey}`].some(
        (url) =>
          new URL(url).hostname ===
          "upos-sz-upcdnbda2.bilivideo.com"
      )
    );

    const registration = await send(
      {
        type: "REGISTER_MEDIA_ROUTES",
        sessionId,
        routes: [
          {
            presentationId,
            routeKey,
            urls: [referenceUrl],
            kind: "video",
            bandwidth: 100_000_000
          }
        ]
      },
      tabId
    );
    assert.deepEqual(
      registration.config.compatibleRoutes[`${presentationId}::${routeKey}`] ?? [],
      []
    );
    const refreshed = await send(
      {
        type: "GET_RUNTIME_CONFIG",
        sessionId,
        sessionEpoch: 1,
        pageUrl
      },
      tabId
    );
    assert.deepEqual(
      refreshed.config.compatibleRoutes[`${presentationId}::${routeKey}`] ?? [],
      []
    );
  } finally {
    globalThis.fetch = originalFetch;
    await send({ type: "CLEAR_PROBE_CACHE" }, tabId);
    tabRemovedListener(tabId);
  }
});

test("a byte-zero recovery probe cannot reauthorize a host with a real open circuit", async () => {
  const tabId = 111;
  const sessionId = "session-open-host-probe";
  const presentationId = "bvid-BVOPENHOST";
  const routeKey = "/path/open-host.m4s";
  const referenceUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/open-host.m4s?hdnts=official";
  const alternateUrl =
    "https://upos-sz-upcdnbda2.bilivideo.com/path/open-host.m4s?hdnts=official";
  const sample = new Uint8Array(262_144).fill(23);
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVOPENHOST"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey,
          urls: [referenceUrl, alternateUrl],
          kind: "video",
          bandwidth: 1_000_000
        }
      ]
    },
    tabId
  );
  globalThis.fetch = async () =>
    new Response(sample, { status: 206 });
  try {
    const initial = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: referenceUrl
      },
      tabId
    );
    assert.ok(
      initial.config.compatibleRoutes[`${presentationId}::${routeKey}`].includes(
        referenceUrl
      )
    );
    await send(
      {
        type: "HOST_DEGRADED",
        sessionId,
        presentationId,
        routeKey,
        host: "upos-hz-mirrorakam.akamaized.net",
        reason: "body-stalled"
      },
      tabId
    );
    const rotated = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: alternateUrl
      },
      tabId
    );
    assert.equal(
      rotated.config.compatibleRoutes[
        `${presentationId}::${routeKey}`
      ].includes(referenceUrl),
      false
    );
    const response = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey,
        mediaUrl: referenceUrl,
        observedReference: true,
        referenceHash: createHash("sha256").update(sample).digest("hex"),
        referenceStatus: 206,
        referenceBytes: sample.byteLength
      },
      tabId
    );
    const compatible =
      response.config.compatibleRoutes[`${presentationId}::${routeKey}`] ?? [];
    assert.equal(compatible.includes(referenceUrl), false);
    assert.ok(
      compatible.some(
        (url) =>
          new URL(url).hostname ===
          "upos-sz-upcdnbda2.bilivideo.com"
      )
    );
    const reference = response.config.probeResults.find(
      (entry) => entry.host === "upos-hz-mirrorakam.akamaized.net"
    );
    assert.equal(reference.compatible, true);
    assert.equal(reference.routeQualified, false);
    assert.equal(reference.healthy, false);
  } finally {
    globalThis.fetch = originalFetch;
    await send({ type: "CLEAR_PROBE_CACHE" }, tabId);
    tabRemovedListener(tabId);
  }
});

test("the service worker rejects malformed observed reference evidence before probing", async () => {
  const tabId = 107;
  const sessionId = "session-invalid-observed-reference";
  const presentationId = "bvid-BVINVALIDREF";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVINVALIDREF"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey: "/path/video.m4s",
          urls: [backupUrl],
          kind: "video"
        }
      ]
    },
    tabId
  );
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(new Uint8Array(262_144), { status: 206 });
  };
  try {
    await assert.rejects(
      () =>
        send(
          {
            type: "PROBE_MEDIA",
            sessionId,
            presentationId,
            routeKey: "/path/video.m4s",
            mediaUrl: backupUrl,
            observedReference: true,
            referenceHash: "bad",
            referenceStatus: 206,
            referenceBytes: 262_144
          },
          tabId
        ),
      /Rejected observed probe reference/
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    tabRemovedListener(tabId);
  }
});

test("a rotated recovery probe preserves an earlier byte-compatible fallback", async () => {
  const tabId = 102;
  const sessionId = "session-probe-union";
  const presentationId = "bvid-BVPROBEUNION:cid-1";
  const referenceUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/union.m4s?hdnts=official";
  const bdaUrl =
    "https://upos-sz-upcdnbda2.bilivideo.com/path/union.m4s?hdnts=official";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVPROBEUNION"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey: "/path/union.m4s",
          urls: [referenceUrl],
          kind: "video"
        }
      ]
    },
    tabId
  );

  let probeRound = 0;
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    if (host === "upos-hz-mirrorakam.akamaized.net") {
      probeRound += 1;
      return new Response(new Uint8Array(262144), { status: 206 });
    }
    if (
      probeRound === 1 &&
      host === "upos-sz-upcdnbda2.bilivideo.com"
    ) {
      return new Response(new Uint8Array(262144), { status: 206 });
    }
    return new Response("signature rejected", { status: 403 });
  };
  try {
    const first = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey: "/path/union.m4s",
        mediaUrl: referenceUrl
      },
      tabId
    );
    assert.ok(
      first.config.compatibleRoutes[
        `${presentationId}::/path/union.m4s`
      ].includes(bdaUrl)
    );
    assert.equal(first.probeOutcome.attemptedPoolCandidates, 2);
    assert.ok(first.probeOutcome.candidatePoolSize >= 2);

    const second = await send(
      {
        type: "PROBE_MEDIA",
        sessionId,
        presentationId,
        routeKey: "/path/union.m4s",
        mediaUrl: referenceUrl
      },
      tabId
    );
    assert.ok(
      second.config.compatibleRoutes[
        `${presentationId}::/path/union.m4s`
      ].includes(bdaUrl)
    );
    assert.equal(second.probeOutcome.attemptedPoolCandidates, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await send({ type: "CLEAR_PROBE_CACHE" }, tabId);
    tabRemovedListener(tabId);
  }
});

test("a statically blocked native escape cannot close through recovery", async () => {
  const tabId = 99;
  const sessionId = "session-static-recovery";
  const presentationId = "bvid-BVSTATIC:cid-1";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVSTATIC"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey: "/path/video.m4s",
          urls: [sourceUrl, backupUrl],
          kind: "video"
        }
      ]
    },
    tabId
  );
  const degraded = await send(
    {
      type: "HOST_DEGRADED",
      sessionId,
      presentationId,
      host: "upos-sz-mirrorcosov.bilivideo.com",
      routeKey: "/path/video.m4s",
      reason: "http-failure"
    },
    tabId
  );
  assert.equal(degraded.circuit, "static-open");
  const recovered = await send(
    {
      type: "HOST_RECOVERED",
      sessionId,
      presentationId,
      host: "upos-sz-mirrorcosov.bilivideo.com",
      routeKey: "/path/video.m4s",
      healthySegments: 2,
      bufferAhead: 2
    },
    tabId
  );
  assert.equal(recovered.recovered, false);
  assert.equal(recovered.circuit, "static-open");
  assert.ok(
    sessionRules.some(
      (rule) =>
        rule.condition.tabIds?.includes(tabId) &&
        rule.action.redirect.url === backupUrl
    )
  );
  tabRemovedListener(tabId);
  await waitFor(
    () => !sessionRules.some((rule) => rule.condition.tabIds?.includes(tabId)),
    "static-recovery tab cleanup"
  );
});

test("an exhausted exact route removes its DNR redirects during native bypass", async () => {
  const tabId = 100;
  const sessionId = "session-native-bypass";
  const presentationId = "bvid-BVNATIVE:cid-1";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVNATIVE"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey: "/path/video.m4s",
          urls: [sourceUrl, backupUrl],
          kind: "video"
        }
      ]
    },
    tabId
  );
  await send(
    {
      type: "HOST_DEGRADED",
      sessionId,
      presentationId,
      host: "upos-sz-mirrorcosov.bilivideo.com",
      routeKey: "/path/video.m4s",
      reason: "http-failure"
    },
    tabId
  );
  assert.ok(
    sessionRules.some((rule) => rule.condition.tabIds?.includes(tabId))
  );

  const bypass = await send(
    {
      type: "BYPASS_PLAYBACK_ROUTE",
      sessionId,
      presentationId,
      routeKey: "/path/video.m4s",
      persistent: true
    },
    tabId
  );
  assert.equal(bypass.persistent, true);
  assert.equal(bypass.ruleCount, 0);
  assert.equal(
    sessionRules.some((rule) => rule.condition.tabIds?.includes(tabId)),
    false
  );
  const originalDateNow = Date.now;
  const lowerSource =
    "https://upos-sz-mirrorcos.bilivideo.com/path/lower.m4s?token=source";
  const lowerBackup =
    "https://upos-hz-mirrorakam.akamaized.net/path/lower.m4s?token=backup";
  try {
    const base = originalDateNow();
    Date.now = () => base + 5 * 60_000;
    const registration = await send(
      {
        type: "REGISTER_MEDIA_ROUTES",
        sessionId,
        routes: [
          {
            presentationId,
            routeKey: "/path/video.m4s",
            urls: [sourceUrl, backupUrl],
            kind: "video"
          },
          {
            presentationId,
            routeKey: "/path/lower.m4s",
            urls: [lowerSource, lowerBackup],
            kind: "video"
          }
        ]
      },
      tabId
    );
    assert.equal(registration.ruleCount, 0);
    await send(
      {
        type: "HOST_DEGRADED",
        sessionId,
        presentationId,
        host: "upos-sz-mirrorcos.bilivideo.com",
        routeKey: "/path/lower.m4s",
        reason: "http-failure"
      },
      tabId
    );
    assert.equal(
      sessionRules.some(
        (rule) => rule.action.redirect.url === backupUrl
      ),
      false
    );
    assert.ok(
      sessionRules.some(
        (rule) => rule.action.redirect.url === lowerBackup
      )
    );
  } finally {
    Date.now = originalDateNow;
  }
  await assert.rejects(
    () =>
      send(
        {
          type: "BYPASS_PLAYBACK_ROUTE",
          sessionId,
          presentationId: "bvid-BVOTHER",
          routeKey: "/path/video.m4s",
          until: Date.now() + 30_000
        },
        tabId
      ),
    /rejected native route bypass/i
  );
  tabRemovedListener(tabId);
});

test("a failed persistent bypass rolls service-worker route state back before replying", async () => {
  const tabId = 311;
  const sessionId = "session-bypass-rollback";
  const presentationId = "bvid-BVBYPASSROLLBACK";
  const routeKey = "/path/bypass-rollback.m4s";
  const safeSource =
    "https://upos-sz-mirrorcos.bilivideo.com/path/bypass-rollback.m4s?token=source";
  const safeBackup =
    "https://upos-hz-mirrorakam.akamaized.net/path/bypass-rollback.m4s?token=backup";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVBYPASSROLLBACK"
    },
    tabId
  );
  const routes = [
    {
      presentationId,
      routeKey,
      urls: [safeSource, safeBackup],
      kind: "video"
    }
  ];
  await send(
    { type: "REGISTER_MEDIA_ROUTES", sessionId, routes },
    tabId
  );
  await send(
    {
      type: "HOST_DEGRADED",
      sessionId,
      presentationId,
      routeKey,
      host: "upos-sz-mirrorcos.bilivideo.com",
      reason: "http-failure"
    },
    tabId
  );
  assert.ok(
    sessionRules.some(
      (rule) =>
        rule.condition.tabIds?.includes(tabId) &&
        rule.action.redirect.url === safeBackup
    )
  );

  try {
    failNextSessionRuleUpdate = true;
    await assert.rejects(
      () =>
        send(
          {
            type: "BYPASS_PLAYBACK_ROUTE",
            sessionId,
            presentationId,
            routeKey,
            persistent: true
          },
          tabId
        ),
      /synthetic session-rule failure/
    );
    const registration = await send(
      { type: "REGISTER_MEDIA_ROUTES", sessionId, routes },
      tabId
    );
    assert.equal(registration.ruleCount, 1);
    assert.ok(
      sessionRules.some(
        (rule) =>
          rule.condition.tabIds?.includes(tabId) &&
          rule.action.redirect.url === safeBackup
      )
    );
  } finally {
    failNextSessionRuleUpdate = false;
    tabRemovedListener(tabId);
  }
});

test("service worker isolates exact fallback rules by tab and playback session", async () => {
  const registrationBaseline = {
    register: registerScriptCalls,
    unregister: unregisterScriptCalls
  };
  storageState.settings.privacy.telemetryBlocking = false;
  storageChangedListener(
    { settings: { newValue: structuredClone(storageState.settings) } },
    "local"
  );
  await waitFor(() => dynamicRules.length === 2, "privacy-rule reduction");
  storageState.settings.privacy.telemetryBlocking = true;
  storageChangedListener(
    { settings: { newValue: structuredClone(storageState.settings) } },
    "local"
  );
  await waitFor(() => dynamicRules.length === 5, "privacy-rule restoration");
  assert.deepEqual(
    {
      register: registerScriptCalls,
      unregister: unregisterScriptCalls
    },
    registrationBaseline,
    "settings that do not change script worlds must not create an injection gap"
  );

  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "session-tab-one",
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV1"
    },
    101
  );
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "session-tab-two",
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV2"
    },
    202
  );
  await assert.rejects(
    () =>
      sendWithBoundTab(
        {
          type: "REGISTER_MEDIA_ROUTES",
          sessionId: "session-tab-one",
          routes: [{ urls: [sourceUrl, backupUrl] }]
        },
        999
      ),
    /Playback routing requires a tab sender/
  );
  for (const [tabId, sessionId] of [
    [101, "session-tab-one"],
    [202, "session-tab-two"]
  ]) {
    await send(
      {
        type: "REGISTER_MEDIA_ROUTES",
        sessionId,
        routes: [
          {
            routeKey: "/path/video.m4s",
            urls: [sourceUrl, backupUrl],
            bandwidth: 1_000_000,
            kind: "video"
          },
          {
            routeKey: "/path/audio.m4s",
            urls: [audioSourceUrl, audioBackupUrl],
            bandwidth: 128_000,
            kind: "audio"
          }
        ]
      },
      tabId
    );
  }
  await assert.rejects(
    () =>
      send(
        {
          type: "HOST_DEGRADED",
          sessionId: "session-tab-one",
          host: "unregistered.bilivideo.com",
          routeKey: "/path/video.m4s",
          reason: "untrusted-route-host"
        },
        101
      ),
    /Rejected degraded media host/
  );
  await assert.rejects(
    () =>
      send(
        {
          type: "HOST_DEGRADED",
          sessionId: "session-tab-one",
          presentationId: "forged-presentation",
          host: "upos-sz-mirrorcosov.bilivideo.com",
          routeKey: "/path/video.m4s",
          reason: "forged-route-identity"
        },
        101
      ),
    /Rejected degraded media host/
  );

  const degraded = await Promise.all([
    send(
      {
        type: "HOST_DEGRADED",
        sessionId: "session-tab-one",
        host: "upos-sz-mirrorcosov.bilivideo.com",
        routeKey: "/path/video.m4s",
        reason: "slow-body"
      },
      101
    ),
    sendWithBoundTab(
      {
        type: "HOST_DEGRADED",
        sessionId: "session-tab-two",
        host: "upos-sz-mirrorcosov.bilivideo.com",
        routeKey: "/path/video.m4s",
        reason: "http-failure"
      },
      202
    )
  ]);
  assert.deepEqual(
    degraded.map((response) => response.ruleCount),
    [2, 2]
  );
  assert.equal(sessionRules.length, 4);
  assert.deepEqual(
    sessionRules.map((rule) => rule.condition.tabIds[0]).sort(),
    [101, 101, 202, 202]
  );
  assert.deepEqual(
    [...new Set(sessionRules.map((rule) => rule.action.redirect.url))].sort(),
    [audioBackupUrl, backupUrl].sort()
  );
  tabRemovedListener(202);
  await waitFor(
    () =>
      sessionRules.length === 2 &&
      sessionRules.every((rule) => rule.condition.tabIds[0] === 101),
    "closed-tab session-rule cleanup"
  );

  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "session-tab-one-next",
      sessionEpoch: 2,
      pageUrl: "https://www.bilibili.com/video/BV3"
    },
    101
  );
  assert.equal(sessionRules.length, 0);

  const lateStart = await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "session-tab-one",
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV1"
    },
    101
  );
  assert.equal(lateStart.sessionId, "session-tab-one-next");
});

test("a host recovery acknowledgement cannot bypass the hard cooldown", async () => {
  const tabId = 303;
  const sessionId = "session-recovery-gate";
  const safeSource =
    "https://upos-sz-mirrorcos.bilivideo.com/path/recovery.m4s?token=source";
  const safeBackup =
    "https://upos-hz-mirrorakam.akamaized.net/path/recovery.m4s?token=backup";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV-recovery"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId: "BV-recovery:cid-1",
          urls: [safeSource, safeBackup],
          kind: "video"
        }
      ]
    },
    tabId
  );
  const degraded = await send(
    {
      type: "HOST_DEGRADED",
      sessionId,
      presentationId: "BV-recovery:cid-1",
      host: "upos-sz-mirrorcos.bilivideo.com",
      routeKey: "/path/recovery.m4s",
      reason: "http-failure"
    },
    tabId
  );
  assert.equal(degraded.circuit, "open");
  assert.equal(degraded.ruleCount, 1);

  const early = await send(
    {
      type: "HOST_RECOVERED",
      sessionId,
      presentationId: "BV-recovery:cid-1",
      host: "upos-sz-mirrorcos.bilivideo.com",
      routeKey: "/path/recovery.m4s",
      healthySegments: 2,
      bufferAhead: 2
    },
    tabId
  );
  assert.equal(early.recovered, false);
  assert.equal(early.circuit, "open");
  assert.equal(early.ruleCount, 1);
  tabRemovedListener(tabId);
  await waitFor(
    () => !sessionRules.some((rule) => rule.condition.tabIds?.includes(tabId)),
    "recovery-test tab cleanup"
  );
});

test("hard failures stay quarantined for the route session", async () => {
  const tabId = 305;
  const sessionId = "session-half-open-push";
  const presentationId = "BV-half-open:cid-1";
  const safeSource =
    "https://upos-sz-mirrorcos.bilivideo.com/path/half-open.m4s?token=source";
  const safeBackup =
    "https://upos-hz-mirrorakam.akamaized.net/path/half-open.m4s?token=backup";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV-half-open"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          urls: [safeSource, safeBackup],
          kind: "video"
        }
      ]
    },
    tabId
  );

  const originalDateNow = Date.now;
  const now = originalDateNow();
  const degraded = await send(
    {
      type: "HOST_DEGRADED",
      sessionId,
      presentationId,
      host: "upos-sz-mirrorcos.bilivideo.com",
      routeKey: "/path/half-open.m4s",
      reason: "http-failure"
    },
    tabId
  );
  assert.equal(degraded.circuit, "open");
  assert.deepEqual(
    degraded.config.degradedRoutes[
      `${presentationId}::/path/half-open.m4s`
    ],
    ["upos-sz-mirrorcos.bilivideo.com"]
  );
  assert.deepEqual(degraded.config.halfOpenRoutes, {});

  try {
    Date.now = () => now + 60_001;
    const recovered = await send(
      {
        type: "HOST_RECOVERED",
        sessionId,
        presentationId,
        host: "upos-sz-mirrorcos.bilivideo.com",
        routeKey: "/path/half-open.m4s",
        healthySegments: 2,
        bufferAhead: 2
      },
      tabId
    );
    assert.equal(recovered.recovered, false);
    assert.equal(recovered.circuit, "open");
    assert.deepEqual(recovered.config.halfOpenRoutes, {});
    assert.deepEqual(
      recovered.config.degradedRoutes[
        `${presentationId}::/path/half-open.m4s`
      ],
      ["upos-sz-mirrorcos.bilivideo.com"]
    );
  } finally {
    Date.now = originalDateNow;
  }
  tabRemovedListener(tabId);
});

test("playback-risk evidence expires instead of accumulating forever", async () => {
  const tabId = 306;
  const sessionId = "session-risk-window";
  const presentationId = "BV-risk-window:cid-1";
  const routeKey = "/path/risk-window.m4s";
  const safeSource =
    "https://upos-sz-mirrorcos.bilivideo.com/path/risk-window.m4s?token=source";
  const safeBackup =
    "https://upos-hz-mirrorakam.akamaized.net/path/risk-window.m4s?token=backup";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV-risk-window"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey,
          urls: [safeSource, safeBackup],
          kind: "video"
        }
      ]
    },
    tabId
  );
  const risk = {
    type: "PLAYBACK_RISK",
    sessionId,
    presentationId,
    routeKey,
    host: "upos-sz-mirrorcos.bilivideo.com",
    reason: "sustained-waiting"
  };
  const originalDateNow = Date.now;
  const base = originalDateNow();
  try {
    Date.now = () => base;
    const first = await send(risk, tabId);
    assert.equal(first.count, 1);
    assert.equal(first.escalated, false);

    Date.now = () => base + 15_001;
    const expired = await send(risk, tabId);
    assert.equal(expired.count, 1);
    assert.equal(expired.escalated, false);

    Date.now = () => base + 15_002;
    const repeated = await send(risk, tabId);
    assert.equal(repeated.count, 2);
    assert.equal(repeated.escalated, true);
    assert.equal(repeated.circuit, "open");
    assert.equal(repeated.fallbackAvailable, true);
  } finally {
    Date.now = originalDateNow;
  }
  tabRemovedListener(tabId);
});

test("a hard failure on the only route host reports immediate exhaustion", async () => {
  const tabId = 307;
  const sessionId = "session-route-exhausted";
  const presentationId = "BV-route-exhausted:cid-1";
  const routeKey = "/path/only-host.m4s";
  const onlyUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/only-host.m4s?token=only";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV-route-exhausted"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId,
          routeKey,
          urls: [onlyUrl],
          kind: "video"
        }
      ]
    },
    tabId
  );
  const degraded = await send(
    {
      type: "HOST_DEGRADED",
      sessionId,
      presentationId,
      routeKey,
      host: "upos-hz-mirrorakam.akamaized.net",
      reason: "body-stalled"
    },
    tabId
  );
  assert.equal(degraded.escalated, true);
  assert.equal(degraded.fallbackAvailable, false);
  assert.equal(degraded.exhausted, true);
  assert.deepEqual(
    degraded.config.compatibleRoutes[
      `${presentationId}::${routeKey}`
    ] ?? [],
    []
  );
  tabRemovedListener(tabId);
});

test("50 concurrent host failures create one breaker/DNR transition", async () => {
  const tabId = 304;
  const sessionId = "session-singleflight";
  const safeSource =
    "https://upos-sz-mirrorcos.bilivideo.com/path/singleflight.m4s?token=source";
  const safeBackup =
    "https://upos-hz-mirrorakam.akamaized.net/path/singleflight.m4s?token=backup";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV-singleflight"
    },
    tabId
  );
  await send(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId,
      routes: [
        {
          presentationId: "BV-singleflight:cid-1",
          urls: [safeSource, safeBackup],
          kind: "video"
        }
      ]
    },
    tabId
  );
  const updatesBefore = sessionRuleUpdateLog.length;
  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      send(
        {
          type: "HOST_DEGRADED",
          sessionId,
          presentationId: "BV-singleflight:cid-1",
          host: "upos-sz-mirrorcos.bilivideo.com",
          routeKey: "/path/singleflight.m4s",
          reason: "http-failure"
        },
        tabId
      )
    )
  );
  assert.ok(results.every((result) => result.circuit === "open"));
  assert.ok(sessionRuleUpdateLog.length - updatesBefore <= 2);
  assert.equal(
    sessionRules.filter((rule) => rule.condition.tabIds?.includes(tabId))
      .length,
    1
  );
  tabRemovedListener(tabId);
  await waitFor(
    () => !sessionRules.some((rule) => rule.condition.tabIds?.includes(tabId)),
    "singleflight tab cleanup"
  );
});

test("twenty tabs prove per-tab rule mutation latency against the legacy global chain", async (context) => {
  const tabIds = Array.from({ length: 20 }, (_, index) => 400 + index);
  await Promise.all(
    tabIds.map((tabId) =>
      send(
        {
          type: "START_PLAYBACK_SESSION",
          sessionId: `session-concurrent-${tabId}`,
          sessionEpoch: 1,
          pageUrl: `https://www.bilibili.com/video/BV${tabId}`
        },
        tabId
      )
    )
  );
  const startedAt = performance.now();
  const readyAt = [];
  await Promise.all(
    tabIds.map((tabId) =>
      send(
        {
          type: "REGISTER_MEDIA_ROUTES",
          sessionId: `session-concurrent-${tabId}`,
          routes: [
            {
              presentationId: `BV${tabId}:cid-${tabId}`,
              routeKey: "/path/video.m4s",
              urls: [sourceUrl, backupUrl],
              bandwidth: 1_000_000,
              kind: "video"
            }
          ]
        },
        tabId
      ).then(() => readyAt.push(performance.now() - startedAt))
    )
  );
  readyAt.sort((left, right) => left - right);
  const p95 = readyAt[Math.ceil(readyAt.length * 0.95) - 1];
  assert.ok(
    p95 < 300,
    `per-tab rule mutation p95 ${p95.toFixed(1)}ms indicates global serialization`
  );
  assert.equal(
    sessionRules.filter((rule) => tabIds.includes(rule.condition.tabIds[0]))
      .length,
    20
  );

  for (const tabId of tabIds) {
    tabRemovedListener(tabId);
  }
  await waitFor(
    () =>
      sessionRules.every(
        (rule) => !tabIds.includes(rule.condition.tabIds[0])
    ),
    "concurrent-tab session-rule cleanup"
  );

  const legacyTabIds = Array.from({ length: 20 }, (_, index) => 440 + index);
  await Promise.all(
    legacyTabIds.map((tabId) =>
      send(
        {
          type: "START_PLAYBACK_SESSION",
          sessionId: `session-legacy-chain-${tabId}`,
          sessionEpoch: 1,
          pageUrl: `https://www.bilibili.com/video/BV-legacy-${tabId}`
        },
        tabId
      )
    )
  );
  const legacyStartedAt = performance.now();
  const legacyReadyAt = [];
  let legacyGlobalChain = Promise.resolve();
  const legacyOperations = legacyTabIds.map((tabId) => {
    const operation = legacyGlobalChain.then(() =>
      send(
        {
          type: "REGISTER_MEDIA_ROUTES",
          sessionId: `session-legacy-chain-${tabId}`,
          routes: [
            {
              presentationId: `BV-legacy-${tabId}:cid-${tabId}`,
              routeKey: "/path/video.m4s",
              urls: [sourceUrl, backupUrl],
              bandwidth: 1_000_000,
              kind: "video"
            }
          ]
        },
        tabId
      )
    );
    legacyGlobalChain = operation.then(
      () => undefined,
      () => undefined
    );
    return operation.then(() =>
      legacyReadyAt.push(performance.now() - legacyStartedAt)
    );
  });
  await Promise.all(legacyOperations);
  legacyReadyAt.sort((left, right) => left - right);
  const legacyP95 =
    legacyReadyAt[Math.ceil(legacyReadyAt.length * 0.95) - 1];
  assert.ok(
    legacyP95 >= p95 * 2,
    `legacy global-chain p95 ${legacyP95.toFixed(1)}ms did not separate from per-tab p95 ${p95.toFixed(1)}ms`
  );
  context.diagnostic(
    `T25 comparison: per-tab p95=${p95.toFixed(1)}ms, legacy-global-chain p95=${legacyP95.toFixed(1)}ms, ratio=${(legacyP95 / Math.max(0.1, p95)).toFixed(1)}x`
  );

  for (const tabId of legacyTabIds) {
    tabRemovedListener(tabId);
  }
  await waitFor(
    () =>
      sessionRules.every(
        (rule) => !legacyTabIds.includes(rule.condition.tabIds[0])
      ),
    "legacy-comparison session-rule cleanup"
  );
});

test("global DNR allocation is capped at 96 rules and shared fairly", async () => {
  const countHistoryStart = sessionRuleCountHistory.length;
  const tabIds = Array.from({ length: 8 }, (_, index) => 500 + index);
  await Promise.all(
    tabIds.map((tabId) =>
      send(
        {
          type: "START_PLAYBACK_SESSION",
          sessionId: `session-fair-${tabId}`,
          sessionEpoch: 1,
          pageUrl: `https://www.bilibili.com/video/BV-fair-${tabId}`
        },
        tabId
      )
    )
  );
  await Promise.all(
    tabIds.map((tabId) =>
      send(
        {
          type: "REGISTER_MEDIA_ROUTES",
          sessionId: `session-fair-${tabId}`,
          routes: Array.from({ length: 16 }, (_, index) => ({
            presentationId: `BV-fair-${tabId}:cid-1`,
            kind: index % 2 ? "audio" : "video",
            urls: [
              `https://upos-sz-mirrorcosov.bilivideo.com/fair/${tabId}/${index}.m4s?token=source-${index}`,
              `https://upos-hz-mirrorakam.akamaized.net/fair/${tabId}/${index}.m4s?token=backup-${index}`
            ]
          }))
        },
        tabId
      )
    )
  );

  const fairRules = sessionRules.filter((rule) =>
    tabIds.includes(rule.condition.tabIds?.[0])
  );
  assert.equal(fairRules.length, 96);
  const counts = tabIds.map(
    (tabId) =>
      fairRules.filter((rule) => rule.condition.tabIds?.[0] === tabId).length
  );
  assert.deepEqual(counts, Array(8).fill(12));
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  const runtime = await send(
    {
      type: "GET_RUNTIME_CONFIG",
      sessionId: "session-fair-500",
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV-fair-500"
    },
    500
  );
  assert.ok(runtime.config.resourceStats.trackedTabs >= 8);
  assert.ok(runtime.config.resourceStats.trackedTabs <= 32);
  assert.equal(runtime.config.resourceStats.tabRules, 12);
  assert.equal(runtime.config.resourceStats.totalSessionRules, 96);
  assert.equal(runtime.config.resourceStats.maxGlobalRules, 96);
  const allocationHistory = sessionRuleCountHistory.slice(countHistoryStart);
  assert.ok(allocationHistory.length > 0);
  assert.ok(
    Math.max(...allocationHistory) <= 96,
    `session-rule peak crossed the global cap: ${Math.max(...allocationHistory)}`
  );

  for (const tabId of tabIds) {
    tabRemovedListener(tabId);
  }
  await waitFor(
    () =>
      sessionRules.every(
        (rule) => !tabIds.includes(rule.condition.tabIds?.[0])
      ),
    "fair-allocation tab cleanup"
  );
});

test("inactive playback state is evicted after two minutes without waiting for capacity pressure", async () => {
  const originalDateNow = Date.now;
  const startedAt = originalDateNow();
  const expiredTabId = 608;
  const wakeTabId = 609;
  try {
    await send(
      {
        type: "START_PLAYBACK_SESSION",
        sessionId: "session-expiring",
        sessionEpoch: 1,
        pageUrl: "https://www.bilibili.com/video/BV-expiring"
      },
      expiredTabId
    );
    Date.now = () => startedAt + 120_001;
    await send(
      {
        type: "START_PLAYBACK_SESSION",
        sessionId: "session-wakeup",
        sessionEpoch: 1,
        pageUrl: "https://www.bilibili.com/video/BV-wakeup"
      },
      wakeTabId
    );
    await assert.rejects(
      () =>
        send(
          {
            type: "REGISTER_MEDIA_ROUTES",
            sessionId: "session-expiring",
            routes: [{ urls: [sourceUrl, backupUrl] }]
          },
          expiredTabId
        ),
      /Stale or unknown playback session/
    );
  } finally {
    Date.now = originalDateNow;
    tabRemovedListener(expiredTabId);
    tabRemovedListener(wakeTabId);
  }
});

test("concurrent session starts cannot exceed the 32-tab tracking cap", async () => {
  tabRemovedListener(101);
  const tabIds = Array.from({ length: 32 }, (_, index) => 700 + index);
  await Promise.all(
    tabIds.map((tabId) =>
      send(
        {
          type: "START_PLAYBACK_SESSION",
          sessionId: `session-cap-${tabId}`,
          sessionEpoch: 1,
          pageUrl: `https://www.bilibili.com/video/BV-cap-${tabId}`
        },
        tabId
      )
    )
  );
  await assert.rejects(
    () =>
      send(
        {
          type: "START_PLAYBACK_SESSION",
          sessionId: "session-cap-overflow",
          sessionEpoch: 1,
          pageUrl: "https://www.bilibili.com/video/BV-cap-overflow"
        },
        799
      ),
    /Playback tracking capacity reached/
  );
  for (const tabId of tabIds) {
    tabRemovedListener(tabId);
  }
});

test("presentation, route, and host state remain within hard caps under oversized manifests", async () => {
  const tabId = 740;
  const sessionId = "session-state-caps";
  await send(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV-state-caps"
    },
    tabId
  );
  for (let presentation = 0; presentation < 5; presentation += 1) {
    await send(
      {
        type: "REGISTER_MEDIA_ROUTES",
        sessionId,
        routes: Array.from({ length: 32 }, (_, route) => ({
          presentationId: `presentation-${presentation}`,
          kind: route % 2 ? "audio" : "video",
          urls: Array.from(
            { length: 10 },
            (_, host) =>
              `https://upos-${host}.bilivideo.com/caps/${presentation}/${route}.m4s?token=${host}`
          )
        }))
      },
      tabId
    );
  }
  const runtime = await send(
    {
      type: "GET_RUNTIME_CONFIG",
      sessionId,
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BV-state-caps"
    },
    tabId
  );
  const resources = runtime.config.resourceStats;
  assert.equal(resources.presentations, 4);
  assert.equal(resources.routes, 4 * 32);
  assert.equal(resources.routeHosts, 4 * 32 * 8);
  assert.equal(resources.maxHostsPerRoute, 8);
  tabRemovedListener(tabId);
});

test("diagnostics coalesce per-tab events and enforce the serialized byte budget", async () => {
  const writesBefore = storageSetLog.filter((keys) =>
    keys.includes("diagnostics")
  ).length;
  const detail = "x".repeat(300);
  await Promise.all(
    Array.from({ length: 420 }, (_, index) =>
      send(
        {
          type: "RECORD_DIAGNOSTIC",
          session: {
            id: `diagnostic-${index}`,
            pageUrl:
              `https://www.bilibili.com/video/BV${index}?` +
              "q=".repeat(250),
            startedAt: index + 1,
            updatedAt: index + 1,
            ...(index === 419
              ? {
                  routeDetails: Object.fromEntries([
                    ...Array.from({ length: 40 }, (_, route) => [
                      `planning-${route}`,
                      {
                        id: `planning-${route}`,
                        presentationId: "presentation",
                        routeKey: `/planning/${route}.m4s`,
                        updatedAt: route + 1
                      }
                    ]),
                    [
                      "degraded-route",
                      {
                        id: "degraded-route",
                        presentationId: "presentation",
                        routeKey: "/active/degraded.m4s",
                        bandwidth: 8_000_000,
                        lastRequiredBps: 10_000_000,
                        mediaHost:
                          "upos-sz-mirrorcos.bilivideo.com",
                        degradedCount: 12,
                        recoveryStatus: "handoff",
                        updatedAt: 100
                      }
                    ]
                  ]),
                  playerDetails: Object.fromEntries(
                    Array.from({ length: 6 }, (_, player) => [
                      `player-${player + 1}`,
                      {
                        playerId: `player-${player + 1}`,
                        updatedAt: player + 1,
                        paused: player % 2 === 0
                      }
                    ])
                  )
                }
              : {}),
            recentEvents: Array.from({ length: 30 }, () => ({
              type: "beacon-blocked",
              at: index + 1,
              detail
            }))
          }
        },
        777
      )
    )
  );
  const writesAfter = storageSetLog.filter((keys) =>
    keys.includes("diagnostics")
  ).length;
  assert.equal(writesAfter - writesBefore, 1);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(storageState.diagnostics))
      .byteLength <=
      1024 * 1024
  );
  assert.ok(storageState.diagnostics.sessions.length < 420);
  const newest = storageState.diagnostics.sessions.find(
    (session) => session.id === "diagnostic-419"
  );
  assert.deepEqual(
    Object.keys(newest.playerDetails),
    ["player-6", "player-5", "player-4", "player-3"]
  );
  assert.equal(newest.playerDetails["player-5"].paused, true);
  assert.ok(Object.keys(newest.routeDetails).length <= 9);
  assert.equal(
    newest.routeDetails["degraded-route"].recoveryStatus,
    "handoff"
  );
  assert.equal(newest.routeDetails["degraded-route"].bandwidth, 8_000_000);
  assert.equal(
    newest.routeDetails["degraded-route"].lastRequiredBps,
    10_000_000
  );
  const throttledWritesBefore = storageSetLog.filter((keys) =>
    keys.includes("diagnostics")
  ).length;
  await send(
    {
      type: "RECORD_DIAGNOSTIC",
      session: {
        id: "diagnostic-throttled",
        pageUrl: "https://www.bilibili.com/video/BV-throttled",
        startedAt: Date.now(),
        updatedAt: Date.now()
      }
    },
    778
  );
  assert.equal(
    storageSetLog.filter((keys) => keys.includes("diagnostics")).length,
    throttledWritesBefore,
    "steady-state diagnostics must be coalesced instead of rewriting storage every second"
  );
});

test("stale sessions are rejected and global disable removes every rule surface", async () => {
  await assert.rejects(
    () =>
      send(
        {
          type: "HOST_DEGRADED",
          sessionId: "session-tab-one",
          host: "upos-sz-mirrorcosov.bilivideo.com",
          routeKey: "/path/video.m4s",
          reason: "late-result"
        },
        101
      ),
    /Stale or unknown playback session/
  );

  const enabledSettings = structuredClone(storageState.settings);
  storageState.settings.globalEnabled = false;
  storageChangedListener(
    {
      settings: {
        oldValue: enabledSettings,
        newValue: structuredClone(storageState.settings)
      }
    },
    "local"
  );
  await waitFor(
    () =>
      dynamicRules.length === 0 &&
      sessionRules.length === 0 &&
      registeredScripts.length === 0,
    "global disable reconciliation"
  );
  assert.deepEqual(dynamicRules, []);
  assert.deepEqual(sessionRules, []);
  assert.deepEqual(registeredScripts, []);

  const disabledConfig = await send(
    {
      type: "GET_RUNTIME_CONFIG",
      sessionId: "disabled-session",
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVDISABLED"
    },
    303
  );
  assert.equal(disabledConfig.config.settings.globalEnabled, false);
  for (const message of [
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "disabled-session",
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVDISABLED"
    },
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId: "disabled-session",
      routes: [{ urls: [sourceUrl, backupUrl] }]
    },
    {
      type: "PROBE_MEDIA",
      sessionId: "disabled-session",
      mediaUrl: sourceUrl
    },
    {
      type: "HOST_DEGRADED",
      sessionId: "disabled-session",
      host: "upos-sz-mirrorcosov.bilivideo.com",
      routeKey: "/path/video.m4s"
    },
    {
      type: "PLAYBACK_RISK",
      sessionId: "disabled-session",
      host: "upos-sz-mirrorcosov.bilivideo.com",
      routeKey: "/path/video.m4s"
    }
  ]) {
    await assert.rejects(() => send(message, 303), /Playback routing is disabled/);
  }

  const disabledSettings = structuredClone(storageState.settings);
  storageState.settings.globalEnabled = true;
  storageChangedListener(
    {
      settings: {
        oldValue: disabledSettings,
        newValue: structuredClone(storageState.settings)
      }
    },
    "local"
  );
  await waitFor(
    () =>
      dynamicRules.length === 5 &&
      sessionRules.length === 0 &&
      registeredScripts.length === 2,
    "re-enable without stale playback rules"
  );
  await assert.rejects(
    () =>
      send(
        {
          type: "HOST_DEGRADED",
          sessionId: "session-tab-two",
          host: "upos-sz-mirrorcosov.bilivideo.com",
          routeKey: "/path/video.m4s",
          reason: "stale-after-re-enable"
        },
        202
      ),
    /Stale or unknown playback session/
  );
  await assert.rejects(
    () =>
      send(
        {
          type: "HOST_DEGRADED",
          sessionId: "disabled-session",
          host: "upos-sz-mirrorcosov.bilivideo.com",
          routeKey: "/path/video.m4s",
          reason: "disabled-state-resurrection"
        },
        303
      ),
    /Stale or unknown playback session/
  );
});

test("document identity rejects an equal-epoch message from a retired document", async () => {
  const senderA = {
    tab: { id: 404 },
    frameId: 0,
    documentId: "document-A"
  };
  const senderB = {
    tab: { id: 404 },
    frameId: 0,
    documentId: "document-B"
  };
  await sendWithSender(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "document-A-session",
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVA"
    },
    senderA
  );
  const current = await sendWithSender(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "document-B-session",
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVB"
    },
    senderB
  );
  assert.equal(current.sessionId, "document-B-session");
  const delayed = await sendWithSender(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "document-A-session",
      sessionEpoch: 1,
      pageUrl: "https://www.bilibili.com/video/BVA"
    },
    senderA
  );
  assert.equal(delayed.sessionId, "document-B-session");
  await assert.rejects(
    () =>
      sendWithSender(
        {
          type: "REGISTER_MEDIA_ROUTES",
          sessionId: "document-A-session",
          routes: [{ urls: [sourceUrl, backupUrl] }]
        },
        senderA
      ),
    /Stale or unknown playback session/
  );
  await assert.rejects(
    () =>
      sendWithSender(
        {
          type: "REGISTER_MEDIA_ROUTES",
          sessionId: "document-B-session",
          routes: [{ urls: [sourceUrl, backupUrl] }]
        },
        senderA
      ),
    /Stale playback document/
  );
});

test("BFCache back navigation un-retires only a strictly newer restored document", async () => {
  const tabId = 406;
  const senderA = {
    tab: { id: tabId },
    frameId: 0,
    documentId: "bfcache-document-A"
  };
  const senderB = {
    tab: { id: tabId },
    frameId: 0,
    documentId: "bfcache-document-B"
  };
  await sendWithSender(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "bfcache-session-A",
      sessionEpoch: 1,
      documentStartedAt: 1_000,
      pageUrl: "https://www.bilibili.com/video/BVA"
    },
    senderA
  );
  await sendWithSender(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "bfcache-session-B",
      sessionEpoch: 1,
      documentStartedAt: 2_000,
      pageUrl: "https://www.bilibili.com/video/BVB"
    },
    senderB
  );
  const replayed = await sendWithSender(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "bfcache-session-A",
      sessionEpoch: 1,
      documentStartedAt: 1_000,
      restoredFromBfcache: true,
      pageUrl: "https://www.bilibili.com/video/BVA"
    },
    senderA
  );
  assert.equal(replayed.sessionId, "bfcache-session-B");

  const restored = await sendWithSender(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "bfcache-session-A",
      sessionEpoch: 1,
      documentStartedAt: 3_000,
      restoredFromBfcache: true,
      pageUrl: "https://www.bilibili.com/video/BVA"
    },
    senderA
  );
  assert.equal(restored.sessionId, "bfcache-session-A");
  const registered = await sendWithSender(
    {
      type: "REGISTER_MEDIA_ROUTES",
      sessionId: "bfcache-session-A",
      routes: [{ urls: [sourceUrl, backupUrl] }]
    },
    senderA
  );
  assert.equal(registered.sessionId, "bfcache-session-A");
  await assert.rejects(
    () =>
      sendWithSender(
        {
          type: "REGISTER_MEDIA_ROUTES",
          sessionId: "bfcache-session-B",
          routes: [{ urls: [sourceUrl, backupUrl] }]
        },
        senderB
      ),
    /Stale or unknown playback session/
  );
  tabRemovedListener(tabId);
});

test("document generation rejects an old document after the retired-ID cache is bounded", async () => {
  const tabId = 405;
  let latestSessionId = "";
  for (let index = 0; index < 40; index += 1) {
    latestSessionId = `document-generation-${index}`;
    const response = await sendWithSender(
      {
        type: "START_PLAYBACK_SESSION",
        sessionId: latestSessionId,
        sessionEpoch: 1,
        documentStartedAt: 1_000 + index,
        pageUrl: `https://www.bilibili.com/video/BV${index}`
      },
      {
        tab: { id: tabId },
        frameId: 0,
        documentId: `document-generation-${index}`
      }
    );
    assert.equal(response.sessionId, latestSessionId);
  }
  const delayed = await sendWithSender(
    {
      type: "START_PLAYBACK_SESSION",
      sessionId: "document-generation-0",
      sessionEpoch: 1,
      documentStartedAt: 1_000,
      pageUrl: "https://www.bilibili.com/video/BV0"
    },
    {
      tab: { id: tabId },
      frameId: 0,
      documentId: "document-generation-0"
    }
  );
  assert.equal(delayed.sessionId, latestSessionId);
});

after(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});
