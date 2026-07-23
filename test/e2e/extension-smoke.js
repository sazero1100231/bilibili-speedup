import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const root = process.argv.includes("--release")
  ? path.join(projectRoot, "release")
  : process.env.EXTENSION_PATH
    ? path.resolve(process.env.EXTENSION_PATH)
    : projectRoot;
const browserCandidates = [
  process.env.BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "Google\\Chrome\\Application\\chrome.exe"
  )
].filter(Boolean);
const browserPath = browserCandidates.find(existsSync);

if (!browserPath) {
  throw new Error(
    "No Edge/Chrome executable found. Set BROWSER_PATH to run the extension smoke test."
  );
}
if (typeof WebSocket !== "function") {
  throw new Error("Node.js 22+ with the global WebSocket API is required.");
}

const profile = mkdtempSync(path.join(tmpdir(), "bili-oversea-e2e-"));
const stderr = [];
let browser;
let browserCdp;
let workerCdp;
let pageCdp;
let localServer;
let localPort;
const MEDIA_FIXTURE_BODY_BASE64 = Buffer.alloc(262144, 7).toString("base64");
const HOST_RESOLVER_RULES =
  "MAP www.bilibili.com 127.0.0.1, MAP search.bilibili.com 127.0.0.1, MAP upos-hz-mirrorakam.akamaized.net 127.0.0.1, MAP upos-sz-mirrorcos.bilivideo.com 127.0.0.1, MAP upos-sz-mirrorcosb.bilivideo.com 127.0.0.1, MAP upos-sz-mirrorbos.bilivideo.com 127.0.0.1, MAP upos-sz-mirrorhw.bilivideo.com 127.0.0.1, MAP upos-sz-mirrorali.bilivideo.com 127.0.0.1, MAP upos-sz-upcdnws.bilivideo.com 127.0.0.1, MAP upos-sz-upcdnbda2.bilivideo.com 127.0.0.1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, {
  timeoutMs = 15000,
  intervalMs = 100,
  label = "condition"
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`
  );
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.contextId = undefined;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        for (const entry of this.listeners.get(message.method) ?? []) {
          if (
            entry.sessionId === undefined ||
            entry.sessionId === message.sessionId
          ) {
            entry.listener(message.params);
          }
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error(`Cannot connect to ${url}`)),
        { once: true }
      );
    });
    return new CdpClient(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {})
        })
      );
    });
  }

  on(method, listener, sessionId) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push({ listener, sessionId });
    this.listeners.set(method, listeners);
  }

  async evaluate(expression, contextId = this.contextId) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId ? { contextId } : {})
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text
      );
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

class CdpSession {
  constructor(parent, sessionId) {
    this.parent = parent;
    this.sessionId = sessionId;
    this.contextId = undefined;
  }

  send(method, params = {}) {
    return this.parent.send(method, params, this.sessionId);
  }

  on(method, listener) {
    this.parent.on(method, listener, this.sessionId);
  }

  async evaluate(expression, contextId = this.contextId) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId ? { contextId } : {})
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text
      );
    }
    return response.result.value;
  }

  close() {}
}

class PipeCdpClient {
  constructor(child) {
    this.input = child.stdio[3];
    this.output = child.stdio[4];
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.buffer = "";
    this.output.on("data", (chunk) => {
      this.buffer += String(chunk);
      while (this.buffer.includes("\0")) {
        const end = this.buffer.indexOf("\0");
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!raw) {
          continue;
        }
        const message = JSON.parse(raw);
        if (!message.id) {
          for (const entry of this.listeners.get(message.method) ?? []) {
            if (
              entry.sessionId === undefined ||
              entry.sessionId === message.sessionId
            ) {
              entry.listener(message.params);
            }
          }
          continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
          continue;
        }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    });
    child.once("exit", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Browser pipe closed"));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP pipe command timed out: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(
        `${JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {})
        })}\0`
      );
    });
  }

  on(method, listener, sessionId) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push({ listener, sessionId });
    this.listeners.set(method, listeners);
  }

  close() {}
}

function stableBrowserArgs(headful) {
  return [
    ...(headful
      ? ["--start-minimized", "--window-position=-32000,-32000"]
      : ["--headless=new"]),
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-gpu-sandbox",
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--remote-allow-origins=*",
    "--enable-automation",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking"
  ];
}

async function installUnpackedWithPipe(headful) {
  const child = spawn(
    browserPath,
    [
      ...stableBrowserArgs(headful),
      `--user-data-dir=${profile}`,
      `--host-resolver-rules=${HOST_RESOLVER_RULES}`,
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "about:blank"
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
    }
  );
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.join("").length > 20000) {
      stderr.splice(0, stderr.length - 5);
    }
  });
  const pipe = new PipeCdpClient(child);
  try {
    const loaded = await pipe.send("Extensions.loadUnpacked", {
      path: root,
      enableInIncognito: false
    });
    assert.match(loaded.id, /^[a-p]{32}$/);
    console.log(`[e2e] unpacked extension installed: ${loaded.id}`);
    return { id: loaded.id, child, client: pipe };
  } catch (error) {
    if (child.exitCode === null) {
      child.kill();
    }
    throw error;
  }
}

async function targetInfos(client) {
  const { targetInfos: infos } = await client.send("Target.getTargets");
  return infos.map((target) => ({
    ...target,
    id: target.targetId
  }));
}

async function extensionState(client) {
  return client.evaluate(`(async () => ({
    api: {
      runtime: typeof chrome.runtime,
      storage: typeof chrome.storage,
      scripting: typeof chrome.scripting,
      declarativeNetRequest: typeof chrome.declarativeNetRequest
    },
    rules: chrome.declarativeNetRequest
      ? (await chrome.declarativeNetRequest.getDynamicRules()).map(rule => rule.id)
      : [],
    sessionRules: chrome.declarativeNetRequest
      ? (await chrome.declarativeNetRequest.getSessionRules()).map(rule => rule.id)
      : [],
    scripts: chrome.scripting
      ? (await chrome.scripting.getRegisteredContentScripts()).map(script => script.id).sort()
      : [],
    settings: chrome.storage
      ? (await chrome.storage.local.get("settings")).settings
      : undefined
  }))()`);
}

async function navigateAndCheck(client, url, expectedTitle, selector) {
  await client.send("Page.navigate", { url });
  return waitFor(
    async () => {
      const result = await client.evaluate(`({
        title: document.title,
        ready: document.readyState,
        found: Boolean(document.querySelector(${JSON.stringify(selector)}))
      })`);
      return result.ready !== "loading" &&
        result.title.includes(expectedTitle) &&
        result.found
        ? result
        : null;
    },
    { label: `${expectedTitle} UI` }
  );
}

try {
  const headful = process.env.E2E_HEADFUL === "1";
  const bootstrap = await installUnpackedWithPipe(headful);
  const bootstrappedExtensionId = bootstrap.id;
  browser = bootstrap.child;
  browserCdp = bootstrap.client;
  localServer = createHttpServer((_request, response) => {
    const requestUrl = new URL(_request.url, "http://www.bilibili.com");
    if (requestUrl.pathname === "/x/player/wbi/playurl") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      const payload =
        requestUrl.searchParams.get("fnval") === "0"
          ? {
              code: 0,
              data: {
                durl: [
                  {
                    url:
                      "https://upos-sz-mirrorcosov.bilivideo.com/path/legacy.mp4?deadline=2&upsig=legacy-base",
                    backup_url: [
                      "https://upos-hz-mirrorakam.akamaized.net/path/legacy.mp4?hdnts=legacy-backup"
                    ],
                    size: 262144
                  }
                ]
              }
            }
          : {
              code: 0,
              data: {
                dash: {
                  video: [
                    {
                      baseUrl:
                        "https://upos-sz-mirrorcos.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3",
                      backupUrl: [
                        "https://upos-sz-mirroraliov.bilivideo.com/path/video.m4s?deadline=1&gen=playurlv3",
                        "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?deadline=1&gen=playurlv3"
                      ],
                      mimeType: "video/mp4",
                      bandwidth: 1_000_000
                    }
                  ]
                }
              }
            };
      response.end(JSON.stringify(payload));
      return;
    }
    if (
      requestUrl.pathname === "/path/video.m4s" ||
      requestUrl.pathname === "/path/legacy.mp4"
    ) {
      const body = Buffer.alloc(262144, 7);
      response.writeHead(206, {
        "content-type": "video/mp4",
        "content-length": String(body.length),
        "content-range": `bytes 0-${body.length - 1}/${body.length}`,
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*",
        "cache-control": "no-store"
      });
      response.end(body);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(`<!doctype html>
      <html>
        <head><title>Bilibili local fixture</title></head>
        <body>
          <a id="tracking-link" href="/video/BVNEXT?p=2&vd_source=anchor-secret&spm_id_from=333">next</a>
          <article id="ad-card" class="bili-video-card"><span data-ad-report="1">ad</span></article>
        </body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", () => {
      localPort = localServer.address().port;
      resolve();
    });
  });
  console.log("[e2e] main browser connected");
  const extensionControlTarget = await browserCdp.send("Target.createTarget", {
    url: `chrome-extension://${bootstrappedExtensionId}/src/ui/popup.html`
  });

  const extensionPageTarget = await waitFor(
    async () =>
      (await targetInfos(browserCdp)).find(
        (target) =>
          target.id === extensionControlTarget.targetId &&
          target.type === "page" &&
          target.url.startsWith(
            `chrome-extension://${bootstrappedExtensionId}/`
          )
      ),
    { label: "extension control page" }
  );
  const workerTarget = await waitFor(
    async () =>
      (await targetInfos(browserCdp)).find(
        (target) =>
          target.type === "service_worker" &&
          target.url.includes("/src/background/service-worker.js")
      ),
    { label: "extension service worker", timeoutMs: 3000 }
  ).catch(() => null);
  const extensionId = bootstrappedExtensionId;
  if (workerTarget) {
    assert.ok(workerTarget.url.startsWith(`chrome-extension://${extensionId}/`));
  }
  const controlTarget = workerTarget ?? extensionPageTarget;
  const controlAttachment = await browserCdp.send("Target.attachToTarget", {
    targetId: controlTarget.id,
    flatten: true
  });
  workerCdp = new CdpSession(browserCdp, controlAttachment.sessionId);
  console.log(`[e2e] extension control target connected (${controlTarget.type})`);
  const workerContexts = [];
  const workerLogs = [];
  workerCdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
    workerLogs.push(
      `${type}: ${args
        .map((argument) => argument.value ?? argument.description ?? "")
        .join(" ")}`
    );
  });
  workerCdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    workerLogs.push(
      `exception: ${
        exceptionDetails.exception?.description ?? exceptionDetails.text
      }`
    );
  });
  workerCdp.on("Runtime.executionContextCreated", ({ context }) => {
    workerContexts.push(context);
  });
  await workerCdp.send("Runtime.enable");
  await waitFor(
    async () => {
      const api = await workerCdp
        .evaluate(`({
          runtime: typeof chrome.runtime,
          storage: typeof chrome.storage,
          scripting: typeof chrome.scripting,
          declarativeNetRequest: typeof chrome.declarativeNetRequest
        })`)
        .catch(() => null);
      return api?.runtime === "object" &&
        api.storage === "object" &&
        api.scripting === "object" &&
        api.declarativeNetRequest === "object";
    },
    { label: "extension control execution context" }
  );
  console.log("[e2e] extension control context ready");
  const apiState = await extensionState(workerCdp);
  assert.deepEqual(apiState.api, {
    runtime: "object",
    storage: "object",
    scripting: "object",
    declarativeNetRequest: "object"
  });

  await workerCdp.evaluate(`(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings) {
      await chrome.storage.local.set({
        settings: { ...settings, globalEnabled: !settings.globalEnabled }
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      await chrome.storage.local.set({ settings });
    }
    return Boolean(settings);
  })()`);
  let initialState;
  try {
    initialState = await waitFor(
      async () => {
        const state = await extensionState(workerCdp);
        return state.rules.length > 0 && state.scripts.length === 2
          ? state
          : null;
      },
      { label: "initial dynamic rules and content scripts" }
    );
  } catch (error) {
    const state = await extensionState(workerCdp).catch(() => null);
    throw new Error(
      `${error.message}\nState: ${JSON.stringify(state)}\nWorker logs:\n${workerLogs.join("\n")}`
    );
  }
  assert.deepEqual(initialState.rules, [
    1001,
    1002,
    2001,
    2002,
    2003
  ]);
  console.log("[e2e] extension rules and content scripts ready");
  assert.deepEqual(initialState.scripts, [
    "bili-oversea-bridge",
    "bili-oversea-main"
  ]);
  await workerCdp.evaluate(`(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    settings.acceleration.strategy = "manual";
    settings.acceleration.manualHost = "upos-sz-mirrorcos.bilivideo.com";
    await chrome.storage.local.set({ settings });
    return true;
  })()`);
  await waitFor(
    async () => {
      const state = await extensionState(workerCdp);
      return state.rules.length === 5 && state.sessionRules.length === 0
        ? state
        : null;
    },
    { label: "manual strategy keeps global media DNR disabled" }
  );

  const pageTarget = (await targetInfos(browserCdp)).find(
    (target) => target.type === "page" && target.url === "about:blank"
  );
  assert.ok(pageTarget, "No browser page target available");
  const pageAttachment = await browserCdp.send("Target.attachToTarget", {
    targetId: pageTarget.id,
    flatten: true
  });
  pageCdp = new CdpSession(browserCdp, pageAttachment.sessionId);
  await pageCdp.send("Page.enable");
  await pageCdp.send("Runtime.enable");
  pageCdp.on("Fetch.requestPaused", ({ requestId }) => {
    void pageCdp.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 206,
      responsePhrase: "Partial Content",
      responseHeaders: [
        { name: "Content-Type", value: "video/mp4" },
        { name: "Content-Length", value: "262144" },
        { name: "Content-Range", value: "bytes 0-262143/262144" },
        { name: "Accept-Ranges", value: "bytes" },
        { name: "Access-Control-Allow-Origin", value: "*" },
        { name: "Cache-Control", value: "no-store" }
      ],
      body: MEDIA_FIXTURE_BODY_BASE64
    }).catch(() => {});
  });
  await pageCdp.send("Fetch.enable", {
    patterns: [
      {
        urlPattern: "https://upos-hz-mirrorakam.akamaized.net*",
        requestStage: "Request"
      }
    ]
  });

  const base = `chrome-extension://${extensionId}/src/ui`;
  await navigateAndCheck(
    pageCdp,
    `${base}/popup.html`,
    "Bili 海外加速",
    "#globalEnabled"
  );
  await navigateAndCheck(
    pageCdp,
    `${base}/options.html`,
    "設定",
    "#endpointList"
  );
  await navigateAndCheck(
    pageCdp,
    `${base}/diagnostics.html`,
    "診斷",
    "#probeRows"
  );

  const fixtureUrl = `http://www.bilibili.com:${localPort}/video/BVTEST?p=1&vd_source=main-frame-secret&spm_id_from=333`;
  await pageCdp.send("Page.navigate", { url: fixtureUrl });
  const pageSnapshotExpression = `({
    ready: document.readyState,
    title: document.title,
    href: location.href,
    fetchName: fetch.name,
    replaceStateName: history.replaceState.name,
    anchor: document.querySelector("#tracking-link")?.href ?? "",
    adDisplay: document.querySelector("#ad-card")
      ? getComputedStyle(document.querySelector("#ad-card")).display
      : "",
    bodyText: document.body?.innerText?.slice(0, 500) ?? ""
  })`;
  let enabledPage;
  try {
    enabledPage = await waitFor(
      async () => {
        const result = await pageCdp.evaluate(pageSnapshotExpression);
        return result.ready !== "loading" &&
          !result.anchor.includes("vd_source") &&
          result.adDisplay === "none"
          ? result
          : null;
      },
      { label: "enabled Bilibili page modules" }
    );
  } catch (error) {
    // Chromium can occasionally complete the first navigation before a
    // freshly registered persistent content script is attached. One reload
    // is a bounded startup retry; a second miss is still a hard failure.
    await pageCdp.send("Page.reload", { ignoreCache: true });
    try {
      enabledPage = await waitFor(
        async () => {
          const result = await pageCdp.evaluate(pageSnapshotExpression);
          return result.ready !== "loading" &&
            !result.anchor.includes("vd_source") &&
            result.adDisplay === "none"
            ? result
            : null;
        },
        { label: "enabled Bilibili page modules after startup reload" }
      );
    } catch (retryError) {
      const pageState = await pageCdp.evaluate(pageSnapshotExpression);
      throw new Error(
        `${retryError.message}\nInitial error: ${error.message}` +
          `\nPage state: ${JSON.stringify(pageState)}` +
          `\nWorker logs:\n${workerLogs.join("\n")}`
      );
    }
  }
  assert.equal(enabledPage.href.includes("vd_source"), false);
  assert.equal(enabledPage.href.includes("spm_id_from"), false);
  assert.equal(enabledPage.href.includes("p=1"), true);
  assert.equal(enabledPage.anchor.includes("p=2"), true);
  const behaviorResult = await pageCdp.evaluate(`(async () => {
    history.replaceState({}, "", "?p=3&vd_source=spa-secret");
    const beaconResult = navigator.sendBeacon(
      "https://data.bilibili.com/log/web?event=fixture"
    );
    const body = await fetch(
      location.origin + "/x/player/wbi/playurl?bvid=BVFIXTURE"
    ).then(response => response.json());
    const legacy = await fetch(
      location.origin + "/x/player/wbi/playurl?bvid=BVFIXTURE&fnval=0"
    ).then(response => response.json());
    return {
      href: location.href,
      beaconResult,
      stream: body.data.dash.video[0],
      legacy: legacy.data.durl[0]
    };
  })()`);
  assert.equal(behaviorResult.href.includes("vd_source"), false);
  assert.equal(behaviorResult.href.includes("p=3"), true);
  assert.equal(behaviorResult.beaconResult, true);
  assert.equal(
    new URL(behaviorResult.stream.baseUrl).hostname,
    "upos-sz-mirrorcos.bilivideo.com"
  );
  assert.ok(
    behaviorResult.stream.backupUrl.some(
      (url) => new URL(url).hostname === "upos-hz-mirrorakam.akamaized.net"
    )
  );
  assert.equal(
    new URL(behaviorResult.legacy.url).hostname,
    "upos-hz-mirrorakam.akamaized.net"
  );
  assert.equal(
    new URL(behaviorResult.legacy.url).searchParams.get("hdnts"),
    "legacy-backup"
  );
  const fallbackResult = await pageCdp.evaluate(`(async () => {
    const startedAt = performance.now();
    const response = await fetch(${JSON.stringify(
      behaviorResult.stream.baseUrl
    )});
    const body = await response.arrayBuffer();
    return {
      status: response.status,
      bytes: body.byteLength,
      elapsedMs: performance.now() - startedAt,
      responseUrl: response.url
    };
  })()`);
  assert.equal(fallbackResult.status, 206);
  assert.equal(fallbackResult.bytes, 262144);
  assert.ok(
    fallbackResult.elapsedMs <= 5000,
    `Fallback took ${fallbackResult.elapsedMs}ms`
  );
  assert.equal(
    new URL(fallbackResult.responseUrl).hostname,
    "upos-hz-mirrorakam.akamaized.net"
  );
  let sessionRuleEvidence;
  try {
    sessionRuleEvidence = await waitFor(
      () =>
        workerCdp.evaluate(`(async () => {
          const rules = await chrome.declarativeNetRequest.getSessionRules();
          return rules.find(rule =>
            rule.id >= 4000000 &&
            rule.condition.tabIds?.length === 1 &&
            rule.action.redirect?.url?.includes("hdnts") === false &&
            rule.action.redirect?.url?.includes("upos-hz-mirrorakam.akamaized.net")
          ) ?? null;
        })()`),
      { label: "tab-scoped exact-URL session fallback rule" }
    );
  } catch (error) {
    const evidence = await workerCdp.evaluate(`(async () => {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      const { diagnostics } = await chrome.storage.local.get("diagnostics");
      return {
        rules,
        latestSession: [...(diagnostics?.sessions ?? [])].at(-1) ?? null
      };
    })()`);
    throw new Error(
      `${error.message}\nSession-rule evidence: ${JSON.stringify(evidence)}` +
        `\nWorker logs:\n${workerLogs.join("\n")}`
    );
  }
  assert.equal(sessionRuleEvidence.condition.tabIds.length, 1);
  const fallbackDiagnostic = await waitFor(
    () =>
      workerCdp.evaluate(`(async () => {
        const { diagnostics } = await chrome.storage.local.get("diagnostics");
        return [...(diagnostics?.sessions ?? [])]
          .reverse()
          .find(session => session.fallbackCount > 0) ?? null;
      })()`),
    { label: "fallback diagnostic event" }
  );
  assert.ok(fallbackDiagnostic.fallbackCount > 0);
  assert.equal(
    fallbackDiagnostic.mediaHost,
    "upos-hz-mirrorakam.akamaized.net"
  );
  assert.equal(
    fallbackDiagnostic.plannedMediaHost,
    "upos-sz-mirrorcos.bilivideo.com"
  );

  const searchUrl = `http://search.bilibili.com:${localPort}/all?keyword=music&page=2&vd_source=search-secret`;
  await pageCdp.send("Page.navigate", { url: searchUrl });
  const searchPage = await waitFor(
    async () => {
      const page = await pageCdp.evaluate(`({
        ready: document.readyState,
        href: location.href
      })`);
      const state = await workerCdp.evaluate(`(async () => ({
        sessionRules: (await chrome.declarativeNetRequest.getSessionRules())
          .filter(rule => rule.id >= 4000000).length
      }))()`);
      return page.ready !== "loading" &&
        !page.href.includes("vd_source") &&
        state.sessionRules === 0
        ? { ...page, ...state }
        : null;
    },
    { label: "search page playback-state cleanup" }
  );
  assert.equal(searchPage.href.includes("page=2"), true);
  const searchPreviewResult = await pageCdp.evaluate(`(async () => {
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        fetch(
          location.origin +
            "/x/player/wbi/playurl?fnval=0&bvid=BVSEARCH" +
            index
        ).then(response => response.json())
      )
    );
    for (let index = 0; index < 50; index += 1) {
      const video = document.createElement("video");
      document.body.append(video);
      video.dispatchEvent(new Event("loadstart"));
      video.dispatchEvent(new Event("waiting"));
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    return {
      hosts: responses.map(
        body => new URL(body.data.durl[0].url).hostname
      )
    };
  })()`);
  assert.deepEqual(
    [...new Set(searchPreviewResult.hosts)],
    ["upos-sz-mirrorcosov.bilivideo.com"]
  );
  const searchIsolation = await workerCdp.evaluate(`(async () => {
    const sessionRules = (await chrome.declarativeNetRequest.getSessionRules())
      .filter(rule => rule.id >= 4000000);
    const { diagnostics } = await chrome.storage.local.get("diagnostics");
    return {
      sessionRuleCount: sessionRules.length,
      searchSessions: (diagnostics?.sessions ?? []).filter(
        session => String(session.pageUrl ?? "").includes(
          "search.bilibili.com"
        )
      ).length
    };
  })()`);
  assert.deepEqual(searchIsolation, {
    sessionRuleCount: 0,
    searchSessions: 0
  });

  await workerCdp.evaluate(`(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    settings.globalEnabled = false;
    await chrome.storage.local.set({ settings });
    return true;
  })()`);
  const disabledState = await waitFor(
    async () => {
      const state = await extensionState(workerCdp);
      return state.rules.length === 0 &&
        state.sessionRules.length === 0 &&
        state.scripts.length === 0
        ? state
        : null;
    },
    { label: "full disable reconciliation" }
  );
  assert.equal(disabledState.settings.globalEnabled, false);
  const disabledLiveExpression = `(async () => {
        history.replaceState({}, "", "?p=5&vd_source=after-disable");
        const body = await fetch(
          location.origin + "/x/player/wbi/playurl?bvid=BVFIXTURE"
        ).then(response => response.json());
        return {
          href: location.href,
          host: new URL(body.data.dash.video[0].baseUrl).hostname,
          adDisplay: document.querySelector("#ad-card")
            ? getComputedStyle(document.querySelector("#ad-card")).display
            : ""
        };
      })()`;
  let disabledLivePage;
  try {
    disabledLivePage = await waitFor(
      async () => {
        const result = await pageCdp.evaluate(disabledLiveExpression);
        return result.href.includes("vd_source=after-disable") &&
          result.host === "upos-sz-mirrorcos.bilivideo.com" &&
          result.adDisplay !== "none"
          ? result
          : null;
      },
      { label: "live page hook and CSS removal" }
    );
  } catch (error) {
    const pageState = await pageCdp.evaluate(disabledLiveExpression);
    const workerState = await extensionState(workerCdp);
    throw new Error(
      `${error.message}\nPage state: ${JSON.stringify(pageState)}\nWorker state: ${JSON.stringify(workerState)}\nWorker logs:\n${workerLogs.join("\n")}`
    );
  }
  assert.equal(
    disabledLivePage.host,
    "upos-sz-mirrorcos.bilivideo.com"
  );

  const disabledUrl = `http://www.bilibili.com:${localPort}/video/BVDISABLED?p=4&vd_source=disabled-secret`;
  await pageCdp.send("Page.navigate", { url: disabledUrl });
  const disabledPage = await waitFor(
    async () => {
      const result = await pageCdp.evaluate(`({
        ready: document.readyState,
        href: location.href,
        fetchName: fetch.name,
        anchor: document.querySelector("#tracking-link")?.href ?? "",
        adDisplay: document.querySelector("#ad-card")
          ? getComputedStyle(document.querySelector("#ad-card")).display
          : ""
      })`);
      return result.ready !== "loading" ? result : null;
    },
    { label: "disabled Bilibili page" }
  );
  assert.equal(disabledPage.href.includes("vd_source=disabled-secret"), true);
  assert.equal(disabledPage.anchor.includes("vd_source=anchor-secret"), true);
  assert.notEqual(disabledPage.adDisplay, "none");

  await workerCdp.evaluate(`(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    settings.globalEnabled = true;
    await chrome.storage.local.set({ settings });
    return true;
  })()`);
  const enabledAgain = await waitFor(
    async () => {
      const state = await extensionState(workerCdp);
      return state.rules.length === 5 &&
        state.sessionRules.length === 0 &&
        state.scripts.length === 2
        ? state
        : null;
    },
    { label: "re-enable reconciliation" }
  );
  assert.equal(enabledAgain.settings.globalEnabled, true);

  await pageCdp.send("Page.navigate", {
    url: `${base}/diagnostics.html`
  });
  const routeDiagnosticUi = await waitFor(
    async () => {
      const result = await pageCdp.evaluate(`({
        ready: document.readyState,
        text: document.querySelector("#metrics")?.textContent ?? "",
        routeRows: document.querySelectorAll("#routeRows tr").length,
        playerRows: document.querySelectorAll("#playerRows tr").length
      })`);
      return result.ready !== "loading" &&
        result.routeRows >= 1 &&
        result.playerRows >= 1 &&
        result.text.includes("DNR rules") &&
        result.text.includes("Probe in-flight") &&
        result.text.includes("規劃節點") &&
        result.text.includes("實際節點") &&
        result.text.includes("upos-sz-mirrorcos.bilivideo.com") &&
        result.text.includes("upos-hz-mirrorakam.akamaized.net")
        ? result
        : null;
    },
    { label: "planned-versus-actual route diagnostic UI" }
  );
  assert.ok(routeDiagnosticUi.text.includes("規劃節點"));

  console.log(
    `Loaded extension ${extensionId} in ${path.basename(browserPath)}; verified 5 global DNR rules plus tab-scoped media session rules, exact signed legacy MP4 backup, search-preview routing isolation, 2 content scripts, 3 UI pages, live URL/DOM/CSS hooks, ${Math.round(
      fallbackResult.elapsedMs
    )}ms blackhole fallback, full disable equivalence, and re-enable.`
  );
} catch (error) {
  const browserLog = stderr.join("").trim();
  if (browserLog) {
    console.error(browserLog.slice(-8000));
  }
  throw error;
} finally {
  pageCdp?.close();
  workerCdp?.close();
  if (browserCdp) {
    await browserCdp.send("Browser.close").catch(() => {});
    browserCdp.close();
  }
  if (browser && browser.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => browser.once("exit", resolve)),
      sleep(3000)
    ]);
    if (browser.exitCode === null) {
      browser.kill();
    }
  }
  if (localServer) {
    await new Promise((resolve) => localServer.close(resolve));
  }
  const expectedPrefix = path.join(tmpdir(), "bili-oversea-e2e-");
  if (profile.startsWith(expectedPrefix)) {
    try {
      rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      });
    } catch {
      // Windows may keep browser profile files locked briefly after Browser.close.
    }
  }
}
