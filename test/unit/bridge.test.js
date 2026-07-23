import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class TestCustomEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
}

async function createHarness(options = {}) {
  const code = await readFile(
    new URL("../../src/content/bridge.js", import.meta.url),
    "utf8"
  );
  const document = new EventTarget();
  const pageEvents = new EventTarget();
  const messages = [];
  let runtimeMessageListener = null;
  let mutationObserverCallback = null;
  const location = new URL(
    options.pageUrl ?? "https://www.bilibili.com/video/BV1"
  );
  const chrome = {
    runtime: {
      id: "test-extension",
      sendMessage(message) {
        messages.push(structuredClone(message));
        return options.sendMessage
          ? options.sendMessage(message)
          : Promise.resolve({ ok: false });
      },
      onMessage: {
        addListener(listener) {
          runtimeMessageListener = listener;
        }
      }
    },
    storage: {
      onChanged: {
        addListener() {}
      }
    }
  };
  class MutationObserver {
    constructor(callback) {
      mutationObserverCallback = callback;
    }

    observe() {}
  }
  class Element extends EventTarget {
    constructor(source = "") {
      super();
      this.currentSrc =
        source ||
        "https://upos-sz-mirrorcos.bilivideo.com/path/current.m4s";
      this.src = this.currentSrc;
      this.currentTime = 0;
      this.paused = false;
      this.ended = false;
      this.readyState = 1;
      this.isConnected = true;
      this.buffered = { length: 0 };
      this.childVideos = [];
      this.querySelectorAllCalls = 0;
    }

    matches(selector) {
      return selector === "video";
    }

    querySelectorAll(selector) {
      this.querySelectorAllCalls += 1;
      return selector === "video" ? this.childVideos : [];
    }
  }
  const videoCount = Math.max(
    options.withVideo ? 1 : 0,
    Number(options.videoCount) || 0
  );
  const videos = Array.from(
    { length: videoCount },
    (_, index) => new Element(options.videoSources?.[index])
  );
  const video = videos[0] ?? null;
  if (video) {
    video.childVideos = videos.slice(1);
  }
  document.documentElement = video;
  const crypto = {
    randomUUID() {
      return "00000000-0000-4000-8000-000000000001";
    },
    getRandomValues(array) {
      array.fill(0xab);
      return array;
    }
  };
  vm.runInNewContext(
    code,
    {
      document,
      location,
      chrome,
      crypto,
      performance: {
        now: () => 0,
        getEntriesByType: () => []
      },
      MutationObserver,
      Element,
      Event,
      EventTarget,
      CustomEvent: TestCustomEvent,
      URL,
      Uint8Array,
      AbortController,
      Response,
      ReadableStream,
      fetch: options.fetch ?? globalThis.fetch,
      btoa,
      structuredClone,
      addEventListener: pageEvents.addEventListener.bind(pageEvents),
      removeEventListener: pageEvents.removeEventListener.bind(pageEvents),
      setTimeout:
        options.setTimeout ??
        ((callback, delay) => {
          if (delay === 1000) {
            queueMicrotask(callback);
          }
          return 1;
        }),
      clearTimeout() {},
      console
    },
    { filename: "bridge.js" }
  );
  const nonce = "ab".repeat(16);
  const inboundEvent = `bilibili-speedup:private:${nonce}:in`;
  const outboundEvent = `bilibili-speedup:private:${nonce}:out`;
  const mainMessages = [];
  document.addEventListener(inboundEvent, (event) => {
    mainMessages.push(JSON.parse(String(event.detail ?? "")));
  });
  const emitMainMessage = (type, payload = {}) => {
    document.dispatchEvent(
      new TestCustomEvent(outboundEvent, {
        detail: JSON.stringify({ type, payload })
      })
    );
  };
  emitMainMessage("ACK");
  return {
    messages,
    mainMessages,
    video,
    videos,
    setHidden(hidden) {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: Boolean(hidden)
      });
    },
    emitMainMessage,
    dispatchRuntimeMessage(message) {
      return runtimeMessageListener?.(
        structuredClone(message),
        { id: "test-extension" },
        () => {}
      );
    },
    requestRuntimeMessage(message) {
      return new Promise((resolve) => {
        let responded = false;
        const accepted = runtimeMessageListener?.(
          structuredClone(message),
          { id: "test-extension" },
          (response) => {
            responded = true;
            resolve(response);
          }
        );
        if (!accepted && !responded) {
          resolve(undefined);
        }
      });
    },
    dispatchPageShow(persisted) {
      const event = new Event("pageshow");
      Object.defineProperty(event, "persisted", { value: persisted });
      pageEvents.dispatchEvent(event);
    },
    dispatchPageHide() {
      pageEvents.dispatchEvent(new Event("pagehide"));
    },
    dispatchDocumentEvent(type) {
      document.dispatchEvent(new Event(type));
    },
    createElement(source = "") {
      return new Element(source);
    },
    emitMutations(mutations) {
      mutationObserverCallback?.(mutations);
    },
    probeMessages() {
      return messages.filter((message) => message.type === "PROBE_MEDIA");
    }
  };
}

test("search result previews allocate no playback session, probes, routes, or diagnostics", async () => {
  const harness = await createHarness({
    pageUrl:
      "https://search.bilibili.com/all?keyword=music&search_source=5&page=2",
    videoCount: 50
  });
  await new Promise((resolve) => setImmediate(resolve));

  const configRequest = harness.messages.find(
    (message) => message.type === "GET_RUNTIME_CONFIG"
  );
  assert.ok(configRequest);
  assert.equal(
    configRequest.pageUrl,
    "https://search.bilibili.com/all"
  );
  assert.equal("sessionId" in configRequest, false);
  assert.equal(
    harness.messages.some(
      (message) => message.type === "START_PLAYBACK_SESSION"
    ),
    false
  );

  for (let index = 0; index < 50; index += 1) {
    harness.emitMainMessage("ROUTE_MANIFEST", {
      requestId: `preview-${index}`,
      routes: [
        {
          presentationId: `preview-${index}`,
          routeKey: `/preview/${index}.m4s`,
          kind: "video",
          urls: [
            `https://upos-sz-mirrorcos.bilivideo.com/preview/${index}.m4s`
          ]
        }
      ]
    });
    harness.emitMainMessage("PROBE_URL", {
      mediaUrl: `https://upos-sz-mirrorcos.bilivideo.com/preview/${index}.m4s`
    });
    harness.videos[index].dispatchEvent(new Event("loadstart"));
    harness.videos[index].dispatchEvent(new Event("waiting"));
  }
  await new Promise((resolve) => setImmediate(resolve));

  for (const forbiddenType of [
    "REGISTER_MEDIA_ROUTES",
    "PROBE_MEDIA",
    "HOST_DEGRADED",
    "RECORD_DIAGNOSTIC"
  ]) {
    assert.equal(
      harness.messages.some((message) => message.type === forbiddenType),
      false,
      forbiddenType
    );
  }
});

test("DOM additions are scanned in one deferred batch and nested nodes are not rescanned", async () => {
  const deferred = [];
  const harness = await createHarness({
    pageUrl: "https://search.bilibili.com/all?keyword=batch",
    setTimeout(callback, delay) {
      if (delay === 0) {
        deferred.push(callback);
      }
      return deferred.length + 1;
    }
  });
  const parent = harness.createElement();
  const child = harness.createElement();
  child.parentNode = parent;
  harness.emitMutations([
    {
      type: "childList",
      addedNodes: [parent, child],
      removedNodes: []
    },
    ...Array.from({ length: 98 }, () => ({
      type: "childList",
      addedNodes: [harness.createElement()],
      removedNodes: []
    }))
  ]);
  assert.equal(deferred.length, 1);
  assert.equal(parent.querySelectorAllCalls, 0);
  assert.equal(child.querySelectorAllCalls, 0);
  deferred[0]();
  assert.equal(parent.querySelectorAllCalls, 1);
  assert.equal(
    child.querySelectorAllCalls,
    0,
    "a child covered by a queued ancestor must not be scanned twice"
  );
});

test("leaving a playback page stops its session without starting one for search", async () => {
  const harness = await createHarness({
    pageUrl: "https://www.bilibili.com/video/BV1",
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          routingTabId: 77
        });
      }
      return Promise.resolve({ ok: true });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startMessages = harness.messages.filter(
    (message) => message.type === "START_PLAYBACK_SESSION"
  );
  assert.ok(startMessages.length >= 1);
  const playbackSessionId = startMessages.at(-1).sessionId;

  harness.emitMainMessage("NAVIGATION", {
    url: "https://search.bilibili.com/all?keyword=music"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const stopMessages = harness.messages.filter(
    (message) => message.type === "STOP_PLAYBACK_SESSION"
  );
  assert.equal(stopMessages.length, 1);
  assert.equal(stopMessages[0].sessionId, playbackSessionId);
  assert.equal(stopMessages[0].routingTabId, 77);
  assert.equal(
    harness.messages.filter(
      (message) => message.type === "START_PLAYBACK_SESSION"
    ).length,
    startMessages.length
  );
});

test("SPA navigation resets the two-probe per-presentation budget", async () => {
  const harness = await createHarness();
  const mediaUrl = (index) =>
    `https://upos-sz-mirrorcos.bilivideo.com/path/video-${index}.m4s?token=${index}`;

  for (let index = 1; index <= 2; index += 1) {
    harness.emitMainMessage("PROBE_URL", { mediaUrl: mediaUrl(index) });
  }
  assert.equal(harness.probeMessages().length, 2);

  harness.emitMainMessage("PROBE_URL", { mediaUrl: mediaUrl(3) });
  assert.equal(harness.probeMessages().length, 2);

  harness.emitMainMessage("NAVIGATION", {
    url: "https://www.bilibili.com/video/BV2"
  });
  harness.emitMainMessage("PROBE_URL", { mediaUrl: mediaUrl(3) });
  assert.equal(harness.probeMessages().length, 3);

  harness.emitMainMessage("PROBE_URL", { mediaUrl: mediaUrl(3) });
  assert.equal(harness.probeMessages().length, 3);
});

test("tracking-only replaceState for the same video does not restart playback routing", async () => {
  const harness = await createHarness({
    pageUrl:
      "https://www.bilibili.com/video/BV1234567890?spm_id_from=old",
    sendMessage(message) {
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        routingTabId: 77
      });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startsBefore = harness.messages.filter(
    (message) => message.type === "START_PLAYBACK_SESSION"
  ).length;

  harness.emitMainMessage("NAVIGATION", {
    url:
      "https://www.bilibili.com/video/BV1234567890?spm_id_from=new&vd_source=x"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.messages.filter(
      (message) => message.type === "START_PLAYBACK_SESSION"
    ).length,
    startsBefore
  );

  harness.emitMainMessage("NAVIGATION", {
    url: "https://www.bilibili.com/video/BV1234567890?p=2"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.messages.filter(
      (message) => message.type === "START_PLAYBACK_SESSION"
    ).length,
    startsBefore + 1
  );
});

test("probe dedup is scoped to route and observed host", async () => {
  const harness = await createHarness();
  const route = {
    presentationId: "bvid-BV1",
    routeKey: "/path/video.m4s",
    kind: "video"
  };
  harness.emitMainMessage("PROBE_URL", {
    ...route,
    mediaUrl:
      "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?token=a"
  });
  harness.emitMainMessage("PROBE_URL", {
    ...route,
    mediaUrl:
      "https://upos-sz-upcdnbda2.bilivideo.com/path/video.m4s?token=b"
  });
  harness.emitMainMessage("PROBE_URL", {
    ...route,
    mediaUrl:
      "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?token=c"
  });

  assert.deepEqual(
    harness.probeMessages().map((message) => new URL(message.mediaUrl).hostname),
    [
      "upos-hz-mirrorakam.akamaized.net",
      "upos-sz-upcdnbda2.bilivideo.com"
    ]
  );
});

test("passive probe evidence is separately bounded, validated, and forwarded", async () => {
  const harness = await createHarness();
  const presentationId = "bvid-BV1234567890";
  const mediaUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/reference.m4s?token=1";
  const routeKey = "/path/reference.m4s";
  const reference = {
    mediaUrl,
    presentationId,
    kind: "video",
    routeKey,
    referenceHash: "ab".repeat(32),
    referenceStatus: 206,
    referenceBytes: 262_144
  };

  harness.emitMainMessage("PROBE_URL", {
    mediaUrl,
    presentationId,
    kind: "video",
    routeKey
  });
  harness.emitMainMessage("PROBE_REFERENCE", reference);
  harness.emitMainMessage("PROBE_REFERENCE", reference);

  const probes = harness.probeMessages();
  assert.equal(probes.length, 2);
  assert.equal(probes[1].observedReference, true);
  assert.equal(probes[1].referenceHash, "ab".repeat(32));
  assert.equal(probes[1].referenceStatus, 206);
  assert.equal(probes[1].referenceBytes, 262_144);

  harness.emitMainMessage("PROBE_REFERENCE", {
    ...reference,
    mediaUrl:
      "https://upos-hz-mirrorakam.akamaized.net/path/bad.m4s?token=2",
    routeKey: "/path/bad.m4s",
    referenceHash: "not-a-hash"
  });
  assert.equal(harness.probeMessages().length, 2);
});

test("media degradation never starts a competing recovery probe sweep", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        ruleCount: 2,
        escalated: message.type === "HOST_DEGRADED"
      });
    }
  });
  const videoUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?token=v";
  const alternateVideoUrl =
    "https://upos-sz-upcdnbda2.bilivideo.com/path/video.m4s?token=b";
  const audioUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/audio.m4s?token=a";
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId: "bvid-BV1",
        routeKey: "/path/video.m4s",
        kind: "video",
        urls: [videoUrl, alternateVideoUrl]
      },
      {
        presentationId: "bvid-BV1",
        routeKey: "/path/audio.m4s",
        kind: "audio",
        urls: [audioUrl]
      }
    ]
  });
  harness.emitMainMessage("PROBE_URL", {
    presentationId: "bvid-BV1",
    routeKey: "/path/audio.m4s",
    kind: "audio",
    mediaUrl: audioUrl
  });
  assert.equal(harness.probeMessages().length, 0);

  const degraded = {
    presentationId: "bvid-BV1",
    routeKey: "/path/video.m4s",
    kind: "video",
    host: "upos-hz-mirrorakam.akamaized.net",
    reason: "slow-body",
    throughputBps: 200_000,
    bufferAhead: 0
  };
  harness.emitMainMessage("MEDIA_DEGRADED", degraded);
  harness.emitMainMessage("MEDIA_DEGRADED", degraded);
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.probeMessages().length, 0);

  harness.emitMainMessage("MEDIA_DEGRADED", degraded);
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.probeMessages().length, 0);

  harness.emitMainMessage("MEDIA_DEGRADED", {
    ...degraded,
    host: "upos-sz-upcdnbda2.bilivideo.com"
  });
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.probeMessages().length, 0);
});

test("an underpowered recovery sweep persists exact-route bypass without a probe storm", async () => {
  const presentationId = "bvid-BV1234567890";
  const routeKey = "/path/sweep.m4s";
  const routeId = `${presentationId}::${routeKey}`;
  const mediaUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/sweep.m4s?token=1";
  const runtimeConfig = (sessionId) => ({
    playbackSessionId: sessionId,
    settings: {
      globalEnabled: true,
      acceleration: { enabled: true },
      diagnostics: { enabled: true },
      privacy: { cosmeticFiltering: false, urlCleaning: false }
    },
    cosmeticSelectors: [],
    compatibleRoutes: { [routeId]: [] }
  });
  let resolvePersistentBypass;
  const persistentBypass = new Promise((resolve) => {
    resolvePersistentBypass = resolve;
  });
  const harness = await createHarness({
    pageUrl: "https://www.bilibili.com/video/BV1234567890",
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          routingTabId: 7,
          config: runtimeConfig(message.sessionId)
        });
      }
      if (message.type === "PROBE_MEDIA") {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: runtimeConfig(message.sessionId),
          probeOutcome: {
            attemptedPoolCandidates: 2,
            qualifiedCandidates: 0,
            compatiblePoolCandidates: 2,
            underpoweredPoolCandidates: 2,
            candidatePoolSize: 8
          }
        });
      }
      if (message.type === "BYPASS_PLAYBACK_ROUTE") {
        if (message.persistent === true) {
          return persistentBypass;
        }
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          presentationId: message.presentationId,
          routeKey: message.routeKey,
          persistent: message.persistent === true,
          ruleCount: 1
        });
      }
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        ruleCount: 1,
        escalated: message.type === "HOST_DEGRADED",
        exhausted: message.type === "HOST_DEGRADED"
      });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId,
        routeKey,
        kind: "video",
        urls: [mediaUrl]
      }
    ]
  });
  const degraded = {
    presentationId,
    routeKey,
    kind: "video",
    host: "upos-hz-mirrorakam.akamaized.net",
    reason: "timeout",
    throughputBps: 0,
    bufferAhead: 0
  };
  harness.emitMainMessage("MEDIA_DEGRADED", degraded);
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(harness.probeMessages().length, 4);
  assert.equal(
    harness.mainMessages.some(
      (message) =>
        message.type === "ROUTE_NATIVE_BYPASS" &&
        message.payload.persistent === true
    ),
    false
  );
  const persistentRequest = harness.messages.find(
    (message) =>
      message.type === "BYPASS_PLAYBACK_ROUTE" &&
      message.persistent === true
  );
  resolvePersistentBypass({
    ok: true,
    sessionId: persistentRequest.sessionId,
    presentationId,
    routeKey,
    persistent: true,
    ruleCount: 0
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    harness.mainMessages.some(
      (message) =>
        message.type === "ROUTE_NATIVE_BYPASS" &&
        message.payload.presentationId === presentationId &&
        message.payload.routeKey === routeKey &&
        message.payload.persistent === true
    )
  );

  harness.emitMainMessage("MEDIA_DEGRADED", degraded);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.probeMessages().length, 4);
});

test("a rejected persistent bypass acknowledgement never leaves page state at Infinity", async (t) => {
  for (const failureMode of ["ok-false", "reject"]) {
    await t.test(failureMode, async () => {
      const presentationId = "bvid-BV1234567890";
      const routeKey = `/path/persistent-${failureMode}.m4s`;
      const routeId = `${presentationId}::${routeKey}`;
      const mediaUrl =
        `https://upos-hz-mirrorakam.akamaized.net${routeKey}?token=1`;
      const runtimeConfig = (sessionId) => ({
        playbackSessionId: sessionId,
        settings: {
          globalEnabled: true,
          acceleration: { enabled: true },
          diagnostics: { enabled: true },
          privacy: { cosmeticFiltering: false, urlCleaning: false }
        },
        cosmeticSelectors: [],
        compatibleRoutes: { [routeId]: [] }
      });
      const harness = await createHarness({
        pageUrl: "https://www.bilibili.com/video/BV1234567890",
        sendMessage(message) {
          if (
            message.type === "START_PLAYBACK_SESSION" ||
            message.type === "GET_RUNTIME_CONFIG"
          ) {
            return Promise.resolve({
              ok: true,
              sessionId: message.sessionId,
              routingTabId: 7,
              config: runtimeConfig(message.sessionId)
            });
          }
          if (message.type === "PROBE_MEDIA") {
            return Promise.resolve({
              ok: true,
              sessionId: message.sessionId,
              config: runtimeConfig(message.sessionId),
              probeOutcome: {
                attemptedPoolCandidates: 2,
                qualifiedCandidates: 0,
                compatiblePoolCandidates: 2,
                underpoweredPoolCandidates: 2,
                candidatePoolSize: 8
              }
            });
          }
          if (
            message.type === "BYPASS_PLAYBACK_ROUTE" &&
            message.persistent === true
          ) {
            return failureMode === "reject"
              ? Promise.reject(new Error("synthetic bypass rejection"))
              : Promise.resolve({
                  ok: false,
                  error: "synthetic bypass rejection"
                });
          }
          if (message.type === "BYPASS_PLAYBACK_ROUTE") {
            return Promise.resolve({
              ok: true,
              sessionId: message.sessionId,
              presentationId: message.presentationId,
              routeKey: message.routeKey,
              persistent: false,
              ruleCount: 0
            });
          }
          return Promise.resolve({
            ok: true,
            sessionId: message.sessionId,
            escalated: message.type === "HOST_DEGRADED",
            exhausted: message.type === "HOST_DEGRADED"
          });
        }
      });
      await new Promise((resolve) => setImmediate(resolve));
      harness.emitMainMessage("ROUTE_MANIFEST", {
        routes: [
          {
            presentationId,
            routeKey,
            kind: "video",
            urls: [mediaUrl]
          }
        ]
      });
      const degraded = {
        presentationId,
        routeKey,
        kind: "video",
        host: "upos-hz-mirrorakam.akamaized.net",
        reason: "timeout",
        throughputBps: 0,
        bufferAhead: 0
      };
      harness.emitMainMessage("MEDIA_DEGRADED", degraded);
      for (let index = 0; index < 7; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      assert.equal(harness.probeMessages().length, 4);
      assert.equal(
        harness.messages.filter(
          (message) =>
            message.type === "BYPASS_PLAYBACK_ROUTE" &&
            message.persistent === true
        ).length,
        1
      );
      assert.equal(
        harness.mainMessages.some(
          (message) =>
            message.type === "ROUTE_NATIVE_BYPASS" &&
            message.payload.persistent === true
        ),
        false
      );
      const finiteBypasses = harness.mainMessages.filter(
        (message) =>
          message.type === "ROUTE_NATIVE_BYPASS" &&
          message.payload.routeKey === routeKey &&
          Object.hasOwn(message.payload, "until")
      );
      assert.ok(finiteBypasses.length >= 1);
      assert.ok(
        finiteBypasses.every((message) =>
          Number.isFinite(message.payload.until)
        )
      );

      harness.emitMainMessage("MEDIA_DEGRADED", degraded);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(harness.probeMessages().length, 4);
    });
  }
});

test("a recovery byte-budget rejection defers one route retry without declaring the pool exhausted", async () => {
  const presentationId = "bvid-BV1234567890";
  const routeKey = "/path/budget-deferred-sweep.m4s";
  const routeId = `${presentationId}::${routeKey}`;
  const mediaUrl =
    `https://upos-hz-mirrorakam.akamaized.net${routeKey}?token=1`;
  const scheduledRetries = [];
  let probeAttempts = 0;
  const runtimeConfig = (sessionId) => ({
    playbackSessionId: sessionId,
    settings: {
      globalEnabled: true,
      acceleration: { enabled: true },
      diagnostics: { enabled: true },
      privacy: { cosmeticFiltering: false, urlCleaning: false }
    },
    cosmeticSelectors: [],
    compatibleRoutes: { [routeId]: [] }
  });
  const harness = await createHarness({
    pageUrl: "https://www.bilibili.com/video/BV1234567890",
    setTimeout(callback, delay) {
      if (delay === 1000) {
        queueMicrotask(callback);
      } else if (delay === 30_000) {
        scheduledRetries.push(callback);
      }
      return scheduledRetries.length + 1;
    },
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          routingTabId: 7,
          config: runtimeConfig(message.sessionId)
        });
      }
      if (message.type === "PROBE_MEDIA") {
        probeAttempts += 1;
        if (probeAttempts === 3) {
          return Promise.resolve({
            ok: false,
            error: "Probe byte budget exceeded"
          });
        }
        const coveredPoolCandidates =
          probeAttempts === 1 ? 4 : probeAttempts === 2 ? 6 : 8;
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: runtimeConfig(message.sessionId),
          probeOutcome: {
            attemptedPoolCandidates: 2,
            qualifiedCandidates: 0,
            compatiblePoolCandidates: 2,
            underpoweredPoolCandidates: 2,
            underpoweredPoolSeen: true,
            coveredPoolCandidates,
            candidatePoolSize: 8,
            poolExhausted: coveredPoolCandidates === 8
          }
        });
      }
      if (message.type === "BYPASS_PLAYBACK_ROUTE") {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          presentationId: message.presentationId,
          routeKey: message.routeKey,
          persistent: message.persistent === true,
          ruleCount: 0
        });
      }
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        escalated: message.type === "HOST_DEGRADED",
        exhausted: message.type === "HOST_DEGRADED"
      });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId,
        routeKey,
        kind: "video",
        urls: [mediaUrl]
      }
    ]
  });
  const degraded = {
    presentationId,
    routeKey,
    kind: "video",
    host: "upos-hz-mirrorakam.akamaized.net",
    reason: "timeout",
    throughputBps: 0,
    bufferAhead: 0
  };
  harness.emitMainMessage("MEDIA_DEGRADED", degraded);
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(probeAttempts, 3);
  assert.equal(scheduledRetries.length, 1);
  assert.equal(
    harness.messages.some(
      (message) =>
        message.type === "BYPASS_PLAYBACK_ROUTE" &&
        message.persistent === true
    ),
    false
  );
  harness.emitMainMessage("MEDIA_DEGRADED", degraded);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeAttempts, 3);

  scheduledRetries.shift()();
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(probeAttempts, 4);
  assert.equal(
    harness.messages.filter(
      (message) =>
        message.type === "BYPASS_PLAYBACK_ROUTE" &&
        message.persistent === true
    ).length,
    1
  );
  assert.ok(
    harness.mainMessages.some(
      (message) =>
        message.type === "ROUTE_NATIVE_BYPASS" &&
        message.payload.persistent === true
    )
  );
});

test("a non-escalating slow-body window does not start recovery probing", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        ruleCount: 0,
        escalated: false
      });
    }
  });
  const mediaUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/soft.m4s?token=1";
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId: "bvid-BV1",
        routeKey: "/path/soft.m4s",
        kind: "video",
        urls: [mediaUrl]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_DEGRADED", {
    presentationId: "bvid-BV1",
    routeKey: "/path/soft.m4s",
    kind: "video",
    host: "upos-hz-mirrorakam.akamaized.net",
    reason: "slow-body",
    throughputBps: 1_000_000,
    bufferAhead: 0
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.probeMessages().length, 0);
});

test("a delayed degradation response cannot start a recovery probe in the next SPA session", async () => {
  let resolveDegradation;
  const degradationResponse = new Promise((resolve) => {
    resolveDegradation = resolve;
  });
  const harness = await createHarness({
    sendMessage(message) {
      if (message.type === "HOST_DEGRADED") {
        return degradationResponse;
      }
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        ruleCount: 1
      });
    }
  });
  const mediaUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?token=v";
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId: "bvid-BV1",
        routeKey: "/path/video.m4s",
        kind: "video",
        urls: [mediaUrl]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_DEGRADED", {
    presentationId: "bvid-BV1",
    routeKey: "/path/video.m4s",
    kind: "video",
    host: "upos-hz-mirrorakam.akamaized.net",
    reason: "body-stalled",
    throughputBps: 0,
    bufferAhead: 0
  });
  harness.emitMainMessage("NAVIGATION", {
    url: "https://www.bilibili.com/video/BV1?p=2"
  });
  resolveDegradation({
    ok: true,
    ruleCount: 1
  });
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.probeMessages().length, 0);
});

test("autoplay SPA session re-registers only routes matching the destination BVID", async () => {
  const nextBvid = "BVABCDEFGHIJ";
  const harness = await createHarness({
    pageUrl: "https://www.bilibili.com/video/BV1234567890",
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          routingTabId: 7,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        ruleCount: message.routes?.length ?? 0
      });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId: "bvid-BV1234567890",
        routeKey: "/path/old.m4s",
        kind: "video",
        urls: [
          "https://upos-hz-mirrorakam.akamaized.net/path/old.m4s?token=old"
        ]
      },
      {
        presentationId: `bvid-${nextBvid}:cid-42`,
        routeKey: "/path/next.m4s",
        kind: "video",
        urls: [
          "https://upos-hz-mirrorakam.akamaized.net/path/next.m4s?token=next"
        ]
      }
    ]
  });
  await new Promise((resolve) => setImmediate(resolve));
  const beforeNavigation = harness.messages.filter(
    (message) => message.type === "REGISTER_MEDIA_ROUTES"
  ).length;

  harness.emitMainMessage("NAVIGATION", {
    url: `https://www.bilibili.com/video/${nextBvid}`
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const registrations = harness.messages.filter(
    (message) => message.type === "REGISTER_MEDIA_ROUTES"
  );
  assert.ok(registrations.length > beforeNavigation);
  assert.deepEqual(
    registrations.at(-1).routes.map((route) => route.presentationId),
    [`bvid-${nextBvid}:cid-42`]
  );
});

test("PGC autoplay retention matches ep_id and season_id components in the isolated bridge", async () => {
  const runtimeReply = (message) => {
    if (
      message.type === "START_PLAYBACK_SESSION" ||
      message.type === "GET_RUNTIME_CONFIG"
    ) {
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        routingTabId: 7,
        config: {
          playbackSessionId: message.sessionId,
          settings: {
            globalEnabled: true,
            diagnostics: { enabled: true },
            privacy: { cosmeticFiltering: false, urlCleaning: false }
          },
          cosmeticSelectors: []
        }
      });
    }
    return Promise.resolve({
      ok: true,
      sessionId: message.sessionId,
      ruleCount: message.routes?.length ?? 0
    });
  };
  const route = (presentationId, name) => ({
    presentationId,
    routeKey: `/path/${name}.m4s`,
    kind: "video",
    urls: [
      `https://upos-hz-mirrorakam.akamaized.net/path/${name}.m4s?token=${name}`
    ]
  });

  const episodeHarness = await createHarness({
    pageUrl: "https://www.bilibili.com/bangumi/play/ep0",
    sendMessage: runtimeReply
  });
  await new Promise((resolve) => setImmediate(resolve));
  const nextPresentation = "cid-2:ep_id-1:avid-3:season_id-1";
  episodeHarness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      route(nextPresentation, "next"),
      route("cid-5:ep_id-2:avid-6:season_id-1", "wrong")
    ]
  });
  await new Promise((resolve) => setImmediate(resolve));
  episodeHarness.emitMainMessage("NAVIGATION", {
    url: "https://www.bilibili.com/bangumi/play/ep1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const episodeRegistrations = episodeHarness.messages.filter(
    (message) => message.type === "REGISTER_MEDIA_ROUTES"
  );
  assert.deepEqual(
    episodeRegistrations.at(-1).routes.map((item) => item.presentationId),
    [nextPresentation]
  );

  const seasonHarness = await createHarness({
    pageUrl: "https://www.bilibili.com/bangumi/play/ss0",
    sendMessage: runtimeReply
  });
  await new Promise((resolve) => setImmediate(resolve));
  const seasonPresentation = "cid-2:ep_id-1:avid-3:season_id-1";
  seasonHarness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      route(seasonPresentation, "season"),
      route("cid-5:ep_id-2:avid-6:season_id-2", "wrong-season")
    ]
  });
  await new Promise((resolve) => setImmediate(resolve));
  seasonHarness.emitMainMessage("NAVIGATION", {
    url: "https://www.bilibili.com/bangumi/play/ss1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const seasonRegistrations = seasonHarness.messages.filter(
    (message) => message.type === "REGISTER_MEDIA_ROUTES"
  );
  assert.deepEqual(
    seasonRegistrations.at(-1).routes.map((item) => item.presentationId),
    [seasonPresentation]
  );
});

test("delayed probe results cannot cross an SPA playback-session boundary", async () => {
  const pending = [];
  const harness = await createHarness({
    sendMessage(message) {
      if (message.type === "PROBE_MEDIA") {
        return new Promise((resolve) => pending.push({ message, resolve }));
      }
      return Promise.resolve({ ok: false });
    }
  });
  harness.emitMainMessage("ACK");
  harness.emitMainMessage("PROBE_URL", {
    mediaUrl:
      "https://upos-sz-mirrorcos.bilivideo.com/path/old.m4s?token=old"
  });
  const oldSessionId = pending[0].message.sessionId;
  harness.emitMainMessage("NAVIGATION", {
    url: "https://www.bilibili.com/video/BV2"
  });
  harness.emitMainMessage("PROBE_URL", {
    mediaUrl:
      "https://upos-sz-mirrorcos.bilivideo.com/path/new.m4s?token=new"
  });
  const newSessionId = pending[1].message.sessionId;
  assert.notEqual(newSessionId, oldSessionId);

  pending[0].resolve({
    ok: true,
    sessionId: oldSessionId,
    config: {
      playbackSessionId: oldSessionId,
      settings: {
        globalEnabled: true,
        privacy: { cosmeticFiltering: false, urlCleaning: false }
      }
    }
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    harness.mainMessages.some((message) => message.type === "CONFIG"),
    false
  );

  pending[1].resolve({
    ok: true,
    sessionId: newSessionId,
    config: {
      playbackSessionId: newSessionId,
      settings: {
        globalEnabled: true,
        privacy: { cosmeticFiltering: false, urlCleaning: false }
      },
      cosmeticSelectors: []
    }
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    harness.mainMessages.filter((message) => message.type === "CONFIG").length,
    1
  );
});

test("one hundred consecutive video navigations keep independent probe identities", async () => {
  const harness = await createHarness();
  for (let index = 0; index < 100; index += 1) {
    harness.emitMainMessage("NAVIGATION", {
      url: `https://www.bilibili.com/video/BV${index}`
    });
    harness.emitMainMessage("PROBE_URL", {
      mediaUrl:
        `https://upos-sz-mirrorcos.bilivideo.com/path/video-${index}.mp4` +
        `?token=${index}`
    });
  }
  const probes = harness.probeMessages();
  assert.equal(probes.length, 100);
  assert.equal(new Set(probes.map((message) => message.sessionId)).size, 100);
});

test("events from an old video element cannot contaminate the next session", async () => {
  const harness = await createHarness({ withVideo: true });
  harness.emitMainMessage("NAVIGATION", {
    url: "https://www.bilibili.com/video/BV2"
  });
  harness.emitMainMessage("MEDIA_HOST", {
    host: "upos-sz-mirrorcos.bilivideo.com",
    routeKey: "/path/video.m4s"
  });
  harness.video.dispatchEvent(new Event("waiting"));
  assert.equal(
    harness.messages.filter((message) => message.type === "PLAYBACK_RISK").length,
    0
  );

  harness.video.dispatchEvent(new Event("loadstart"));
  harness.video.dispatchEvent(new Event("waiting"));
  assert.equal(
    harness.messages.filter((message) => message.type === "PLAYBACK_RISK").length,
    0
  );
});

test("an ambiguous player risk stays diagnostic-only and degrades no route", async () => {
  let riskCallback;
  const harness = await createHarness({
    withVideo: true,
    videoSources: [
      "https://upos-sz-mirrorcos.bilivideo.com/path/unknown.m4s?token=x"
    ],
    setTimeout(callback, delay) {
      if (delay === 1000) {
        queueMicrotask(callback);
      } else if (delay === 2500) {
        riskCallback = callback;
      }
      return 1;
    },
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId: "presentation-a",
        routeKey: "/path/a.m4s",
        kind: "video",
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/a.m4s?token=a"
        ]
      },
      {
        presentationId: "presentation-b",
        routeKey: "/path/b.m4s",
        kind: "video",
        urls: [
          "https://upos-hz-mirrorakam.akamaized.net/path/b.m4s?token=b"
        ]
      }
    ]
  });
  harness.video.dispatchEvent(new Event("loadstart"));
  harness.video.dispatchEvent(new Event("waiting"));
  riskCallback();
  assert.equal(
    harness.messages.some((message) => message.type === "PLAYBACK_RISK"),
    false
  );
  await Promise.resolve();
  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  assert.ok(
    latest.ordinaryEvents.some(
      (event) => event.type === "playback-risk-unassigned"
    )
  );
});

test("an observed media URL inherits its unique registered route identity", async () => {
  const presentationId = "bvid-BV1234567890";
  const harness = await createHarness({
    pageUrl: "https://www.bilibili.com/video/BV1234567890",
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId,
        routeKey: "/path/selected-abr.m4s",
        kind: "video",
        urls: [
          "https://upos-hz-mirrorakam.akamaized.net/path/selected-abr.m4s?token=registered"
        ]
      }
    ]
  });
  harness.emitMainMessage("PROBE_URL", {
    mediaUrl:
      "https://upos-hz-mirrorakam.akamaized.net/path/selected-abr.m4s?token=observed"
  });

  const probe = harness.probeMessages().at(-1);
  assert.equal(probe.presentationId, presentationId);
  assert.equal(probe.kind, "video");
  assert.equal(probe.routeKey, "/path/selected-abr.m4s");
});

test("a single MSE player attributes waiting to the latest observed page video route", async () => {
  const presentationId = "bvid-BV1234567890";
  let riskCallback;
  const harness = await createHarness({
    withVideo: true,
    pageUrl: "https://www.bilibili.com/video/BV1234567890",
    videoSources: ["blob:https://www.bilibili.com/player-buffer"],
    setTimeout(callback, delay) {
      if (delay === 1000) {
        queueMicrotask(callback);
      } else if (delay === 2500) {
        riskCallback = callback;
      }
      return 1;
    },
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        escalated: false
      });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId,
        routeKey: "/path/selected-video.m4s",
        kind: "video",
        urls: [
          "https://upos-hz-mirrorakam.akamaized.net/path/selected-video.m4s?token=video"
        ]
      },
      {
        presentationId,
        routeKey: "/path/selected-audio.m4s",
        kind: "audio",
        urls: [
          "https://upos-hz-mirrorakam.akamaized.net/path/selected-audio.m4s?token=audio"
        ]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_HOST", {
    presentationId,
    routeKey: "/path/selected-video.m4s",
    kind: "video",
    host: "upos-hz-mirrorakam.akamaized.net"
  });
  harness.video.dispatchEvent(new Event("loadstart"));
  harness.video.dispatchEvent(new Event("waiting"));
  harness.video.dispatchEvent(new Event("waiting"));

  assert.equal(
    harness.messages.filter(
      (message) => message.type === "PLAYBACK_RISK"
    ).length,
    0
  );
  riskCallback();
  const risks = harness.messages.filter(
    (message) => message.type === "PLAYBACK_RISK"
  );
  assert.equal(risks.length, 1);
  assert.ok(
    risks.every(
      (message) =>
        message.presentationId === presentationId &&
        message.routeKey === "/path/selected-video.m4s" &&
        message.host === "upos-hz-mirrorakam.akamaized.net"
    )
  );
  await Promise.resolve();
  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  assert.equal(
    latest.playerDetails["player-1"].presentationId,
    presentationId
  );
  assert.equal(
    latest.playerDetails["player-1"].routeKey,
    "/path/selected-video.m4s"
  );
  assert.ok(
    latest.ordinaryEvents.some(
      (event) => event.type === "player-route-inferred"
    )
  );
});

test("diagnostics retain the first planned route separately from the actual host", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        routeKey: "/path/video.m4s",
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?token=base"
        ]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_REWRITE", {
    host: "upos-hz-mirrorakam.akamaized.net",
    streams: 1
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    host: "upos-hz-mirrorakam.akamaized.net",
    routeKey: "/path/video.m4s",
    status: 206,
    bytes: 1,
    throughputBps: 2_000_000
  });
  harness.emitMainMessage("FALLBACK", {
    host: "upos-hz-mirrorakam.akamaized.net"
  });
  await Promise.resolve();

  const diagnostics = harness.messages.filter(
    (message) => message.type === "RECORD_DIAGNOSTIC"
  );
  const latest = diagnostics.at(-1)?.session;
  assert.equal(
    latest.plannedMediaHost,
    "upos-sz-mirrorcos.bilivideo.com"
  );
  assert.equal(
    latest.mediaHost,
    "upos-hz-mirrorakam.akamaized.net"
  );
});

test("diagnostics retain partial Range size and tail-stall telemetry", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const route = {
    presentationId: "bvid-BVRANGE",
    routeKey: "/path/large-video.m4s",
    kind: "video"
  };
  harness.emitMainMessage("MEDIA_REQUEST_CANCELLED", {
    ...route,
    host: "upos-hz-mirrorakam.akamaized.net",
    reason: "xhr-abort",
    bytes: 11_000_000,
    expectedBytes: 19_000_000,
    durationMs: 12_500,
    progressAgeMs: 2_300,
    responseRange: "bytes 0-18999999/80000000"
  });
  await Promise.resolve();

  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  const detail = latest.routeDetails[
    "bvid-BVRANGE::/path/large-video.m4s"
  ];
  assert.equal(detail.lastBytes, 11_000_000);
  assert.equal(detail.lastExpectedBytes, 19_000_000);
  assert.equal(detail.lastDurationMs, 12_500);
  assert.equal(detail.lastProgressAgeMs, 2_300);
  assert.equal(detail.lastResponseRange, "bytes 0-18999999/80000000");
  assert.match(
    latest.ordinaryEvents.at(-1).detail,
    /bytes 11000000\/19000000.*idle 2300ms.*range bytes 0-18999999/
  );
});

test("DASH audio and video hosts do not inflate each other's route switch count", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId: "BV1:cid-1",
        routeKey: "/path/video.m4s",
        kind: "video",
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?token=v"
        ]
      },
      {
        presentationId: "BV1:cid-1",
        routeKey: "/path/audio.m4s",
        kind: "audio",
        urls: [
          "https://upos-hz-mirrorakam.akamaized.net/path/audio.m4s?token=a"
        ]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    presentationId: "BV1:cid-1",
    routeKey: "/path/video.m4s",
    kind: "video",
    host: "upos-sz-mirrorcos.bilivideo.com",
    status: 206
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    presentationId: "BV1:cid-1",
    routeKey: "/path/audio.m4s",
    kind: "audio",
    host: "upos-hz-mirrorakam.akamaized.net",
    status: 206
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    presentationId: "BV1:cid-1",
    routeKey: "/path/video.m4s",
    kind: "video",
    host: "upos-sz-mirrorcos.bilivideo.com",
    status: 206
  });
  await Promise.resolve();

  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  assert.equal(latest.routeSwitchCount, 0);
  assert.equal(Object.keys(latest.routeDetails).length, 2);
  assert.deepEqual(
    Object.values(latest.routeDetails).map((route) => route.kind).sort(),
    ["audio", "video"]
  );
});

test("a route switch needs two healthy segments and buffer progress to recover", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        recovered: message.type === "HOST_RECOVERED"
      });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const route = {
    presentationId: "BV1:cid-1",
    routeKey: "/path/video.m4s",
    kind: "video"
  };
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        ...route,
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?token=a",
          "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?token=b"
        ]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-sz-mirrorcos.bilivideo.com",
    status: 206,
    bytes: 262144,
    bufferAhead: 0
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-hz-mirrorakam.akamaized.net",
    status: 206,
    bytes: 262144,
    bufferAhead: 0
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-hz-mirrorakam.akamaized.net",
    status: 206,
    bytes: 262144,
    bufferAhead: 2
  });
  for (let index = 0; index < 10_000; index += 1) {
    harness.emitMainMessage("BEACON_BLOCKED", {
      url:
        "https://data.bilibili.com/log/web?event=play&token=" +
        index
    });
  }
  await new Promise((resolve) => setImmediate(resolve));

  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  const detail = Object.values(latest.routeDetails)[0];
  assert.equal(detail.routeSwitchCount, 1);
  assert.equal(detail.recoveryHealthySegments, 2);
  assert.equal(detail.recoveryStatus, "recovered");
  const recovered = harness.messages.find(
    (message) => message.type === "HOST_RECOVERED"
  );
  assert.equal(recovered.presentationId, route.presentationId);
  assert.equal(recovered.routeKey, route.routeKey);
  assert.equal(recovered.host, "upos-hz-mirrorakam.akamaized.net");
  assert.equal(recovered.healthySegments, 2);
  assert.equal(latest.blockedBeaconCount, 10_000);
  assert.equal(
    latest.beaconAggregates["data.bilibili.com/log/web"].count,
    10_000
  );
  assert.ok(latest.criticalEvents.length <= 64);
  assert.ok(latest.ordinaryEvents.length <= 32);
  assert.ok(
    latest.criticalEvents.some((event) => event.type === "route-switch")
  );
  assert.ok(
    latest.criticalEvents.some((event) => event.type === "route-recovered")
  );
  assert.equal(
    latest.criticalEvents.some((event) => event.type === "beacon-blocked"),
    false
  );
});

test("a static blocked host cannot be reported recovered before policy confirmation", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: { cosmeticFiltering: false, urlCleaning: false }
            },
            cosmeticSelectors: []
          }
        });
      }
      if (message.type === "HOST_RECOVERED") {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          recovered: false,
          circuit: "static-open"
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const route = {
    presentationId: "bvid-BVSTATIC:cid-1",
    routeKey: "/path/static.m4s",
    kind: "video"
  };
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        ...route,
        urls: [
          "https://upos-hz-mirrorakam.akamaized.net/path/static.m4s?safe=1",
          "https://upos-sz-mirroraliov.bilivideo.com/path/static.m4s?native=1"
        ]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-hz-mirrorakam.akamaized.net",
    status: 206,
    bytes: 262144,
    bufferAhead: 0
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-sz-mirroraliov.bilivideo.com",
    status: 206,
    bytes: 262144,
    bufferAhead: 0
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-sz-mirroraliov.bilivideo.com",
    status: 206,
    bytes: 262144,
    bufferAhead: 2
  });
  await new Promise((resolve) => setImmediate(resolve));

  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  const detail = Object.values(latest.routeDetails)[0];
  assert.equal(detail.recoveryStatus, "static-open");
  assert.equal(
    latest.criticalEvents.some(
      (event) =>
        event.type === "route-recovered" &&
        event.host === "upos-sz-mirroraliov.bilivideo.com"
    ),
    false
  );
  assert.ok(
    latest.criticalEvents.some(
      (event) =>
        event.type === "route-recovery-failed" &&
        /static blocked host cannot recover/.test(event.detail)
    )
  );
});

test("byte-zero fetch headers cannot prove a route switch or recovery", async () => {
  let recoveryCallback;
  const harness = await createHarness({
    setTimeout(callback, delay) {
      if (delay === 1000) {
        queueMicrotask(callback);
      } else if (delay === 5000) {
        recoveryCallback = callback;
      }
      return 1;
    },
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: { cosmeticFiltering: false, urlCleaning: false }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        recovered: message.type === "HOST_RECOVERED"
      });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const route = {
    presentationId: "bvid-BVFETCHONLY1:cid-1",
    routeKey: "/path/fetch-only.m4s",
    kind: "video"
  };
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        ...route,
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/fetch-only.m4s?a=1",
          "https://upos-hz-mirrorakam.akamaized.net/path/fetch-only.m4s?b=2"
        ]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-sz-mirrorcos.bilivideo.com",
    status: 206,
    bytes: 0,
    bufferAhead: 0,
    origin: "fetch"
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-hz-mirrorakam.akamaized.net",
    status: 206,
    bytes: 0,
    bufferAhead: 0,
    origin: "fetch"
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-hz-mirrorakam.akamaized.net",
    status: 206,
    bytes: 0,
    bufferAhead: 2,
    origin: "fetch"
  });
  recoveryCallback?.();
  await Promise.resolve();
  assert.equal(
    harness.messages.some(
      (message) =>
        message.type === "HOST_DEGRADED" &&
        message.reason === "recovery-timeout"
    ),
    false
  );
  assert.equal(
    harness.messages.some(
      (message) => message.type === "HOST_RECOVERED"
    ),
    false
  );
});

test("service-worker routing push replaces MAIN authorization without display-only hosts", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId
      });
    }
  });
  await Promise.resolve();
  harness.emitMainMessage("ACK");
  const sessionId = harness.messages.find(
    (message) => message.type === "START_PLAYBACK_SESSION"
  ).sessionId;
  harness.dispatchRuntimeMessage({
    type: "ROUTING_CONFIG_UPDATED",
    sessionId,
    reason: "circuit-half-open",
    config: {
      playbackSessionId: sessionId,
      settings: {
        globalEnabled: true,
        diagnostics: { enabled: true },
        privacy: {
          cosmeticFiltering: false,
          urlCleaning: false
        }
      },
      cosmeticSelectors: [],
      selectedHost: "display-only.bilivideo.com",
      healthyHosts: ["display-only.bilivideo.com"],
      halfOpenRoutes: {
        "presentation::/path/video.m4s": [
          "upos-sz-mirrorcos.bilivideo.com"
        ]
      }
    }
  });
  const pageConfig = harness.mainMessages
    .filter((message) => message.type === "CONFIG")
    .at(-1)?.payload;
  assert.equal(pageConfig.selectedHost, undefined);
  assert.equal(pageConfig.healthyHosts, undefined);
  assert.deepEqual(pageConfig.halfOpenRoutes, {
    "presentation::/path/video.m4s": [
      "upos-sz-mirrorcos.bilivideo.com"
    ]
  });
});

test("paused or hidden playback defers the recovery deadline instead of degrading", async () => {
  const recoveryCallbacks = [];
  const harness = await createHarness({
    withVideo: true,
    videoSources: [
      "https://upos-sz-mirrorcos.bilivideo.com/path/pause.m4s?token=a"
    ],
    setTimeout(callback, delay) {
      if (delay === 1000) {
        queueMicrotask(callback);
      } else if (delay === 5000) {
        recoveryCallbacks.push(callback);
      }
      return recoveryCallbacks.length + 1;
    },
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: { cosmeticFiltering: false, urlCleaning: false }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        recovered: message.type === "HOST_RECOVERED"
      });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const route = {
    presentationId: "bvid-BVPAUSED001:cid-1",
    routeKey: "/path/pause.m4s",
    kind: "video"
  };
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        ...route,
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/pause.m4s?token=a",
          "https://upos-hz-mirrorakam.akamaized.net/path/pause.m4s?token=b"
        ]
      }
    ]
  });
  harness.video.dispatchEvent(new Event("loadstart"));
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-sz-mirrorcos.bilivideo.com",
    status: 206,
    bytes: 1,
    bufferAhead: 0
  });
  harness.video.paused = true;
  harness.video.dispatchEvent(new Event("timeupdate"));
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-hz-mirrorakam.akamaized.net",
    status: 206,
    bytes: 1,
    bufferAhead: 0
  });
  assert.equal(recoveryCallbacks.length, 1);
  recoveryCallbacks[0]();
  assert.equal(recoveryCallbacks.length, 2);
  assert.equal(
    harness.messages.some(
      (message) =>
        message.type === "HOST_DEGRADED" &&
        message.reason === "recovery-timeout"
    ),
    false
  );

  harness.video.paused = false;
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-hz-mirrorakam.akamaized.net",
    status: 206,
    bytes: 1,
    bufferAhead: 2
  });
  assert.ok(
    harness.messages.some((message) => message.type === "HOST_RECOVERED")
  );
});

test("recovery silence stays unconfirmed instead of degrading after five seconds", async () => {
  let recoveryCallback;
  const harness = await createHarness({
    setTimeout(callback, delay) {
      if (delay === 1000) {
        queueMicrotask(callback);
      } else if (delay === 5000) {
        recoveryCallback = callback;
      }
      return 1;
    },
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const route = {
    presentationId: "BV-timeout:cid-1",
    routeKey: "/path/timeout.m4s",
    kind: "video"
  };
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        ...route,
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/timeout.m4s?token=a",
          "https://upos-hz-mirrorakam.akamaized.net/path/timeout.m4s?token=b"
        ]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-sz-mirrorcos.bilivideo.com",
    status: 206,
    bytes: 262144,
    bufferAhead: 0
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-hz-mirrorakam.akamaized.net",
    status: 206,
    bytes: 262144,
    bufferAhead: 0
  });
  assert.equal(typeof recoveryCallback, "function");
  recoveryCallback();
  await Promise.resolve();

  assert.equal(
    harness.messages.some(
      (message) =>
        message.type === "HOST_DEGRADED" &&
        message.reason === "recovery-timeout"
    ),
    false
  );
  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  assert.equal(
    Object.values(latest.routeDetails)[0].recoveryStatus,
    "awaiting-evidence"
  );
});

test("two video elements retain independent waiting and playback-risk attribution", async () => {
  const riskCallbacks = [];
  const harness = await createHarness({
    videoCount: 2,
    videoSources: [
      "https://upos-sz-mirrorcos.bilivideo.com/path/player-a.m4s?token=a",
      "https://upos-hz-mirrorakam.akamaized.net/path/player-b.m4s?token=b"
    ],
    setTimeout(callback, delay) {
      if (delay === 1000) {
        queueMicrotask(callback);
      } else if (delay === 2500) {
        riskCallbacks.push(callback);
      }
      return riskCallbacks.length + 1;
    },
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId: "presentation-a",
        routeKey: "/path/player-a.m4s",
        kind: "video",
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/player-a.m4s?token=a"
        ]
      },
      {
        presentationId: "presentation-b",
        routeKey: "/path/player-b.m4s",
        kind: "video",
        urls: [
          "https://upos-hz-mirrorakam.akamaized.net/path/player-b.m4s?token=b"
        ]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_HOST", {
    presentationId: "presentation-a",
    routeKey: "/path/player-a.m4s",
    kind: "video",
    host: "upos-sz-mirrorcos.bilivideo.com"
  });
  harness.emitMainMessage("MEDIA_HOST", {
    presentationId: "presentation-b",
    routeKey: "/path/player-b.m4s",
    kind: "video",
    host: "upos-hz-mirrorakam.akamaized.net"
  });

  for (const video of harness.videos) {
    video.dispatchEvent(new Event("loadstart"));
    video.dispatchEvent(new Event("waiting"));
  }
  riskCallbacks.forEach((callback) => callback());

  const risks = harness.messages.filter(
    (message) => message.type === "PLAYBACK_RISK"
  );
  assert.equal(risks.length, 2);
  assert.deepEqual(
    risks.map((message) => ({
      presentationId: message.presentationId,
      routeKey: message.routeKey,
      host: message.host
    })),
    [
      {
        presentationId: "presentation-a",
        routeKey: "/path/player-a.m4s",
        host: "upos-sz-mirrorcos.bilivideo.com"
      },
      {
        presentationId: "presentation-b",
        routeKey: "/path/player-b.m4s",
        host: "upos-hz-mirrorakam.akamaized.net"
      }
    ]
  );
  await Promise.resolve();
  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  assert.equal(Object.keys(latest.playerDetails).length, 2);
  assert.deepEqual(
    Object.values(latest.playerDetails).map((player) => player.waitingCount),
    [1, 1]
  );
});

test("repeated loadstart keeps the main player identity and active-player quota", async () => {
  let riskCallback;
  const harness = await createHarness({
    videoCount: 3,
    videoSources: Array(3).fill(
      "https://upos-sz-mirrorcos.bilivideo.com/path/player.m4s?token=active"
    ),
    setTimeout(callback, delay) {
      if (delay === 1000) {
        queueMicrotask(callback);
      } else if (delay === 2500) {
        riskCallback = callback;
      }
      return 1;
    },
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId: "presentation-main",
        routeKey: "/path/player.m4s",
        kind: "video",
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/player.m4s?token=active"
        ]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_HOST", {
    presentationId: "presentation-main",
    routeKey: "/path/player.m4s",
    kind: "video",
    host: "upos-sz-mirrorcos.bilivideo.com"
  });

  for (let index = 0; index < 6; index += 1) {
    harness.videos[0].dispatchEvent(new Event("loadstart"));
  }
  harness.videos[1].dispatchEvent(new Event("loadstart"));
  harness.videos[2].dispatchEvent(new Event("loadstart"));
  harness.videos[0].dispatchEvent(new Event("waiting"));
  riskCallback();
  await Promise.resolve();

  const risks = harness.messages.filter(
    (message) => message.type === "PLAYBACK_RISK"
  );
  assert.equal(risks.length, 1);
  assert.equal(risks[0].routeKey, "/path/player.m4s");
  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  assert.deepEqual(
    Object.keys(latest.playerDetails).sort(),
    ["player-1", "player-2", "player-3"]
  );
  assert.equal(latest.playerDetails["player-1"].waitingCount, 1);
});

test("BFCache restore re-announces the same document session and re-registers routes", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId: "BV1:cid-1",
        routeKey: "/path/video.m4s",
        kind: "video",
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?token=v"
        ]
      }
    ]
  });
  await Promise.resolve();
  const startsBefore = harness.messages.filter(
    (message) => message.type === "START_PLAYBACK_SESSION"
  );
  const original = startsBefore.at(-1);

  harness.dispatchPageShow(true);
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  const startsAfter = harness.messages.filter(
    (message) => message.type === "START_PLAYBACK_SESSION"
  );
  assert.ok(startsAfter.length > startsBefore.length);
  assert.equal(startsAfter.at(-1).sessionId, original.sessionId);
  assert.ok(
    startsAfter.at(-1).documentStartedAt > original.documentStartedAt
  );
  assert.equal(startsAfter.at(-1).restoredFromBfcache, true);
  assert.ok(
    harness.messages.some(
      (message) =>
        message.type === "REGISTER_MEDIA_ROUTES" &&
        message.sessionId === original.sessionId
    )
  );
});

test("a hidden paused tab releases routing state and rebuilds it on foreground resume", async () => {
  const lifecycleCallbacks = [];
  const harness = await createHarness({
    pageUrl: "https://www.bilibili.com/video/BV1234567890",
    withVideo: true,
    setTimeout(callback, delay) {
      if (delay === 1000) {
        queueMicrotask(callback);
      } else if (delay === 15_000) {
        lifecycleCallbacks.push(callback);
      }
      return lifecycleCallbacks.length + 1;
    },
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          routingTabId: 55,
          config: {
            playbackSessionId: message.sessionId,
            routingTabId: 55,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        ruleCount: 2
      });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ACK");
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId: "bvid-BV1234567890",
        routeKey: "/path/current.m4s",
        kind: "video",
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/current.m4s"
        ]
      }
    ]
  });
  harness.video.dispatchEvent(new Event("loadstart"));
  harness.video.paused = true;
  harness.video.dispatchEvent(new Event("pause"));
  harness.setHidden(true);
  harness.dispatchDocumentEvent("visibilitychange");
  assert.equal(lifecycleCallbacks.length, 1);
  lifecycleCallbacks[0]();
  await Promise.resolve();

  assert.ok(
    harness.messages.some(
      (message) => message.type === "STOP_PLAYBACK_SESSION"
    )
  );
  assert.ok(
    harness.mainMessages.some(
      (message) =>
        message.type === "LIFECYCLE" &&
        message.payload.active === false
    )
  );

  const startsBeforeResume = harness.messages.filter(
    (message) => message.type === "START_PLAYBACK_SESSION"
  ).length;
  harness.setHidden(false);
  harness.dispatchDocumentEvent("visibilitychange");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    harness.messages.filter(
      (message) => message.type === "START_PLAYBACK_SESSION"
    ).length > startsBeforeResume
  );
  assert.ok(
    harness.messages.some(
      (message) =>
        message.type === "REGISTER_MEDIA_ROUTES" &&
        message.routes.some(
          (route) =>
            route.presentationId === "bvid-BV1234567890"
        )
    )
  );
  assert.ok(
    harness.mainMessages.some(
      (message) =>
        message.type === "LIFECYCLE" &&
        message.payload.active === true
    )
  );
});

test("a hidden tab that is still playing keeps routing but suppresses proactive probes", async () => {
  const lifecycleCallbacks = [];
  const harness = await createHarness({
    pageUrl: "https://www.bilibili.com/video/BV1234567890",
    withVideo: true,
    setTimeout(callback, delay) {
      if (delay === 1000) {
        queueMicrotask(callback);
      } else if (delay === 15_000) {
        lifecycleCallbacks.push(callback);
      }
      return lifecycleCallbacks.length + 1;
    },
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ACK");
  harness.video.dispatchEvent(new Event("loadstart"));
  harness.video.dispatchEvent(new Event("playing"));
  harness.setHidden(true);
  harness.dispatchDocumentEvent("visibilitychange");
  assert.equal(lifecycleCallbacks.length, 0);
  const probesBefore = harness.probeMessages().length;
  harness.emitMainMessage("PROBE_URL", {
    presentationId: "bvid-BV1234567890",
    routeKey: "/path/new.m4s",
    kind: "video",
    mediaUrl:
      "https://upos-sz-mirrorcos.bilivideo.com/path/new.m4s"
  });
  await Promise.resolve();
  assert.equal(harness.probeMessages().length, probesBefore);
  assert.equal(
    harness.messages.some(
      (message) => message.type === "STOP_PLAYBACK_SESSION"
    ),
    false
  );
});

test("a probe re-establishes its playback session after service-worker restart", async () => {
  let probeAttempts = 0;
  const harness = await createHarness({
    sendMessage(message) {
      if (message.type === "START_PLAYBACK_SESSION") {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId
        });
      }
      if (message.type === "PROBE_MEDIA") {
        probeAttempts += 1;
        return Promise.resolve(
          probeAttempts === 1
            ? {
                ok: false,
                error: "Stale or unknown playback session"
              }
            : {
                ok: true,
                sessionId: message.sessionId,
                config: {
                  playbackSessionId: message.sessionId,
                  settings: {
                    globalEnabled: true,
                    privacy: {
                      cosmeticFiltering: false,
                      urlCleaning: false
                    }
                  },
                  cosmeticSelectors: []
                }
              }
        );
      }
      return Promise.resolve({ ok: true });
    }
  });
  harness.emitMainMessage("PROBE_URL", {
    mediaUrl:
      "https://upos-sz-mirrorcos.bilivideo.com/path/restart.m4s?token=1"
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeAttempts, 2);
});

test("route registration re-establishes its playback session after service-worker restart", async () => {
  let sessionStarts = 0;
  let registrationAttempts = 0;
  const harness = await createHarness({
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        if (message.type === "START_PLAYBACK_SESSION") {
          sessionStarts += 1;
        }
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: {
                cosmeticFiltering: false,
                urlCleaning: false
              }
            },
            cosmeticSelectors: []
          }
        });
      }
      if (message.type === "REGISTER_MEDIA_ROUTES") {
        registrationAttempts += 1;
        return Promise.resolve(
          registrationAttempts === 1
            ? {
                ok: false,
                error: "Stale or unknown playback session"
              }
            : {
                ok: true,
                sessionId: message.sessionId,
                ruleCount: 3
              }
        );
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        presentationId: "bvid-BV1234567890",
        routeKey: "/path/restart-route.m4s",
        kind: "video",
        urls: [
          "https://upos-hz-mirrorakam.akamaized.net/path/restart-route.m4s?token=1"
        ]
      }
    ]
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(registrationAttempts, 2);
  assert.ok(sessionStarts >= 2);
  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  assert.equal(latest.activeRuleCount, 3);
  assert.equal(
    latest.ordinaryEvents.some(
      (event) => event.type === "route-register-error"
    ),
    false
  );
});

test("probe byte-budget rejection returns the route qualification for retry", async () => {
  let probeAttempts = 0;
  const harness = await createHarness({
    sendMessage(message) {
      if (message.type === "PROBE_MEDIA") {
        probeAttempts += 1;
        return Promise.resolve(
          probeAttempts === 1
            ? { ok: false, error: "Probe byte budget exhausted" }
            : { ok: true, sessionId: message.sessionId }
        );
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  const mediaUrl =
    "https://upos-sz-mirrorcos.bilivideo.com/path/budget-retry.m4s?token=1";
  harness.emitMainMessage("PROBE_URL", { mediaUrl });
  await Promise.resolve();
  await Promise.resolve();
  harness.emitMainMessage("PROBE_URL", { mediaUrl });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(probeAttempts, 2);
});

test("a failed request attempt cannot change the active route host", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: { cosmeticFiltering: false, urlCleaning: false }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const route = {
    presentationId: "bvid-BVFAILED001",
    routeKey: "/path/failed-attempt.m4s",
    kind: "video"
  };
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        ...route,
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/failed-attempt.m4s?t=1",
          "https://upos-hz-mirrorakam.akamaized.net/path/failed-attempt.m4s?t=1"
        ]
      }
    ]
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-sz-mirrorcos.bilivideo.com",
    status: 206,
    bytes: 1024
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...route,
    host: "upos-hz-mirrorakam.akamaized.net",
    status: 0,
    bytes: 0
  });
  await Promise.resolve();

  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  const detail = Object.values(latest.routeDetails)[0];
  assert.equal(detail.mediaHost, "upos-sz-mirrorcos.bilivideo.com");
  assert.equal(
    detail.lastAttemptedHost,
    "upos-hz-mirrorakam.akamaized.net"
  );
  assert.equal(detail.routeSwitchCount, 0);
  assert.equal(detail.recoveryStatus, "idle");
  assert.equal(detail.lastStatus, 0);
});

test("late results from an older request cannot switch or degrade the current host", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: { cosmeticFiltering: false, urlCleaning: false }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const route = {
    presentationId: "bvid-BVORDERING1",
    routeKey: "/path/ordering.m4s",
    kind: "video"
  };
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        ...route,
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/ordering.m4s?t=1",
          "https://upos-hz-mirrorakam.akamaized.net/path/ordering.m4s?t=1"
        ]
      }
    ]
  });
  const completed = {
    ...route,
    status: 206,
    bytes: 1024
  };
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...completed,
    host: "upos-sz-mirrorcos.bilivideo.com",
    routingGeneration: 1,
    requestStartedAt: 100
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...completed,
    host: "upos-hz-mirrorakam.akamaized.net",
    routingGeneration: 2,
    requestStartedAt: 200
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...completed,
    host: "upos-sz-mirrorcos.bilivideo.com",
    routingGeneration: 1,
    requestStartedAt: 100
  });
  const degradedBefore = harness.messages.filter(
    (message) => message.type === "HOST_DEGRADED"
  ).length;
  harness.emitMainMessage("MEDIA_DEGRADED", {
    ...route,
    host: "upos-sz-mirrorcos.bilivideo.com",
    reason: "timeout",
    routingGeneration: 1,
    requestStartedAt: 100
  });
  await Promise.resolve();

  const latest = harness.messages
    .filter((message) => message.type === "RECORD_DIAGNOSTIC")
    .at(-1)?.session;
  const detail = Object.values(latest.routeDetails)[0];
  assert.equal(detail.mediaHost, "upos-hz-mirrorakam.akamaized.net");
  assert.equal(detail.routeSwitchCount, 1);
  assert.equal(
    harness.messages.filter(
      (message) => message.type === "HOST_DEGRADED"
    ).length,
    degradedBefore
  );
  assert.ok(
    latest.ordinaryEvents.some(
      (event) => event.type === "media-result-stale"
    )
  );
});

test("two full high-capacity transfers recover without synthetic buffer growth", async () => {
  const harness = await createHarness({
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: true },
              privacy: { cosmeticFiltering: false, urlCleaning: false }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({
        ok: true,
        sessionId: message.sessionId,
        recovered: message.type === "HOST_RECOVERED"
      });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const route = {
    presentationId: "bvid-BVCAPACITY1",
    routeKey: "/path/capacity.m4s",
    kind: "video",
    bandwidth: 2_000_000
  };
  harness.emitMainMessage("ROUTE_MANIFEST", {
    routes: [
      {
        ...route,
        urls: [
          "https://upos-sz-mirrorcos.bilivideo.com/path/capacity.m4s?t=1",
          "https://upos-hz-mirrorakam.akamaized.net/path/capacity.m4s?t=1"
        ]
      }
    ]
  });
  const transfer = {
    ...route,
    status: 206,
    bytes: 262_144,
    expectedBytes: 262_144,
    throughputBps: 10_000_000,
    bufferAhead: 0
  };
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...transfer,
    host: "upos-sz-mirrorcos.bilivideo.com"
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...transfer,
    host: "upos-hz-mirrorakam.akamaized.net"
  });
  harness.emitMainMessage("MEDIA_REQUEST_RESULT", {
    ...transfer,
    host: "upos-hz-mirrorakam.akamaized.net"
  });
  assert.ok(
    harness.messages.some(
      (message) =>
        message.type === "HOST_RECOVERED" &&
        message.host === "upos-hz-mirrorakam.akamaized.net"
    )
  );
});

test("playing cancels a pending transient waiting risk", async () => {
  let riskCallback;
  const harness = await createHarness({
    withVideo: true,
    setTimeout(callback, delay) {
      if (delay === 2500) {
        riskCallback = callback;
      }
      return 1;
    }
  });
  harness.emitMainMessage("MEDIA_HOST", {
    presentationId: "bvid-BVTRANSIENT1",
    routeKey: "/path/transient.m4s",
    kind: "video",
    host: "upos-hz-mirrorakam.akamaized.net"
  });
  harness.video.dispatchEvent(new Event("loadstart"));
  harness.video.dispatchEvent(new Event("waiting"));
  harness.video.dispatchEvent(new Event("playing"));
  riskCallback();
  assert.equal(
    harness.messages.some((message) => message.type === "PLAYBACK_RISK"),
    false
  );
});

test("page-context probes use one bounded Range stream for a registered route", async () => {
  const sample = new Uint8Array(262_144).fill(0x5a);
  const fetchCalls = [];
  const harness = await createHarness({
    pageUrl: "https://www.bilibili.com/video/BV1234567890",
    fetch(url, init) {
      fetchCalls.push({ url, init });
      return Promise.resolve(new Response(sample, { status: 206 }));
    },
    sendMessage(message) {
      if (
        message.type === "START_PLAYBACK_SESSION" ||
        message.type === "GET_RUNTIME_CONFIG"
      ) {
        return Promise.resolve({
          ok: true,
          sessionId: message.sessionId,
          config: {
            playbackSessionId: message.sessionId,
            candidateHosts: ["upos-hz-mirrorakam.akamaized.net"],
            settings: {
              globalEnabled: true,
              diagnostics: { enabled: false },
              privacy: { cosmeticFiltering: false, urlCleaning: false }
            },
            cosmeticSelectors: []
          }
        });
      }
      return Promise.resolve({ ok: true, sessionId: message.sessionId });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const route = {
    presentationId: "bvid-BV1234567890",
    routeKey: "/path/page-probe.m4s",
    kind: "video",
    urls: [
      "https://upos-sz-mirrorcos.bilivideo.com/path/page-probe.m4s?token=1"
    ]
  };
  harness.emitMainMessage("ROUTE_MANIFEST", { routes: [route] });
  const start = harness.messages.find(
    (message) => message.type === "START_PLAYBACK_SESSION"
  );
  const targetUrl =
    "https://upos-hz-mirrorakam.akamaized.net/path/page-probe.m4s?token=1";
  const result = await harness.requestRuntimeMessage({
    type: "RUN_PAGE_PROBE_FETCH",
    version: 1,
    probeId: "page-probe-12345678",
    sessionId: start.sessionId,
    sessionEpoch: start.sessionEpoch,
    presentationId: route.presentationId,
    routeKey: route.routeKey,
    targetUrl
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 206);
  assert.equal(result.finalUrl, targetUrl);
  assert.equal(result.bytes, 262_144);
  assert.ok(result.ttfbMs >= 0);
  assert.ok(result.transferDurationMs >= 0);
  assert.ok(result.durationMs >= 1);
  assert.ok(
    Math.abs(
      result.durationMs - result.ttfbMs - result.transferDurationMs
    ) <= 2
  );
  assert.deepEqual(
    new Uint8Array(Buffer.from(result.bodyBase64, "base64")),
    sample
  );
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, targetUrl);
  assert.equal(fetchCalls[0].init.headers.Range, "bytes=0-262143");
  assert.equal(fetchCalls[0].init.credentials, "omit");
  assert.equal(fetchCalls[0].init.cache, "no-store");
  assert.equal(fetchCalls[0].init.redirect, "error");

  const rejected = await harness.requestRuntimeMessage({
    type: "RUN_PAGE_PROBE_FETCH",
    version: 1,
    probeId: "page-probe-87654321",
    sessionId: start.sessionId,
    sessionEpoch: start.sessionEpoch,
    presentationId: route.presentationId,
    routeKey: route.routeKey,
    targetUrl: `${targetUrl}&forged=1`
  });
  assert.equal(rejected.ok, false);
  assert.equal(fetchCalls.length, 1);
});
