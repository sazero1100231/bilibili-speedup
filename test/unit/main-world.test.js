import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class TestCustomEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
}

async function createHarness(payload, options = {}) {
  const code = await readFile(
    new URL("../../src/content/main-world.js", import.meta.url),
    "utf8"
  );
  const document = new EventTarget();
  const videos = Array.isArray(options.videos)
    ? options.videos
    : options.video
      ? [options.video]
      : [];
  if (videos.length) {
    document.querySelectorAll = (selector) =>
      selector === "video" ? videos : [];
  }
  const windowEvents = new EventTarget();
  class HarnessXhr extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.responseType = "";
      this.status = 200;
      this._text = "";
      this._responseObject = undefined;
      this._responseHeaders = {};
      this.abortCount = 0;
    }

    open(_method, url) {
      this.openedUrl = String(url);
    }

    send() {}

    abort() {
      this.abortCount += 1;
      this.dispatchEvent(new Event("abort"));
      this.dispatchEvent(new Event("loadend"));
    }

    getResponseHeader(name) {
      return this._responseHeaders[String(name).toLowerCase()] ?? null;
    }

    get responseText() {
      return this._text;
    }

    get response() {
      if (
        this.responseType === "json" ||
        this.responseType === "arraybuffer" ||
        this.responseType === "blob"
      ) {
        return this._responseObject ?? JSON.parse(this._text);
      }
      return this._text;
    }
  }
  const emitted = [];
  const location = new URL(
    options.pageUrl ??
      "https://www.bilibili.com/video/BV1?p=1&vd_source=initial"
  );
  const historyMethods = {
    pushState(stateValue, _title, url) {
      this.state = stateValue;
      if (url !== undefined) {
        location.href = new URL(url, location.href).href;
      }
    },
    replaceState(stateValue, _title, url) {
      this.state = stateValue;
      if (url !== undefined) {
        location.href = new URL(url, location.href).href;
      }
    }
  };
  const history = options.inheritedHooks
    ? Object.assign(Object.create(historyMethods), { state: null })
    : { state: null, ...historyMethods };
  const originalHistoryReplace = history.replaceState;
  const fetchCalls = [];
  const originalFetch = async (input) => {
    fetchCalls.push(typeof input === "string" ? input : input.url);
    if (options.fetchImpl) {
      return options.fetchImpl(input, payload);
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  let beaconCalls = 0;
  const navigatorMethods = {
    sendBeacon() {
      beaconCalls += 1;
      return true;
    }
  };
  const clipboardMethods = {
    async writeText(text) {
      return text;
    }
  };
  const clipboard = options.inheritedHooks
    ? Object.create(clipboardMethods)
    : { ...clipboardMethods };
  const navigator = options.inheritedHooks
    ? Object.assign(Object.create(navigatorMethods), { clipboard })
    : { ...navigatorMethods, clipboard };
  const windowMethods = {
    fetch: originalFetch,
    open(url) {
      return url;
    }
  };
  const window = Object.assign(
    options.inheritedHooks ? Object.create(windowMethods) : { ...windowMethods },
    {
    XMLHttpRequest: HarnessXhr,
    Request,
    Response,
    Headers,
    URL,
    history,
    navigator,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
      postMessage() {}
    }
  );
  window.window = window;
  const context = {
    window,
    document,
    history,
    navigator,
    location,
    XMLHttpRequest: HarnessXhr,
    Request,
    Response,
    Headers,
    URL,
    ArrayBuffer,
    Uint8Array,
    Blob,
    crypto: webcrypto,
    AbortController,
    Event,
    EventTarget,
    CustomEvent: TestCustomEvent,
    performance: options.performance ?? performance,
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
    console
  };
  vm.runInNewContext(code, context, { filename: "main-world.js" });
  const nonce = "0123456789abcdef0123456789abcdef";
  const inboundEvent = `bilibili-speedup:private:${nonce}:in`;
  const outboundEvent = `bilibili-speedup:private:${nonce}:out`;
  document.addEventListener(outboundEvent, (event) => {
    const message = JSON.parse(String(event.detail ?? ""));
    if (message.type !== "ACK") {
      emitted.push(message);
    }
    if (
      message.type === "ROUTE_MANIFEST" &&
      options.autoPolicyReady !== false
    ) {
      queueMicrotask(() => {
        document.dispatchEvent(
          new TestCustomEvent(inboundEvent, {
            detail: JSON.stringify({
              type: "ROUTE_POLICY_READY",
              payload: { requestId: message.payload.requestId }
            })
          })
        );
      });
    }
  });
  document.dispatchEvent(
    new TestCustomEvent("bilibili-speedup:init", { detail: nonce })
  );
  async function setConfig(nextConfig) {
    document.dispatchEvent(
      new TestCustomEvent(inboundEvent, {
        detail: JSON.stringify({ type: "CONFIG", payload: nextConfig })
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  async function flushMessages() {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    window,
    document,
    history,
    location,
    emitted,
    fetchCalls,
    originalFetch,
    originalHistoryReplace,
    setConfig,
    sendPrivate(type, payload = {}) {
      document.dispatchEvent(
        new TestCustomEvent(inboundEvent, {
          detail: JSON.stringify({ type, payload })
        })
      );
    },
    acknowledgePolicy(requestId) {
      document.dispatchEvent(
        new TestCustomEvent(inboundEvent, {
          detail: JSON.stringify({
            type: "ROUTE_POLICY_READY",
            payload: { requestId }
          })
        })
      );
    },
    flushMessages,
    get beaconCalls() {
      return beaconCalls;
    }
  };
}

function config(globalEnabled = true) {
  return {
    settings: {
      globalEnabled,
      acceleration: { enabled: true, playurlRewrite: true },
      privacy: { urlCleaning: true, telemetryBlocking: true }
    },
    trackingParams: ["vd_source", "spm_id_from"],
    blockedHostPatterns: ["^upos-.*ov\\.bilivideo\\.com$"],
    blockedEndpoints: [
      { domain: "data.bilibili.com", pathPrefix: "/log/web" }
    ],
    healthyHosts: ["upos-sz-mirrorcos.bilivideo.com"],
    compatibleRoutes: {
      "/path/video.m4s": [
        "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3"
      ]
    }
  };
}

function createManualClock() {
  let now = 0;
  const timers = [];
  function setTimeoutManual(callback, delay = 0) {
    const timer = {
      at: now + Math.max(0, Number(delay) || 0),
      callback,
      cleared: false,
      unref() {
        return this;
      }
    };
    timers.push(timer);
    return timer;
  }
  function clearTimeoutManual(timer) {
    if (timer) {
      timer.cleared = true;
    }
  }
  async function advanceTo(target) {
    while (true) {
      const next = timers
        .filter((timer) => !timer.cleared && timer.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!next) {
        break;
      }
      now = next.at;
      next.cleared = true;
      next.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
    await Promise.resolve();
  }
  return {
    performance: { now: () => now },
    setTimeout: setTimeoutManual,
    clearTimeout: clearTimeoutManual,
    advanceTo
  };
}

const originalMedia =
  "https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3";

function playurlPayload() {
  return {
    code: 0,
    data: {
      dash: {
        video: [
          {
            baseUrl: originalMedia,
            backupUrl: [
              "https://upos-sz-mirroraliov.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3"
            ]
          }
        ]
      }
    }
  };
}

const ogvDrmOriginal =
  "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/00/00000000000/00000000000-1-000000.m4s?deadline=1";
const ogvDrmHealthy =
  "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/00/00/00000000000/00000000000-1-000000.m4s?deadline=1";

function ogvDrmPayload() {
  return {
    code: 0,
    data: {
      dash: {
        video: [
          {
            base_url: ogvDrmOriginal,
            backup_url: [ogvDrmHealthy]
          }
        ]
      }
    }
  };
}

test("actual MAIN-world fetch hook excludes static blocked hosts from ordinary playurl candidates", async () => {
  const harness = await createHarness(playurlPayload());
  await harness.setConfig(config(true));
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  const body = await response.json();
  const stream = body.data.dash.video[0];
  await harness.flushMessages();
  const before = new URL(originalMedia);
  const after = new URL(stream.baseUrl);
  assert.equal(after.hostname, "upos-sz-mirrorcos.bilivideo.com");
  assert.equal(after.pathname, before.pathname);
  assert.equal(after.search, before.search);
  assert.equal(
    [stream.baseUrl, ...stream.backupUrl].some((url) =>
      /^upos-.*ov\.bilivideo\.com$/.test(new URL(url).hostname)
    ),
    false
  );
  assert.ok(
    harness.emitted.some((message) => message.type === "MEDIA_REWRITE")
  );
  assert.ok(harness.emitted.some((message) => message.type === "PROBE_URL"));
});

test("successful media fetch emits an observable fetch-origin request result", async () => {
  const payload = playurlPayload();
  const harness = await createHarness(payload, {
    fetchImpl(input) {
      const url = typeof input === "string" ? input : input.url;
      return new URL(url).pathname.includes("playurl")
        ? new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        : new Response(new Uint8Array([1, 2, 3]), { status: 206 });
    }
  });
  await harness.setConfig(config(true));
  const playurl = await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json());
  await harness.window.fetch(playurl.data.dash.video[0].baseUrl);
  await harness.flushMessages();
  const result = harness.emitted.find(
    (message) =>
      message.type === "MEDIA_REQUEST_RESULT" &&
      message.payload.origin === "fetch"
  );
  assert.ok(result);
  assert.equal(result.payload.status, 206);
  assert.equal(result.payload.bytes, 0);
  assert.equal(result.payload.routeKey, "/path/video.m4s");
  assert.equal(result.payload.host, "upos-sz-mirrorcos.bilivideo.com");
  assert.ok(result.payload.routingGeneration > 0);
  assert.ok(result.payload.requestStartedAt >= 0);
});

test("half-open route-host permits one concurrent leader and keeps followers on a safe host", async () => {
  const safePrimary =
    "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?token=primary";
  const safeFollower =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?token=follower";
  const payload = {
    code: 0,
    data: {
      dash: {
        video: [{ baseUrl: safePrimary, backupUrl: [safeFollower] }]
      }
    }
  };
  let failPrimary = false;
  const harness = await createHarness(payload, {
    fetchImpl(input) {
      const url = typeof input === "string" ? input : input.url;
      const parsed = new URL(url);
      return parsed.pathname.includes("playurl")
        ? new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        : failPrimary &&
            parsed.hostname === "upos-sz-mirrorcos.bilivideo.com"
          ? new Response(new Uint8Array(), { status: 500 })
        : new Response(new Uint8Array([1]), { status: 206 });
    }
  });
  const presentationRoute =
    "bvid-BV0000000001::/path/video.m4s";
  const initialConfig = config(true);
  initialConfig.compatibleRoutes = {};
  await harness.setConfig(initialConfig);
  await harness.window
    .fetch(
      "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV0000000001"
    )
    .then((response) => response.json());
  failPrimary = true;
  await harness.window.fetch(safePrimary);
  await harness.window.fetch(safePrimary);
  failPrimary = false;
  const blockedConfig = config(true);
  blockedConfig.compatibleRoutes = {};
  blockedConfig.degradedRoutes = {
    [presentationRoute]: ["upos-sz-mirrorcos.bilivideo.com"]
  };
  await harness.setConfig(blockedConfig);

  const halfOpenConfig = config(true);
  halfOpenConfig.compatibleRoutes = {};
  halfOpenConfig.degradedRoutes = {};
  halfOpenConfig.halfOpenRoutes = {
    [presentationRoute]: [
      "upos-sz-mirrorcos.bilivideo.com"
    ]
  };
  await harness.setConfig(halfOpenConfig);
  const mediaStart = harness.fetchCalls.length;
  await Promise.all([
    harness.window.fetch(safePrimary),
    harness.window.fetch(safePrimary)
  ]);
  const mediaHosts = harness.fetchCalls
    .slice(mediaStart)
    .filter((url) => new URL(url).pathname.endsWith("/video.m4s"))
    .map((url) => new URL(url).hostname);
  assert.equal(
    mediaHosts.filter(
      (host) => host === "upos-sz-mirrorcos.bilivideo.com"
    ).length,
    1
  );
  assert.deepEqual(
    mediaHosts.sort(),
    [
      "upos-hz-mirrorakam.akamaized.net",
      "upos-sz-mirrorcos.bilivideo.com"
    ].sort()
  );
});

test("fifth presentation stays native and emits one aggregated capacity diagnostic", async () => {
  const harness = await createHarness(playurlPayload());
  await harness.setConfig(config(true));
  let fifthStream;
  for (let index = 1; index <= 5; index += 1) {
    const bvid = `BV${String(index).padStart(10, "0")}`;
    const body = await harness.window
      .fetch(`https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}`)
      .then((response) => response.json());
    if (index === 5) {
      fifthStream = body.data.dash.video[0];
    }
  }
  await harness.flushMessages();
  assert.equal(fifthStream.baseUrl, originalMedia);
  const manifests = harness.emitted.filter(
    (message) => message.type === "ROUTE_MANIFEST"
  );
  assert.equal(manifests.length, 4);
  const diagnostics = harness.emitted.filter(
    (message) => message.type === "PRESENTATION_CAPACITY"
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].payload.maxPresentations, 4);
  assert.equal(diagnostics[0].payload.droppedRoutes, 1);
});

test("OGV DRM pre-check manifest rewrites exact safe backup routes for fetch and XHR", async () => {
  const pageUrl = "https://www.bilibili.com/bangumi/play/ep0";
  const fetchHarness = await createHarness(ogvDrmPayload(), { pageUrl });
  await fetchHarness.setConfig(config(true));
  const body = await fetchHarness.window
    .fetch("https://api.bilibili.com/ogv/player/pre/check/drm", {
      method: "POST"
    })
    .then((response) => response.json());
  await fetchHarness.flushMessages();
  const fetchStream = body.data.dash.video[0];
  assert.equal(fetchStream.base_url, ogvDrmHealthy);
  assert.equal(new URL(fetchStream.base_url).pathname, new URL(ogvDrmOriginal).pathname);
  assert.ok(
    fetchHarness.emitted.some(
      (message) =>
        message.type === "ROUTE_MANIFEST" &&
        message.payload.routes.some(
          (route) => route.presentationId === "ep_id-0"
        )
    )
  );

  const xhrHarness = await createHarness(ogvDrmPayload(), { pageUrl });
  await xhrHarness.setConfig(config(true));
  const xhr = new xhrHarness.window.XMLHttpRequest();
  xhr.open("POST", "https://api.bilibili.com/ogv/player/pre/check/drm");
  xhr._text = JSON.stringify(ogvDrmPayload());
  xhr.readyState = 4;
  const xhrStream = JSON.parse(xhr.responseText).data.dash.video[0];
  assert.equal(xhrStream.base_url, ogvDrmHealthy);
  assert.equal(new URL(xhrStream.base_url).pathname, new URL(ogvDrmOriginal).pathname);
});

test("autoplay SPA navigation retains the already rewritten destination presentation", async () => {
  const nextBvid = "BVABCDEFGHIJ";
  const harness = await createHarness(playurlPayload(), {
    pageUrl: "https://www.bilibili.com/video/BV1234567890"
  });
  await harness.setConfig(config(true));
  const playurl = await harness.window
    .fetch(`https://api.bilibili.com/x/player/wbi/playurl?bvid=${nextBvid}`)
    .then((response) => response.json());
  await harness.flushMessages();

  harness.history.pushState(
    {},
    "",
    `https://www.bilibili.com/video/${nextBvid}`
  );
  await harness.flushMessages();
  await harness.window.fetch(playurl.data.dash.video[0].baseUrl);
  await harness.flushMessages();

  assert.ok(
    harness.emitted.some(
      (message) =>
        message.type === "MEDIA_HOST" &&
        message.payload.presentationId === `bvid-${nextBvid}`
    ),
    "destination route must remain available after history changes to its BVID"
  );
});

test("tracking-only pushState and replaceState do not emit duplicate playback navigation", async () => {
  const bvid = "BV1234567890";
  const harness = await createHarness(playurlPayload(), {
    pageUrl: `https://www.bilibili.com/video/${bvid}?spm_id_from=old`
  });
  await harness.setConfig(config(true));
  const before = harness.emitted.filter(
    (message) => message.type === "NAVIGATION"
  ).length;

  harness.history.pushState(
    {},
    "",
    `https://www.bilibili.com/video/${bvid}?spm_id_from=new`
  );
  harness.history.replaceState(
    {},
    "",
    `https://www.bilibili.com/video/${bvid}?vd_source=cleaned`
  );
  await harness.flushMessages();
  assert.equal(
    harness.emitted.filter(
      (message) => message.type === "NAVIGATION"
    ).length,
    before
  );

  harness.history.replaceState(
    {},
    "",
    `https://www.bilibili.com/video/${bvid}?p=2`
  );
  await harness.flushMessages();
  assert.equal(
    harness.emitted.filter(
      (message) => message.type === "NAVIGATION"
    ).length,
    before + 1
  );
});

test("recommendation playurls stage only the newest destination and stay out of active routing", async () => {
  const currentBvid = "BV1234567890";
  const olderRecommendation = "BVABCDEFGHIJ";
  const newestRecommendation = "BVKLMNOPQRST";
  const harness = await createHarness(playurlPayload(), {
    pageUrl: `https://www.bilibili.com/video/${currentBvid}`
  });
  await harness.setConfig(config(true));

  await harness.window.fetch(
    `https://api.bilibili.com/x/player/wbi/playurl?bvid=${currentBvid}`
  );
  const older = await harness.window
    .fetch(
      `https://api.bilibili.com/x/player/wbi/playurl?bvid=${olderRecommendation}`
    )
    .then((response) => response.json());
  const newest = await harness.window
    .fetch(
      `https://api.bilibili.com/x/player/wbi/playurl?bvid=${newestRecommendation}`
    )
    .then((response) => response.json());
  await harness.flushMessages();

  const activePresentations = new Set(
    harness.emitted
      .filter((message) => message.type === "ROUTE_MANIFEST")
      .flatMap((message) => message.payload.routes)
      .map((route) => route.presentationId)
  );
  assert.deepEqual([...activePresentations], [`bvid-${currentBvid}`]);
  assert.equal(
    harness.emitted.filter(
      (message) => message.type === "MEDIA_REWRITE"
    ).length,
    1
  );

  harness.history.pushState(
    {},
    "",
    `https://www.bilibili.com/video/${newestRecommendation}`
  );
  await harness.window.fetch(newest.data.dash.video[0].baseUrl);
  await harness.flushMessages();
  assert.ok(
    harness.emitted.some(
      (message) =>
        message.type === "MEDIA_HOST" &&
        message.payload.presentationId ===
          `bvid-${newestRecommendation}`
    )
  );

  harness.history.pushState(
    {},
    "",
    `https://www.bilibili.com/video/${olderRecommendation}`
  );
  const offset = harness.emitted.length;
  await harness.window.fetch(older.data.dash.video[0].baseUrl);
  await harness.flushMessages();
  assert.equal(
    harness.emitted.slice(offset).some(
      (message) =>
        message.type === "MEDIA_HOST" &&
        message.payload.presentationId ===
          `bvid-${olderRecommendation}`
    ),
    false
  );
});

test("PGC autoplay retention matches ep_id as an identity component and rejects another episode", async () => {
  const nextEpisode = "1";
  const pgcUrl =
    "https://api.bilibili.com/pgc/player/web/playurl" +
    `?avid=3&cid=2&ep_id=${nextEpisode}&season_id=1`;
  const expectedPresentation =
    `ep_id-${nextEpisode}`;

  const retained = await createHarness(playurlPayload(), {
    pageUrl: "https://www.bilibili.com/bangumi/play/ep0"
  });
  await retained.setConfig(config(true));
  const playurl = await retained.window.fetch(pgcUrl).then((response) =>
    response.json()
  );
  retained.history.pushState(
    {},
    "",
    `https://www.bilibili.com/bangumi/play/ep${nextEpisode}`
  );
  await retained.flushMessages();
  await retained.window.fetch(playurl.data.dash.video[0].baseUrl);
  await retained.flushMessages();
  assert.ok(
    retained.emitted.some(
      (message) =>
        message.type === "MEDIA_HOST" &&
        message.payload.presentationId === expectedPresentation
    )
  );

  const rejected = await createHarness(playurlPayload(), {
    pageUrl: "https://www.bilibili.com/bangumi/play/ep0"
  });
  await rejected.setConfig(config(true));
  const rejectedPlayurl = await rejected.window
    .fetch(pgcUrl)
    .then((response) => response.json());
  rejected.history.pushState(
    {},
    "",
    "https://www.bilibili.com/bangumi/play/ep2"
  );
  await rejected.flushMessages();
  const emittedBeforeMedia = rejected.emitted.length;
  await rejected.window.fetch(rejectedPlayurl.data.dash.video[0].baseUrl);
  await rejected.flushMessages();
  assert.equal(
    rejected.emitted.slice(emittedBeforeMedia).some(
      (message) =>
        message.type === "MEDIA_HOST" &&
        message.payload.presentationId === expectedPresentation
    ),
    false
  );
});

test("playurl identity stays stable when Bilibili enriches the same BVID with cid and avid", async () => {
  const bvid = "BV1234567890";
  const harness = await createHarness(playurlPayload(), {
    pageUrl: `https://www.bilibili.com/video/${bvid}`
  });
  await harness.setConfig(config(true));
  await harness.window.fetch(
    `https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}`
  );
  await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl" +
      `?bvid=${bvid}&cid=39233519842&avid=116775177949392`
  );
  await harness.flushMessages();

  const presentations = new Set(
    harness.emitted
      .filter((message) => message.type === "ROUTE_MANIFEST")
      .flatMap((message) => message.payload.routes)
      .map((route) => route.presentationId)
  );
  assert.deepEqual([...presentations], [`bvid-${bvid}`]);
});

test("search result previews stay native and allocate no playback routing work", async () => {
  const harness = await createHarness(playurlPayload(), {
    pageUrl:
      "https://search.bilibili.com/all?keyword=music&search_source=fixture"
  });
  await harness.setConfig(config(true));
  const eventOffset = harness.emitted.length;

  for (let index = 0; index < 50; index += 1) {
    const body = await harness.window
      .fetch(
        `https://api.bilibili.com/x/player/wbi/playurl?bvid=BVSEARCH${index}`
      )
      .then((response) => response.json());
    assert.equal(body.data.dash.video[0].baseUrl, originalMedia);
  }

  const mediaXhr = new harness.window.XMLHttpRequest();
  mediaXhr.open("GET", originalMedia);
  assert.equal(mediaXhr.openedUrl, originalMedia);
  mediaXhr.send();

  harness.history.replaceState(
    {},
    "",
    "?keyword=music&page=2&vd_source=removed"
  );
  await harness.flushMessages();
  assert.equal(harness.location.href.includes("vd_source"), false);
  assert.equal(harness.location.href.includes("page=2"), true);
  assert.equal(
    harness.emitted.slice(eventOffset).some((message) =>
      [
        "MEDIA_REWRITE",
        "PROBE_URL",
        "PROBE_REFERENCE",
        "ROUTE_MANIFEST",
        "NAVIGATION"
      ].includes(message.type)
    ),
    false
  );
});

test("MAIN-world hooks are inert before private CONFIG arrives", async () => {
  const harness = await createHarness(playurlPayload());
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  const stream = (await response.json()).data.dash.video[0];
  await harness.flushMessages();
  assert.equal(
    new URL(stream.baseUrl).hostname,
    "upos-sz-mirrorcosov.bilivideo.com"
  );
  assert.equal(
    harness.emitted.some((message) => message.type === "PROBE_URL"),
    false
  );
  assert.equal(
    harness.emitted.some((message) => message.type === "MEDIA_REWRITE"),
    false
  );
});

test("playurl startup waits at most 150ms for authenticated config", async () => {
  for (const [delay, shouldRewrite] of [
    [0, true],
    [50, true],
    [100, true],
    [225, false],
    [500, false]
  ]) {
    const harness = await createHarness(playurlPayload());
    const timer = setTimeout(() => {
      void harness.setConfig(config(true));
    }, delay);
    const startedAt = performance.now();
    const response = await harness.window.fetch(
      "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
    );
    const elapsed = performance.now() - startedAt;
    const stream = (await response.json()).data.dash.video[0];
    assert.equal(
      new URL(stream.baseUrl).hostname ===
        "upos-sz-mirrorcos.bilivideo.com",
      shouldRewrite,
      `config delay ${delay}ms`
    );
    if (!shouldRewrite) {
      assert.ok(
        elapsed < 250,
        `config delay ${delay}ms blocked fetch for ${elapsed.toFixed(1)}ms`
      );
      clearTimeout(timer);
    }
  }
});

test("playurl startup enforces the exact 149ms/151ms config boundary", async () => {
  for (const [delay, shouldRewrite] of [
    [149, true],
    [151, false]
  ]) {
    const clock = createManualClock();
    const harness = await createHarness(playurlPayload(), {
      performance: clock.performance,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout
    });
    clock.setTimeout(() => {
      void harness.setConfig(config(true));
    }, delay);
    const responsePromise = harness.window.fetch(
      "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
    );
    await clock.advanceTo(150);
    const response = await responsePromise;
    const stream = (await response.json()).data.dash.video[0];
    assert.equal(
      new URL(stream.baseUrl).hostname ===
        "upos-sz-mirrorcos.bilivideo.com",
      shouldRewrite,
      `manual-clock config delay ${delay}ms`
    );
  }
});

test("playurl overlaps an in-budget config wait with a warm network response", async () => {
  const payload = playurlPayload();
  let fetchStartedAt = 0;
  const harness = await createHarness(payload, {
    fetchImpl() {
      fetchStartedAt = performance.now();
      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify(payload), {
                status: 200,
                headers: { "content-type": "application/json" }
              })
            ),
          300
        );
      });
    }
  });
  const startedAt = performance.now();
  setTimeout(() => {
    void harness.setConfig(config(true));
  }, 100);
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  const stream = (await response.json()).data.dash.video[0];
  assert.ok(
    fetchStartedAt - startedAt < 50,
    "playurl request should start without waiting for CONFIG"
  );
  assert.equal(
    new URL(stream.baseUrl).hostname,
    "upos-sz-mirrorcos.bilivideo.com"
  );
});

test("late config cannot rewrite an already in-flight startup response", async () => {
  const payload = playurlPayload();
  const harness = await createHarness(payload, {
    fetchImpl() {
      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify(payload), {
                status: 200,
                headers: { "content-type": "application/json" }
              })
            ),
          300
        );
      });
    }
  });
  setTimeout(() => {
    void harness.setConfig(config(true));
  }, 200);
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  const stream = (await response.json()).data.dash.video[0];
  assert.equal(
    new URL(stream.baseUrl).hostname,
    "upos-sz-mirrorcosov.bilivideo.com"
  );
  assert.ok(
    harness.emitted.some(
      (message) =>
        message.type === "STARTUP_PASSTHROUGH" &&
        message.payload.readyWithinBudget === false
    )
  );
});

test("bootstrap __playinfo__ is inert before CONFIG and rewritten after CONFIG", async () => {
  const harness = await createHarness(playurlPayload());
  const bootstrap = playurlPayload();
  harness.window.__playinfo__ = bootstrap;
  assert.equal(harness.window.__playinfo__, bootstrap);
  assert.equal(
    new URL(harness.window.__playinfo__.data.dash.video[0].baseUrl).hostname,
    "upos-sz-mirrorcosov.bilivideo.com"
  );

  await harness.setConfig(config(true));
  assert.notEqual(harness.window.__playinfo__, bootstrap);
  assert.equal(
    new URL(harness.window.__playinfo__.data.dash.video[0].baseUrl).hostname,
    "upos-sz-mirrorcos.bilivideo.com"
  );
  assert.ok(
    harness.emitted.some(
      (message) =>
        message.type === "MEDIA_REWRITE" &&
        message.payload.source === "bootstrap-playinfo"
    )
  );
  assert.ok(
    harness.emitted.some((message) => message.type === "ROUTE_MANIFEST")
  );
  const rewrites = harness.emitted.filter(
    (message) =>
      message.type === "MEDIA_REWRITE" &&
      message.payload.source === "bootstrap-playinfo"
  ).length;
  await harness.setConfig(config(true));
  assert.equal(
    harness.emitted.filter(
      (message) =>
        message.type === "MEDIA_REWRITE" &&
        message.payload.source === "bootstrap-playinfo"
    ).length,
    rewrites,
    "runtime config refresh must not rewrite the same bootstrap assignment"
  );
});

test("bootstrap policy is applied before probing and a stale blocked URL cannot regain route priority", async () => {
  const safeBackup =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=safe";
  const payload = playurlPayload();
  payload.data.dash.video[0].backupUrl = [safeBackup];
  const harness = await createHarness(payload);
  harness.window.__playinfo__ = structuredClone(payload);
  const nextConfig = config(true);
  nextConfig.compatibleRoutes = {};

  await harness.setConfig(nextConfig);
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  await response.json();
  const manifests = harness.emitted.filter(
    (message) => message.type === "ROUTE_MANIFEST"
  );
  const probes = harness.emitted.filter(
    (message) => message.type === "PROBE_URL"
  );

  assert.ok(manifests.length >= 2);
  assert.equal(
    new URL(manifests.at(-1).payload.routes[0].urls[0]).hostname,
    "upos-hz-mirrorakam.akamaized.net"
  );
  assert.ok(probes.length >= 1);
  assert.ok(
    probes.every(
      (message) =>
        new URL(message.payload.mediaUrl).hostname ===
        "upos-hz-mirrorakam.akamaized.net"
    )
  );
});

test("fetch playurl response has a bounded route-policy ready barrier", async () => {
  const harness = await createHarness(playurlPayload(), {
    autoPolicyReady: false
  });
  await harness.setConfig(config(true));
  let settled = false;
  const pending = harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => {
      settled = true;
      return response;
    });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  const requestId = harness.emitted.find(
    (message) => message.type === "ROUTE_MANIFEST"
  )?.payload.requestId;
  assert.ok(requestId);
  harness.acknowledgePolicy(requestId);
  const response = await pending;
  assert.equal(
    new URL((await response.json()).data.dash.video[0].baseUrl).hostname,
    "upos-sz-mirrorcos.bilivideo.com"
  );

  const timeoutHarness = await createHarness(playurlPayload(), {
    autoPolicyReady: false
  });
  await timeoutHarness.setConfig(config(true));
  const startedAt = performance.now();
  await timeoutHarness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed >= 140 && elapsed < 250);
});

test("actual XHR getter hook rewrites UGC/PGC JSON before consumption", async () => {
  const harness = await createHarness(playurlPayload());
  await harness.setConfig(config(true));
  const xhr = new harness.window.XMLHttpRequest();
  xhr.open(
    "GET",
    "https://api.bilibili.com/pgc/player/web/playurl?ep_id=1"
  );
  xhr._text = JSON.stringify(playurlPayload());
  xhr.readyState = 4;
  const body = JSON.parse(xhr.responseText);
  assert.equal(
    new URL(body.data.dash.video[0].baseUrl).hostname,
    "upos-sz-mirrorcos.bilivideo.com"
  );
});

test("XHR json getter returns non-playurl responses by identity without rewriting", async () => {
  const harness = await createHarness(playurlPayload());
  await harness.setConfig(config(true));
  const raw = { data: { comments: [{ id: 1 }] } };
  const xhr = new harness.window.XMLHttpRequest();
  xhr.responseType = "json";
  xhr.open("GET", "https://api.bilibili.com/x/v2/reply/main?oid=1");
  xhr._responseObject = raw;
  xhr.readyState = 4;
  assert.equal(xhr.response, raw);
  assert.equal(
    harness.emitted.some((message) => message.type === "MEDIA_REWRITE"),
    false
  );
});

test("XHR json and media failure paths are inert when playurl rewriting is disabled", async () => {
  const harness = await createHarness(playurlPayload());
  const disabledConfig = config(true);
  disabledConfig.settings.acceleration.playurlRewrite = false;
  await harness.setConfig(disabledConfig);

  const raw = playurlPayload();
  const xhr = new harness.window.XMLHttpRequest();
  xhr.responseType = "json";
  xhr.open(
    "GET",
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  xhr._responseObject = raw;
  xhr.readyState = 4;
  assert.equal(xhr.response, raw);
  assert.equal(
    new URL(raw.data.dash.video[0].baseUrl).hostname,
    "upos-sz-mirrorcosov.bilivideo.com"
  );

  const mediaXhr = new harness.window.XMLHttpRequest();
  mediaXhr.open("GET", originalMedia);
  mediaXhr.status = 500;
  mediaXhr.send();
  mediaXhr.dispatchEvent(new Event("loadend"));
  assert.equal(
    harness.emitted.some((message) => message.type === "FALLBACK"),
    false
  );
});

test("an aborted media XHR is not misclassified as a CDN failure", async () => {
  const harness = await createHarness(playurlPayload());
  await harness.setConfig(config(true));
  const stream = await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json())
    .then((body) => body.data.dash.video[0]);
  const eventOffset = harness.emitted.length;

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open("GET", stream.baseUrl);
  xhr.status = 0;
  xhr.send();
  xhr.dispatchEvent(new Event("abort"));
  xhr.dispatchEvent(new Event("loadend"));

  const events = harness.emitted.slice(eventOffset);
  assert.ok(
    events.some((message) => message.type === "MEDIA_REQUEST_CANCELLED")
  );
  assert.equal(
    events.some((message) => message.type === "MEDIA_DEGRADED"),
    false
  );
  assert.equal(
    events.some((message) => message.type === "MEDIA_REQUEST_RESULT"),
    false
  );
  assert.equal(
    events.some((message) => message.type === "FALLBACK"),
    false
  );
});

test("a degraded in-flight XHR hands off only to an exact verified route at low buffer", async () => {
  const clock = createManualClock();
  const bvid = "BV1234567890";
  const primary =
    "https://upos-sz-mirrorcos.bilivideo.com/path/handoff.m4s?token=primary";
  const candidate =
    "https://upos-hz-mirrorakam.akamaized.net/path/handoff.m4s?token=backup";
  const payload = {
    code: 0,
    data: {
      dash: {
        video: [
          {
            baseUrl: primary,
            backupUrl: [candidate],
            bandwidth: 4_000_000,
            mimeType: "video/mp4"
          }
        ]
      }
    }
  };
  const video = {
    currentSrc: primary,
    src: primary,
    currentTime: 0,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 2
    }
  };
  const harness = await createHarness(payload, {
    pageUrl: `https://www.bilibili.com/video/${bvid}`,
    video,
    performance: clock.performance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const initial = config(true);
  initial.compatibleRoutes = {};
  await harness.setConfig(initial);
  await harness.window.fetch(
    `https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}`
  );

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open("GET", primary);
  xhr.send();
  await clock.advanceTo(2000);

  const degraded = config(true);
  degraded.compatibleRoutes = {
    [`bvid-${bvid}::/path/handoff.m4s`]: [candidate]
  };
  degraded.degradedRoutes = {
    [`bvid-${bvid}::/path/handoff.m4s`]: [
      "upos-sz-mirrorcos.bilivideo.com"
    ]
  };
  await harness.setConfig(degraded);
  assert.equal(xhr.abortCount, 1);
  assert.ok(
    harness.emitted.some(
      (message) =>
        message.type === "HANDOFF_TRIGGERED" &&
        message.payload.fromHost ===
          "upos-sz-mirrorcos.bilivideo.com" &&
        message.payload.toHost ===
          "upos-hz-mirrorakam.akamaized.net"
    )
  );
  assert.ok(
    harness.emitted.some(
      (message) =>
        message.type === "MEDIA_REQUEST_CANCELLED" &&
        message.payload.reason === "handoff-abort"
    )
  );

  const retry = new harness.window.XMLHttpRequest();
  retry.open("GET", primary);
  assert.equal(
    new URL(retry.openedUrl).hostname,
    "upos-hz-mirrorakam.akamaized.net"
  );
});

test("an advancing partial Range is not discarded by a soft route-policy update", async () => {
  const clock = createManualClock();
  const bvid = "BV1234567890";
  const primary =
    "https://upos-sz-mirrorcos.bilivideo.com/path/progressing.m4s?token=primary";
  const candidate =
    "https://upos-hz-mirrorakam.akamaized.net/path/progressing.m4s?token=backup";
  const payload = {
    code: 0,
    data: {
      dash: {
        video: [
          {
            baseUrl: primary,
            backupUrl: [candidate],
            bandwidth: 12_000_000,
            mimeType: "video/mp4"
          }
        ]
      }
    }
  };
  const harness = await createHarness(payload, {
    pageUrl: `https://www.bilibili.com/video/${bvid}`,
    video: {
      currentSrc: primary,
      src: primary,
      currentTime: 0,
      buffered: {
        length: 1,
        start: () => 0,
        end: () => 0
      }
    },
    performance: clock.performance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const initial = config(true);
  initial.compatibleRoutes = {};
  await harness.setConfig(initial);
  await harness.window.fetch(
    `https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}`
  );

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open("GET", primary);
  xhr.send();
  await clock.advanceTo(1600);
  const progress = new Event("progress");
  Object.defineProperty(progress, "loaded", { value: 2_258_565 });
  Object.defineProperty(progress, "total", { value: 3_322_449 });
  xhr.dispatchEvent(progress);

  const degraded = config(true);
  degraded.compatibleRoutes = {
    [`bvid-${bvid}::/path/progressing.m4s`]: [candidate]
  };
  degraded.degradedRoutes = {
    [`bvid-${bvid}::/path/progressing.m4s`]: [
      "upos-sz-mirrorcos.bilivideo.com"
    ]
  };
  await harness.setConfig(degraded);

  assert.equal(xhr.abortCount, 0);
  assert.equal(
    harness.emitted.some(
      (message) =>
        message.type === "MEDIA_DEGRADED" &&
        message.payload.reason === "slow-body"
    ),
    false
  );
  xhr.dispatchEvent(new Event("loadend"));
});

test("XHR handoff does not fire with ample buffer or without compatible evidence", async () => {
  const bvid = "BV1234567890";
  const primary =
    "https://upos-sz-mirrorcos.bilivideo.com/path/guarded.m4s?token=primary";
  const candidate =
    "https://upos-hz-mirrorakam.akamaized.net/path/guarded.m4s?token=backup";
  let bufferEnd = 20;
  const payload = {
    code: 0,
    data: {
      dash: {
        video: [
          {
            baseUrl: primary,
            backupUrl: [candidate],
            bandwidth: 4_000_000,
            mimeType: "video/mp4"
          }
        ]
      }
    }
  };
  const harness = await createHarness(payload, {
    pageUrl: `https://www.bilibili.com/video/${bvid}`,
    video: {
      currentSrc: primary,
      src: primary,
      currentTime: 0,
      buffered: {
        length: 1,
        start: () => 0,
        end: () => bufferEnd
      }
    }
  });
  const initial = config(true);
  initial.compatibleRoutes = {};
  await harness.setConfig(initial);
  await harness.window.fetch(
    `https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}`
  );
  const xhr = new harness.window.XMLHttpRequest();
  xhr.open("GET", primary);
  xhr.send();

  const ampleBuffer = config(true);
  ampleBuffer.compatibleRoutes = {
    [`bvid-${bvid}::/path/guarded.m4s`]: [candidate]
  };
  ampleBuffer.degradedRoutes = {
    [`bvid-${bvid}::/path/guarded.m4s`]: [
      "upos-sz-mirrorcos.bilivideo.com"
    ]
  };
  await harness.setConfig(ampleBuffer);
  assert.equal(xhr.abortCount, 0);

  bufferEnd = 2;
  const noEvidence = config(true);
  noEvidence.compatibleRoutes = {};
  noEvidence.degradedRoutes = ampleBuffer.degradedRoutes;
  await harness.setConfig(noEvidence);
  assert.equal(xhr.abortCount, 0);
  assert.equal(
    harness.emitted.some(
      (message) => message.type === "HANDOFF_TRIGGERED"
    ),
    false
  );
});

test("a successful byte-zero video XHR emits one bounded passive probe reference", async () => {
  const payload = playurlPayload();
  payload.data.dash.video[0].mimeType = "video/mp4";
  const harness = await createHarness(payload, {
    pageUrl: "https://www.bilibili.com/video/BV1234567890"
  });
  await harness.setConfig(config(true));
  const stream = await harness.window
    .fetch(
      "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1234567890"
    )
    .then((response) => response.json())
    .then((body) => body.data.dash.video[0]);
  const eventOffset = harness.emitted.length;
  const sample = new Uint8Array(262_144).fill(7);

  const xhr = new harness.window.XMLHttpRequest();
  xhr.responseType = "arraybuffer";
  xhr.open("GET", stream.baseUrl);
  xhr.status = 206;
  xhr._responseObject = sample.buffer;
  xhr._responseHeaders["content-range"] = "bytes 0-262143/1000000";
  xhr.send();
  xhr.dispatchEvent(new Event("loadend"));
  await harness.flushMessages();

  const references = harness.emitted
    .slice(eventOffset)
    .filter((message) => message.type === "PROBE_REFERENCE");
  assert.equal(references.length, 1);
  assert.equal(references[0].payload.referenceBytes, 262_144);
  assert.equal(references[0].payload.referenceStatus, 206);
  assert.equal(references[0].payload.kind, "video");
  assert.match(references[0].payload.referenceHash, /^[0-9a-f]{64}$/);

  const second = new harness.window.XMLHttpRequest();
  second.responseType = "arraybuffer";
  second.open("GET", stream.baseUrl);
  second.status = 206;
  second._responseObject = sample.buffer;
  second._responseHeaders["content-range"] = "bytes 0-262143/1000000";
  second.send();
  second.dispatchEvent(new Event("loadend"));
  await harness.flushMessages();
  assert.equal(
    harness.emitted.filter(
      (message) => message.type === "PROBE_REFERENCE"
    ).length,
    1
  );
});

test("a nonzero XHR range cannot become compatibility evidence", async () => {
  const payload = playurlPayload();
  payload.data.dash.video[0].mimeType = "video/mp4";
  const harness = await createHarness(payload, {
    pageUrl: "https://www.bilibili.com/video/BV1234567890"
  });
  await harness.setConfig(config(true));
  const stream = await harness.window
    .fetch(
      "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1234567890"
    )
    .then((response) => response.json())
    .then((body) => body.data.dash.video[0]);
  const eventOffset = harness.emitted.length;
  const xhr = new harness.window.XMLHttpRequest();
  xhr.responseType = "arraybuffer";
  xhr.open("GET", stream.baseUrl);
  xhr.status = 206;
  xhr._responseObject = new Uint8Array(262_144).buffer;
  xhr._responseHeaders["content-range"] = "bytes 262144-524287/1000000";
  xhr.send();
  xhr.dispatchEvent(new Event("loadend"));
  await harness.flushMessages();

  assert.equal(
    harness.emitted
      .slice(eventOffset)
      .some((message) => message.type === "PROBE_REFERENCE"),
    false
  );
});

test("an XHR network error still opens the media failure path", async () => {
  const harness = await createHarness(playurlPayload());
  await harness.setConfig(config(true));
  const stream = await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json())
    .then((body) => body.data.dash.video[0]);
  const eventOffset = harness.emitted.length;

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open("GET", stream.baseUrl);
  xhr.status = 0;
  xhr.send();
  xhr.dispatchEvent(new Event("error"));
  xhr.dispatchEvent(new Event("loadend"));

  const events = harness.emitted.slice(eventOffset);
  const degraded = events.find(
    (message) =>
      message.type === "MEDIA_DEGRADED" &&
      message.payload.reason === "network-failure"
  );
  const result = events.find(
    (message) => message.type === "MEDIA_REQUEST_RESULT"
  );
  assert.ok(degraded);
  assert.ok(result);
  assert.equal(
    degraded.payload.routingGeneration,
    result.payload.routingGeneration
  );
  assert.equal(
    degraded.payload.requestStartedAt,
    result.payload.requestStartedAt
  );
});

test("an unregistered recommendation media XHR stays native and silent", async () => {
  const harness = await createHarness(playurlPayload(), {
    pageUrl: "https://www.bilibili.com/video/BV1234567890"
  });
  await harness.setConfig(config(true));
  await harness.window
    .fetch(
      "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1234567890"
    )
    .then((response) => response.json());
  const eventOffset = harness.emitted.length;
  const recommendationUrl =
    "https://upos-sz-mirrorcosov.bilivideo.com/unregistered/recommendation.m4s?token=1";
  const xhr = new harness.window.XMLHttpRequest();
  xhr.open("GET", recommendationUrl);
  assert.equal(xhr.openedUrl, recommendationUrl);
  xhr.status = 0;
  xhr.send();
  xhr.dispatchEvent(new Event("error"));
  xhr.dispatchEvent(new Event("loadend"));

  const emittedTypes = harness.emitted
    .slice(eventOffset)
    .map((message) => message.type);
  assert.equal(emittedTypes.includes("MEDIA_DEGRADED"), false);
  assert.equal(emittedTypes.includes("MEDIA_REQUEST_RESULT"), false);
  assert.equal(emittedTypes.includes("MEDIA_HOST"), false);
  assert.equal(emittedTypes.includes("PROBE_REFERENCE"), false);
});

test("an exhausted route bypasses rewrite, probing, fallback, and XHR monitoring", async () => {
  const bvid = "BV1234567890";
  const presentationId = `bvid-${bvid}`;
  const routeKey = new URL(originalMedia).pathname;
  const harness = await createHarness(playurlPayload(), {
    pageUrl: `https://www.bilibili.com/video/${bvid}`
  });
  await harness.setConfig(config(true));
  await harness.window
    .fetch(`https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}`)
    .then((response) => response.json());
  harness.sendPrivate("ROUTE_NATIVE_BYPASS", {
    presentationId,
    routeKey,
    persistent: true
  });

  const eventOffset = harness.emitted.length;
  const native = await harness.window
    .fetch(`https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}`)
    .then((response) => response.json());
  assert.equal(native.data.dash.video[0].baseUrl, originalMedia);
  const originalDateNow = Date.now;
  try {
    const base = originalDateNow();
    Date.now = () => base + 5 * 60_000;
    const stillNative = await harness.window
      .fetch(`https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}`)
      .then((response) => response.json());
    assert.equal(stillNative.data.dash.video[0].baseUrl, originalMedia);
  } finally {
    Date.now = originalDateNow;
  }

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open("GET", originalMedia);
  assert.equal(xhr.openedUrl, originalMedia);
  xhr.status = 0;
  xhr.send();
  xhr.dispatchEvent(new Event("error"));
  xhr.dispatchEvent(new Event("loadend"));

  const emittedTypes = harness.emitted
    .slice(eventOffset)
    .map((message) => message.type);
  for (const type of [
    "MEDIA_DEGRADED",
    "MEDIA_REQUEST_RESULT",
    "MEDIA_HOST",
    "PROBE_URL",
    "PROBE_REFERENCE",
    "FALLBACK"
  ]) {
    assert.equal(emittedTypes.includes(type), false, type);
  }
});

test("disabling acceleration during a fetch fallback stops later route-state writes", async () => {
  let resolveMedia;
  const payload = playurlPayload();
  const harness = await createHarness(payload, {
    fetchImpl(input, playurlPayload) {
      const url = typeof input === "string" ? input : input.url;
      if (new URL(url).pathname.includes("/x/player/")) {
        return new Response(JSON.stringify(playurlPayload), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Promise((resolve) => {
        resolveMedia = resolve;
      });
    }
  });
  await harness.setConfig(config(true));
  const stream = await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json())
    .then((body) => body.data.dash.video[0]);
  const pending = harness.window.fetch(stream.baseUrl);
  await Promise.resolve();

  const disabled = config(true);
  disabled.settings.acceleration.enabled = false;
  const eventCount = harness.emitted.length;
  await harness.setConfig(disabled);
  resolveMedia(new Response(null, { status: 503 }));
  const response = await pending;

  assert.equal(response.status, 503);
  assert.equal(harness.emitted.length, eventCount);
});

test("history, sendBeacon, and global restore obey module settings", async () => {
  const harness = await createHarness(playurlPayload());
  await harness.setConfig(config(true));
  harness.history.replaceState({}, "", "?p=2&vd_source=secret");
  assert.equal(harness.location.search, "?p=2");
  assert.equal(
    harness.window.navigator.sendBeacon(
      "https://data.bilibili.com/log/web?event=play"
    ),
    true
  );
  assert.equal(harness.beaconCalls, 0);
  assert.equal(
    harness.window.navigator.sendBeacon(
      "https://data.bilibili.com/log/website?event=functional"
    ),
    true
  );
  assert.equal(harness.beaconCalls, 1);

  await harness.setConfig(config(false));
  assert.equal(harness.window.fetch, harness.originalFetch);
  assert.equal(
    harness.history.replaceState,
    harness.originalHistoryReplace
  );
});

test("global disable leaves a later third-party history wrapper intact and becomes pass-through", async () => {
  const harness = await createHarness(playurlPayload());
  await harness.setConfig(config(true));
  const extensionReplaceState = harness.history.replaceState;
  function thirdPartyReplaceState() {
    return extensionReplaceState.apply(this, arguments);
  }
  harness.history.replaceState = thirdPartyReplaceState;

  await harness.setConfig(config(false));
  assert.equal(harness.history.replaceState, thirdPartyReplaceState);
  harness.history.replaceState({}, "", "?p=8&vd_source=kept-when-disabled");
  assert.equal(
    harness.location.search,
    "?p=8&vd_source=kept-when-disabled"
  );
});

test("global disable removes own-property traces for originally inherited hooks", async () => {
  const harness = await createHarness(playurlPayload(), {
    inheritedHooks: true
  });
  await harness.setConfig(config(true));
  assert.equal(Object.hasOwn(harness.window, "fetch"), true);
  assert.equal(Object.hasOwn(harness.history, "replaceState"), true);
  assert.equal(Object.hasOwn(harness.window.navigator, "sendBeacon"), true);
  assert.equal(
    Object.hasOwn(harness.window.navigator.clipboard, "writeText"),
    true
  );

  await harness.setConfig(config(false));
  assert.equal(Object.hasOwn(harness.window, "fetch"), false);
  assert.equal(Object.hasOwn(harness.window, "open"), false);
  assert.equal(Object.hasOwn(harness.history, "pushState"), false);
  assert.equal(Object.hasOwn(harness.history, "replaceState"), false);
  assert.equal(Object.hasOwn(harness.window.navigator, "sendBeacon"), false);
  assert.equal(
    Object.hasOwn(harness.window.navigator.clipboard, "writeText"),
    false
  );
});

test("public CONFIG messages cannot change MAIN-world settings", async () => {
  const harness = await createHarness(playurlPayload());
  await harness.setConfig(config(true));
  harness.window.postMessage(
    {
      source: "bilibili-speedup",
      type: "CONFIG",
      payload: config(false)
    },
    harness.location.origin
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.history.replaceState({}, "", "?p=9&vd_source=still-cleaned");
  assert.equal(harness.location.search, "?p=9");
});

test("playurl streams with null backupUrl are still rewritten", async () => {
  const payload = playurlPayload();
  payload.data.dash.video[0].backupUrl = null;
  const harness = await createHarness(payload);
  await harness.setConfig(config(true));
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  const stream = (await response.json()).data.dash.video[0];
  assert.equal(
    new URL(stream.baseUrl).hostname,
    "upos-sz-mirrorcos.bilivideo.com"
  );
  assert.ok(Array.isArray(stream.backupUrl));
  assert.equal(stream.backupUrl.includes(originalMedia), false);
});

test("healthyHosts outside the Bilibili media surface are never used as rewrite targets", async () => {
  const harness = await createHarness(playurlPayload());
  const poisoned = config(true);
  poisoned.healthyHosts = [
    "evil.example.com",
    "upos-sz-mirrorcos.bilivideo.com"
  ];
  await harness.setConfig(poisoned);
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  const body = await response.json();
  const stream = body.data.dash.video[0];
  assert.equal(
    new URL(stream.baseUrl).hostname,
    "upos-sz-mirrorcos.bilivideo.com"
  );
  for (const url of [stream.baseUrl, ...stream.backupUrl]) {
    assert.notEqual(new URL(url).hostname, "evil.example.com");
  }
});

test("an unvalidated healthy host is never synthesized into a signed media URL", async () => {
  const harness = await createHarness(playurlPayload());
  const unvalidated = config(true);
  unvalidated.compatibleRoutes = {};
  await harness.setConfig(unvalidated);
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  const stream = (await response.json()).data.dash.video[0];
  assert.equal(stream.baseUrl, originalMedia);
  assert.equal(
    stream.backupUrl.some(
      (url) => new URL(url).hostname === "upos-sz-mirrorcos.bilivideo.com"
    ),
    false
  );
});

test("official backup keeps its own signature when a blocked base is reordered", async () => {
  const exactBackup =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=backup-signature&orderid=2";
  const payload = playurlPayload();
  payload.data.dash.video[0].backupUrl = [exactBackup];
  const harness = await createHarness(payload);
  const exactOnly = config(true);
  exactOnly.compatibleRoutes = {};
  await harness.setConfig(exactOnly);
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  const stream = (await response.json()).data.dash.video[0];
  assert.equal(stream.baseUrl, exactBackup);
  assert.equal(new URL(stream.baseUrl).searchParams.get("hdnts"), "backup-signature");
  assert.equal(stream.backupUrl.includes(originalMedia), false);
});

test("legacy MP4 durl routes are rewritten only from validated exact candidates", async () => {
  const originalMp4 =
    "https://upos-sz-mirrorcosov.bilivideo.com/path/legacy.mp4?deadline=4&upsig=base";
  const validatedMp4 =
    "https://upos-sz-mirrorcos.bilivideo.com/path/legacy.mp4?deadline=4&upsig=base";
  const payload = {
    code: 0,
    data: {
      durl: [{ url: originalMp4, backup_url: [], size: 1024 }]
    }
  };
  const harness = await createHarness(payload);
  const nextConfig = config(true);
  nextConfig.compatibleRoutes["/path/legacy.mp4"] = [validatedMp4];
  await harness.setConfig(nextConfig);
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1&fnval=0"
  );
  const route = (await response.json()).data.durl[0];
  assert.equal(route.url, validatedMp4);
  assert.equal(route.backup_url.includes(originalMp4), false);
  assert.ok(
    harness.emitted.some(
      (message) =>
        message.type === "PROBE_URL" &&
        message.payload.mediaUrl.endsWith("upsig=base")
    )
  );
});

test("static blocked backups are skipped by fetch retry and used only as the final native escape", async () => {
  const exactBackup =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=official";
  const payload = playurlPayload();
  payload.data.dash.video[0].backupUrl = [
    "https://upos-sz-mirroraliov.bilivideo.com/path/video.m4s?deadline=1&gen=blocked",
    exactBackup
  ];
  const mediaCalls = [];
  const harness = await createHarness(payload, {
    fetchImpl(input, playurlPayload) {
      const url = typeof input === "string" ? input : input.url;
      if (new URL(url).pathname.includes("/x/player/")) {
        return new Response(JSON.stringify(playurlPayload), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      mediaCalls.push(url);
      if (url === exactBackup) {
        return new Response(new Uint8Array(32), { status: 206 });
      }
      return new Response(null, { status: 503 });
    }
  });
  await harness.setConfig(config(true));
  const stream = await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json())
    .then((body) => body.data.dash.video[0]);

  await harness.window.fetch(stream.baseUrl);

  assert.equal(mediaCalls.at(-1), exactBackup);
  assert.equal(
    mediaCalls.some((url) =>
      /^upos-.*ov\.bilivideo\.com$/.test(new URL(url).hostname)
    ),
    false
  );
});

test("50 concurrent failed segments stay within two attempts each and share failure transitions", async () => {
  const payload = playurlPayload();
  const mediaCalls = [];
  const harness = await createHarness(payload, {
    fetchImpl(input, playurlPayload) {
      const url = typeof input === "string" ? input : input.url;
      if (new URL(url).pathname.includes("/x/player/")) {
        return new Response(JSON.stringify(playurlPayload), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      mediaCalls.push(url);
      return new Response(null, { status: 503 });
    }
  });
  await harness.setConfig(config(true));
  const stream = await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json())
    .then((body) => body.data.dash.video[0]);

  const responses = await Promise.all(
    Array.from({ length: 50 }, () => harness.window.fetch(stream.baseUrl))
  );
  assert.ok(responses.every((response) => response.status === 503));
  assert.ok(mediaCalls.length <= 101);

  const degraded = harness.emitted.filter(
    (message) =>
      message.type === "MEDIA_DEGRADED" &&
      message.payload.reason === "http-failure"
  );
  const transitionKeys = degraded.map(
    (message) =>
      `${message.payload.presentationId}|${message.payload.routeKey}|${message.payload.host}`
  );
  assert.equal(new Set(transitionKeys).size, transitionKeys.length);
  assert.equal(
    degraded.filter(
      (message) =>
        message.payload.host === "upos-sz-mirrorcos.bilivideo.com"
    ).length,
    1
  );
});

test("route fallback permits at most two host changes in thirty seconds", async () => {
  const hosts = ["a", "b", "c", "d"].map(
    (name) => `upos-${name}.bilivideo.com`
  );
  const urls = hosts.map(
    (host, index) =>
      `https://${host}/path/switch-budget.m4s?token=${index}`
  );
  const payload = {
    code: 0,
    data: {
      dash: {
        video: [
          {
            baseUrl: urls[0],
            backupUrl: urls.slice(1),
            mimeType: "video/mp4"
          }
        ]
      }
    }
  };
  let phase = 1;
  const mediaCalls = [];
  const harness = await createHarness(payload, {
    fetchImpl(input, playurlPayload) {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("playurl")) {
        return new Response(JSON.stringify(playurlPayload), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      mediaCalls.push(new URL(url).hostname);
      const host = new URL(url).hostname;
      const healthy =
        (phase === 1 && host === hosts[0]) ||
        (phase === 2 && host === hosts[1]) ||
        (phase === 4 && host === hosts[2]) ||
        (phase === 5 && host === hosts[2]);
      return new Response(healthy ? new Uint8Array(32) : null, {
        status: healthy ? 206 : 503
      });
    }
  });
  const nextConfig = config(true);
  nextConfig.compatibleRoutes = {};
  await harness.setConfig(nextConfig);
  const stream = await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV-switch")
    .then((response) => response.json())
    .then((body) => body.data.dash.video[0]);

  await harness.window.fetch(stream.baseUrl);
  phase = 2;
  await harness.window.fetch(urls[0]);
  phase = 3;
  await harness.window.fetch(urls[1]);
  phase = 4;
  await harness.window.fetch(urls[1]);
  const beforeThirdSwitch = mediaCalls.length;
  phase = 5;
  await harness.window.fetch(urls[3]);

  assert.deepEqual(
    harness.emitted
      .filter((message) => message.type === "MEDIA_HOST")
      .map((message) => message.payload.host),
    hosts.slice(0, 3)
  );
  assert.deepEqual(mediaCalls.slice(beforeThirdSwitch), [hosts[2]]);
  assert.equal(mediaCalls.includes(hosts[3]), false);
});

test("XHR open reroutes a static blocked source before it has failed in the session", async () => {
  const harness = await createHarness(playurlPayload());
  await harness.setConfig(config(true));
  await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json());

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open("GET", originalMedia);

  assert.equal(
    new URL(xhr.openedUrl).hostname,
    "upos-sz-mirrorcos.bilivideo.com"
  );
});

test("XHR uses a response-provided static URL once when every ordinary exact route is degraded", async () => {
  const akamai =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=official";
  const payload = playurlPayload();
  payload.data.dash.video[0].backupUrl = [akamai];
  const harness = await createHarness(payload);
  const initial = config(true);
  initial.compatibleRoutes = {};
  await harness.setConfig(initial);
  const stream = await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json())
    .then((body) => body.data.dash.video[0]);
  assert.equal(new URL(stream.baseUrl).hostname, new URL(akamai).hostname);

  const degraded = {
    ...initial,
    degradedRoutes: {
      "bvid-BV1::/path/video.m4s": [
        new URL(originalMedia).hostname,
        new URL(akamai).hostname
      ]
    }
  };
  await harness.setConfig(degraded);

  const nativeEscape = new harness.window.XMLHttpRequest();
  nativeEscape.open("GET", akamai);
  assert.equal(
    new URL(nativeEscape.openedUrl).hostname,
    new URL(originalMedia).hostname
  );
  nativeEscape.status = 503;
  nativeEscape.send();
  nativeEscape.dispatchEvent(new Event("loadend"));

  const afterNativeFailures = new harness.window.XMLHttpRequest();
  afterNativeFailures.open("GET", akamai);
  assert.equal(
    new URL(afterNativeFailures.openedUrl).hostname,
    new URL(akamai).hostname
  );
});

test("a stalled response-provided native escape is locally suppressed immediately", async () => {
  const clock = createManualClock();
  const video = { currentTime: 0, buffered: { length: 0 } };
  const akamai =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=official";
  const payload = playurlPayload();
  payload.data.dash.video[0].backupUrl = [akamai];
  payload.data.dash.video[0].bandwidth = 20_000_000;
  const harness = await createHarness(payload, {
    video,
    performance: clock.performance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const initial = config(true);
  initial.compatibleRoutes = {};
  await harness.setConfig(initial);
  await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json());
  await harness.setConfig({
    ...initial,
    degradedRoutes: {
      "bvid-BV1::/path/video.m4s": [
        new URL(originalMedia).hostname,
        new URL(akamai).hostname
      ]
    }
  });

  const stalled = new harness.window.XMLHttpRequest();
  stalled.open("GET", akamai);
  assert.equal(new URL(stalled.openedUrl).hostname, new URL(originalMedia).hostname);
  stalled.status = 206;
  stalled.send();
  await clock.advanceTo(2000);
  assert.ok(
    harness.emitted.some(
      (message) =>
        message.type === "MEDIA_DEGRADED" &&
        message.payload.reason === "body-stalled"
    )
  );

  const next = new harness.window.XMLHttpRequest();
  next.open("GET", akamai);
  assert.equal(new URL(next.openedUrl).hostname, new URL(akamai).hostname);
  stalled.dispatchEvent(new Event("loadend"));
});

test("low-buffer XHR body throughput proactively degrades a slow HTTP 206 route", async () => {
  let now = 0;
  const video = {
    currentTime: 3,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 5
    }
  };
  const payload = playurlPayload();
  payload.data.dash.video[0].bandwidth = 1_000_000;
  const harness = await createHarness(payload, {
    video,
    performance: { now: () => now }
  });
  await harness.setConfig(config(true));
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  await response.json();

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open(
    "GET",
    "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3"
  );
  xhr.status = 206;
  xhr.send();
  now = 1600;
  const progress = new Event("progress");
  Object.defineProperty(progress, "loaded", { value: 10_000 });
  xhr.dispatchEvent(progress);
  now = 1700;
  const secondProgress = new Event("progress");
  Object.defineProperty(secondProgress, "loaded", { value: 11_000 });
  xhr.dispatchEvent(secondProgress);
  xhr.dispatchEvent(new Event("loadend"));

  const degraded = harness.emitted.find(
    (message) =>
      message.type === "MEDIA_DEGRADED" &&
      message.payload.reason === "slow-body"
  );
  assert.ok(degraded);
  assert.equal(degraded.payload.bufferAhead, 2);
  assert.ok(degraded.payload.throughputBps < degraded.payload.requiredBps);
  assert.equal(
    harness.emitted.filter(
      (message) =>
        message.type === "MEDIA_DEGRADED" &&
        message.payload.reason === "slow-body"
    ).length,
    1
  );
});

test("a near-complete Range tail is not misclassified as body-stalled", async () => {
  const clock = createManualClock();
  const video = {
    currentTime: 3,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 3
    }
  };
  const payload = playurlPayload();
  payload.data.dash.video[0].bandwidth = 20_000_000;
  const harness = await createHarness(payload, {
    video,
    performance: clock.performance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  await harness.setConfig(config(true));
  await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json());

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open(
    "GET",
    "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3"
  );
  xhr.status = 206;
  xhr.send();
  await clock.advanceTo(1000);
  const progress = new Event("progress");
  Object.defineProperty(progress, "loaded", { value: 2_205_173 });
  Object.defineProperty(progress, "total", { value: 2_307_698 });
  Object.defineProperty(progress, "lengthComputable", { value: true });
  xhr.dispatchEvent(progress);
  await clock.advanceTo(3000);

  assert.equal(
    harness.emitted.some(
      (message) =>
        message.type === "MEDIA_DEGRADED" &&
        message.payload.reason === "body-stalled"
    ),
    false
  );
  xhr.dispatchEvent(new Event("loadend"));
});

test("a near-complete Range tail is not exempt from a persistent stall", async () => {
  const clock = createManualClock();
  const video = {
    currentTime: 3,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 3
    }
  };
  const payload = playurlPayload();
  payload.data.dash.video[0].bandwidth = 20_000_000;
  const harness = await createHarness(payload, {
    video,
    performance: clock.performance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  await harness.setConfig(config(true));
  await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json());

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open(
    "GET",
    "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3"
  );
  xhr.status = 206;
  xhr.send();
  await clock.advanceTo(1000);
  const progress = new Event("progress");
  Object.defineProperty(progress, "loaded", { value: 2_205_173 });
  Object.defineProperty(progress, "total", { value: 2_307_698 });
  Object.defineProperty(progress, "lengthComputable", { value: true });
  xhr.dispatchEvent(progress);
  await clock.advanceTo(7000);

  assert.ok(
    harness.emitted.some(
      (message) =>
        message.type === "MEDIA_DEGRADED" &&
        message.payload.reason === "body-stalled"
    )
  );
  xhr.dispatchEvent(new Event("loadend"));
});

test("a stalled Range is spared when average throughput can finish within buffered playback", async () => {
  const clock = createManualClock();
  const video = {
    currentTime: 3,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 9
    }
  };
  const payload = playurlPayload();
  payload.data.dash.video[0].bandwidth = 20_000_000;
  const harness = await createHarness(payload, {
    video,
    performance: clock.performance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  await harness.setConfig(config(true));
  await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json());

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open(
    "GET",
    "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3"
  );
  xhr.status = 206;
  xhr.send();
  await clock.advanceTo(1000);
  const progress = new Event("progress");
  Object.defineProperty(progress, "loaded", { value: 4_000_000 });
  Object.defineProperty(progress, "total", { value: 10_000_000 });
  Object.defineProperty(progress, "lengthComputable", { value: true });
  xhr.dispatchEvent(progress);
  await clock.advanceTo(3000);

  assert.equal(
    harness.emitted.some(
      (message) =>
        message.type === "MEDIA_DEGRADED" &&
        message.payload.reason === "body-stalled"
    ),
    false
  );
  xhr.dispatchEvent(new Event("loadend"));
});

test("a partially downloaded large Range is stalled after two seconds without new bytes", async () => {
  const clock = createManualClock();
  const video = {
    currentTime: 3,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 5
    }
  };
  const payload = playurlPayload();
  payload.data.dash.video[0].bandwidth = 20_000_000;
  const harness = await createHarness(payload, {
    video,
    performance: clock.performance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  await harness.setConfig(config(true));
  await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json());

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open(
    "GET",
    "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3"
  );
  xhr.status = 206;
  xhr.send();
  await clock.advanceTo(1000);
  const progress = new Event("progress");
  Object.defineProperty(progress, "loaded", { value: 11_000_000 });
  Object.defineProperty(progress, "total", { value: 19_000_000 });
  Object.defineProperty(progress, "lengthComputable", { value: true });
  xhr.dispatchEvent(progress);
  await clock.advanceTo(3000);

  const stalled = harness.emitted.find(
    (message) =>
      message.type === "MEDIA_DEGRADED" &&
      message.payload.reason === "body-stalled"
  );
  assert.ok(stalled);
  assert.equal(stalled.payload.bytes, 11_000_000);
  assert.equal(stalled.payload.expectedBytes, 19_000_000);
  assert.equal(stalled.payload.progressAgeMs, 2000);
  xhr.dispatchEvent(new Event("loadend"));
});

test("a well-buffered second player cannot hide the stalled request's buffer", async () => {
  let now = 0;
  const stalledVideo = {
    currentSrc:
      "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?token=a",
    src: "",
    currentTime: 3,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 3
    }
  };
  const bufferedVideo = {
    currentSrc:
      "https://upos-hz-mirrorakam.akamaized.net/path/other.m4s?token=b",
    src: "",
    currentTime: 3,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 103
    }
  };
  const payload = playurlPayload();
  payload.data.dash.video[0].bandwidth = 1_000_000;
  const harness = await createHarness(payload, {
    videos: [stalledVideo, bufferedVideo],
    performance: { now: () => now }
  });
  await harness.setConfig(config(true));
  await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json());

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open(
    "GET",
    "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3"
  );
  xhr.status = 206;
  xhr.send();
  now = 1600;
  const progress = new Event("progress");
  Object.defineProperty(progress, "loaded", { value: 10_000 });
  xhr.dispatchEvent(progress);

  const degraded = harness.emitted.find(
    (message) =>
      message.type === "MEDIA_DEGRADED" &&
      message.payload.reason === "slow-body"
  );
  assert.ok(degraded);
  assert.equal(degraded.payload.bufferAhead, 0);
});

test("same-host representation switches still report the active route key", async () => {
  const host = "upos-sz-mirrorcos.bilivideo.com";
  const payload = {
    code: 0,
    data: {
      dash: {
        video: [
          {
            baseUrl: `https://${host}/path/video.m4s?token=video`,
            backupUrl: [],
            mimeType: "video/mp4",
            bandwidth: 1_000_000
          }
        ],
        audio: [
          {
            baseUrl: `https://${host}/path/audio.m4s?token=audio`,
            backupUrl: [],
            mimeType: "audio/mp4",
            bandwidth: 128_000
          }
        ]
      }
    }
  };
  const harness = await createHarness(payload, {
    fetchImpl(input, playurlPayload) {
      const url = typeof input === "string" ? input : input.url;
      return url.includes("playurl")
        ? new Response(JSON.stringify(playurlPayload), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        : new Response(new Uint8Array(32), { status: 206 });
    }
  });
  await harness.setConfig(config(true));
  const playurl = await harness.window
    .fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1")
    .then((response) => response.json());
  await harness.window.fetch(playurl.data.dash.video[0].baseUrl);
  await harness.window.fetch(playurl.data.dash.audio[0].baseUrl);
  const routeKeys = harness.emitted
    .filter((message) => message.type === "MEDIA_HOST")
    .map((message) => message.payload.routeKey);
  assert.deepEqual(routeKeys, ["/path/video.m4s", "/path/audio.m4s"]);
  const mediaHosts = harness.emitted.filter(
    (message) => message.type === "MEDIA_HOST"
  );
  assert.deepEqual(
    mediaHosts.map((message) => message.payload.kind),
    ["video", "audio"]
  );
  assert.ok(
    mediaHosts.every(
      (message) => message.payload.presentationId === "bvid-BV1"
    )
  );
});

test("DASH probing reserves a slot for the representation selected by ABR", async () => {
  const makeStream = (kind, index) => ({
    baseUrl:
      `https://upos-sz-mirrorcosov.bilivideo.com/path/${kind}-${index}.m4s` +
      `?deadline=1&upsig=${kind}-${index}`,
    backupUrl: [
      `https://upos-hz-mirrorakam.akamaized.net/path/${kind}-${index}.m4s` +
        `?deadline=1&upsig=${kind}-${index}`
    ],
    mimeType: `${kind}/mp4`,
    bandwidth: 500_000 + index
  });
  const payload = {
    code: 0,
    data: {
      dash: {
        video: Array.from({ length: 5 }, (_, index) =>
          makeStream("video", index)
        ),
        audio: Array.from({ length: 2 }, (_, index) =>
          makeStream("audio", index)
        )
      }
    }
  };
  const harness = await createHarness(payload);
  const nextConfig = config(true);
  nextConfig.compatibleRoutes = {};
  await harness.setConfig(nextConfig);
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  const playurl = await response.json();
  let probes = harness.emitted.filter(
    (message) => message.type === "PROBE_URL"
  );
  assert.equal(probes.length, 1);
  assert.match(probes[0].payload.mediaUrl, /video-0\.m4s/);

  await harness.window.fetch(playurl.data.dash.video[4].baseUrl);
  probes = harness.emitted.filter(
    (message) => message.type === "PROBE_URL"
  );
  assert.equal(probes.length, 2);
  assert.match(probes[1].payload.mediaUrl, /video-4\.m4s/);
  assert.equal(probes[1].payload.presentationId, "bvid-BV1");
  assert.equal(probes[1].payload.kind, "video");
  assert.equal(probes[1].payload.routeKey, "/path/video-4.m4s");
});

test("same-path presentations retain independent probe identities", async () => {
  const payload = playurlPayload();
  payload.data.dash.video[0].backupUrl = [
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?deadline=1&gen=playurlv3"
  ];
  const harness = await createHarness(payload);
  const nextConfig = config(true);
  nextConfig.compatibleRoutes = {};
  await harness.setConfig(nextConfig);

  for (const bvid of ["BV1111111111", "BV2222222222"]) {
    const response = await harness.window.fetch(
      `https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}`
    );
    await response.json();
  }

  const probes = harness.emitted.filter(
    (message) => message.type === "PROBE_URL"
  );
  assert.deepEqual(
    probes.map((message) => message.payload.presentationId),
    ["bvid-BV1111111111", "bvid-BV2222222222"]
  );
  assert.ok(
    probes.every(
      (message) => message.payload.routeKey === "/path/video.m4s"
    )
  );
});

test("the same representation may probe a newly observed exact host once", async () => {
  const akamai =
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=akamai";
  const bda =
    "https://upos-sz-upcdnbda2.bilivideo.com/path/video.m4s?deadline=1&upsig=bda";
  const payload = playurlPayload();
  payload.data.dash.video[0].backupUrl = [akamai, bda];
  const harness = await createHarness(payload);
  const nextConfig = config(true);
  nextConfig.compatibleRoutes = {};
  await harness.setConfig(nextConfig);

  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  await response.json();
  await harness.window.fetch(bda);
  await harness.window.fetch(bda);
  const probes = harness.emitted.filter(
    (message) => message.type === "PROBE_URL"
  );

  assert.deepEqual(
    probes.map((message) => new URL(message.payload.mediaUrl).hostname),
    [
      "upos-hz-mirrorakam.akamaized.net",
      "upos-sz-upcdnbda2.bilivideo.com"
    ]
  );
});

test("an empty player buffer treats two seconds without body bytes as a stall", async () => {
  const timers = [];
  const video = {
    currentTime: 0,
    buffered: { length: 0 }
  };
  const payload = playurlPayload();
  payload.data.dash.video[0].bandwidth = 800_000;
  const harness = await createHarness(payload, {
    video,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {}
  });
  await harness.setConfig(config(true));
  const response = await harness.window.fetch(
    "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1"
  );
  await response.json();

  const xhr = new harness.window.XMLHttpRequest();
  xhr.open(
    "GET",
    "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3"
  );
  xhr.status = 206;
  xhr.send();
  const stallTimer = timers.find((timer) => timer.delay === 2000);
  assert.ok(stallTimer);
  stallTimer.callback();
  xhr.dispatchEvent(new Event("loadend"));
  assert.ok(
    harness.emitted.some(
      (message) =>
        message.type === "MEDIA_DEGRADED" &&
        message.payload.reason === "body-stalled" &&
        message.payload.bufferAhead === 0
    )
  );
});
