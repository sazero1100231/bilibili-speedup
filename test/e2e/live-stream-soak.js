import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  contentIdentityFromUrl,
  evaluateLiveContentMatrix,
  normalizeLiveTargets
} from "../support/live-stream-matrix.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const extensionRoot = process.argv.includes("--release")
  ? path.join(projectRoot, "release")
  : projectRoot;
const browserCandidates = [
  process.env.BROWSER_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);
const browserPath = browserCandidates.find(existsSync);
const headful = process.env.E2E_HEADFUL === "1";
const durationSeconds = boundedNumber(
  process.env.BILIBILI_SOAK_SECONDS,
  1800,
  30,
  7200
);
const maxVideos = boundedNumber(
  process.env.BILIBILI_SOAK_MAX_VIDEOS,
  20,
  1,
  50
);
const sampleSeconds = boundedNumber(
  process.env.BILIBILI_SOAK_SAMPLE_SECONDS,
  5,
  2,
  30
);
const dwellSeconds = boundedNumber(
  process.env.BILIBILI_SOAK_DWELL_SECONDS,
  Math.max(15, Math.floor(durationSeconds / Math.max(1, maxVideos))),
  10,
  300
);
const requestedReportPath = process.env.BILIBILI_SOAK_REPORT;
const reportPath = requestedReportPath
  ? path.resolve(requestedReportPath)
  : path.join(
      projectRoot,
      "verification",
      `live-stream-soak-${new Date().toISOString().slice(0, 10)}.json`
    );
const initialBvids = (process.env.BILIBILI_SOAK_BVIDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => /^BV[0-9A-Za-z]{10}$/.test(value));
const targetMatrixFile = process.env.BILIBILI_SOAK_TARGETS_FILE?.trim();
const targetMatrixJson = process.env.BILIBILI_SOAK_TARGETS_JSON?.trim();
const hasExplicitTargetMatrix = Boolean(targetMatrixFile || targetMatrixJson);
if (!hasExplicitTargetMatrix && !initialBvids.length) {
  throw new Error(
    "Set BILIBILI_SOAK_BVIDS, BILIBILI_SOAK_TARGETS_FILE, or BILIBILI_SOAK_TARGETS_JSON."
  );
}
const targetMatrixInput = hasExplicitTargetMatrix
  ? JSON.parse(
      targetMatrixFile
        ? readFileSync(path.resolve(targetMatrixFile), "utf8")
        : targetMatrixJson
    )
  : initialBvids.map((bvid) => ({
      id: bvid,
      url: `https://www.bilibili.com/video/${bvid}/`,
      kind: "ugc",
      expectedTransport: "any",
      required: false
    }));
const initialTargets = normalizeLiveTargets(targetMatrixInput, maxVideos);
const requiredContentKinds = (
  process.env.BILIBILI_SOAK_REQUIRED_KINDS ??
  (hasExplicitTargetMatrix ? "" : "ugc")
)
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const requestedProfileDirectory =
  process.env.BILIBILI_SOAK_PROFILE_DIR?.trim();
const blockedPatterns = JSON.parse(
  readFileSync(path.join(projectRoot, "rules", "cdn-pool.json"), "utf8")
).blocked.map((entry) => new RegExp(entry.pattern, "i"));

if (!browserPath) {
  throw new Error("No Edge/Chrome executable found. Set BROWSER_PATH.");
}

function boundedNumber(input, fallback, minimum, maximum) {
  const parsed = Number(input);
  return Math.min(
    maximum,
    Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, {
  timeoutMs = 30000,
  intervalMs = 200,
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
      }, 30000);
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
}

class CdpSession {
  constructor(parent, sessionId) {
    this.parent = parent;
    this.sessionId = sessionId;
  }

  send(method, params = {}) {
    return this.parent.send(method, params, this.sessionId);
  }

  on(method, listener) {
    this.parent.on(method, listener, this.sessionId);
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text
      );
    }
    return response.result.value;
  }
}

async function targetInfos(client) {
  return (await client.send("Target.getTargets")).targetInfos;
}

function bvidFromUrl(rawUrl) {
  return String(rawUrl ?? "").match(/\/video\/(BV[0-9A-Za-z]{10})/i)?.[1] ?? "";
}

function sanitizedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function sanitizedRoutingApiUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const safe = new URL(`${url.origin}${url.pathname}`);
    for (const key of [
      "aid",
      "avid",
      "bvid",
      "cid",
      "ep_id",
      "epid",
      "season_id",
      "qn",
      "fnval",
      "fourk"
    ]) {
      if (url.searchParams.has(key)) {
        safe.searchParams.set(key, url.searchParams.get(key));
      }
    }
    return safe.href;
  } catch {
    return "";
  }
}

function sanitizedInitiator(initiator) {
  const frames = [];
  let stack = initiator?.stack;
  while (stack && frames.length < 8) {
    for (const frame of stack.callFrames ?? []) {
      const url = sanitizedUrl(frame?.url);
      if (url && frames.length < 8) {
        frames.push({
          functionName: String(frame?.functionName ?? "").slice(0, 120),
          url
        });
      }
    }
    stack = stack.parent;
  }
  return {
    type: String(initiator?.type ?? ""),
    url: sanitizedUrl(initiator?.url ?? ""),
    stackFrames: frames.filter(
      (frame, index) =>
        frames.findIndex(
          (candidate) =>
            candidate.functionName === frame.functionName &&
            candidate.url === frame.url
        ) === index
    )
  };
}

function shouldInspectApiResponse(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /\/(?:playurl|ogv\/cards|ads\/materials?|episode\/web\/info|ep\/list|ogv\/player\/pre\/check\/drm)(?:\/|$)/i.test(
      url.pathname
    );
  } catch {
    return false;
  }
}

function extractMediaEvidence(rawBody, base64Encoded = false) {
  let body = String(rawBody ?? "");
  if (base64Encoded) {
    body = Buffer.from(body, "base64").toString("utf8");
  }
  const inspectedBytes = Buffer.byteLength(body);
  if (inspectedBytes > 2_000_000) {
    return { inspectedBytes, skipped: "response exceeds 2 MB" };
  }
  const normalized = body
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/");
  const mediaIds = new Set();
  for (const match of normalized.matchAll(
    /\/upgcxcode\/\d+\/\d+\/(\d+)\//gi
  )) {
    mediaIds.add(match[1]);
  }
  const mediaUrls = new Set();
  for (const match of normalized.matchAll(
    /https?:\/\/[^"'\s<>\\]+?\.(?:m4s|mp4|flv)(?:\?[^"'\s<>\\]*)?/gi
  )) {
    const safeUrl = sanitizedUrl(match[0]);
    if (safeUrl) {
      mediaUrls.add(safeUrl);
    }
  }
  return {
    inspectedBytes,
    mediaIds: [...mediaIds].slice(0, 64),
    mediaUrls: [...mediaUrls].slice(0, 64)
  };
}

function extractStaticScriptMediaEvidence(rawBody, base64Encoded = false) {
  let body = String(rawBody ?? "");
  if (base64Encoded) {
    body = Buffer.from(body, "base64").toString("utf8");
  }
  const inspectedBytes = Buffer.byteLength(body);
  const normalized = body
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/");
  const mediaIds = new Set();
  for (const match of normalized.matchAll(
    /\/upgcxcode\/\d+\/\d+\/(\d+)\//gi
  )) {
    mediaIds.add(match[1]);
  }
  return {
    inspectedBytes,
    mediaIds: [...mediaIds].slice(0, 64)
  };
}

function maximum(samples, selector) {
  return samples.reduce(
    (current, sample) => Math.max(current, Number(selector(sample)) || 0),
    0
  );
}

function heapSlopeBytesPerMinute(samples) {
  const points = samples
    .map((sample) => ({
      x: (sample.at - samples[0].at) / 60000,
      y: Number(sample.heapUsedBytes)
    }))
    .filter((point) => Number.isFinite(point.y));
  if (points.length < 2) {
    return null;
  }
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce(
    (sum, point) => sum + (point.x - meanX) * (point.y - meanY),
    0
  );
  const denominator = points.reduce(
    (sum, point) => sum + (point.x - meanX) ** 2,
    0
  );
  return denominator ? Math.round(numerator / denominator) : null;
}

function findAbaOscillations(sessions) {
  const findings = [];
  for (const session of sessions) {
    const events = [
      ...(session.criticalEvents ?? []),
      ...(session.recentEvents ?? [])
    ]
      .filter((event) => event.type === "route-switch" && event.host)
      .sort((left, right) => left.at - right.at);
    const byRoute = Map.groupBy(
      events,
      (event) => event.routeKey ?? event.detail ?? "unassigned"
    );
    for (const [routeKey, routeEvents] of byRoute) {
      for (let index = 2; index < routeEvents.length; index += 1) {
        const first = routeEvents[index - 2];
        const middle = routeEvents[index - 1];
        const last = routeEvents[index];
        if (
          first.host === last.host &&
          first.host !== middle.host &&
          last.at - first.at <= 30000
        ) {
          findings.push({
            sessionId: session.id,
            routeKey,
            hosts: [first.host, middle.host, last.host],
            windowMs: last.at - first.at
          });
        }
      }
    }
  }
  return findings;
}

function isMediaUrl(rawUrl) {
  try {
    return /\.(?:m4s|mp4|flv)$/i.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

const ownsProfile = !requestedProfileDirectory;
const profile = ownsProfile
  ? mkdtempSync(path.join(tmpdir(), "bili-live-soak-"))
  : path.resolve(requestedProfileDirectory);
if (!ownsProfile && !existsSync(profile)) {
  throw new Error(
    `BILIBILI_SOAK_PROFILE_DIR does not exist: ${profile}. Use a dedicated, inactive browser profile directory.`
  );
}
const stderr = [];
const pageErrors = [];
const mediaRequests = [];
const routingApiRequests = [];
const apiRequests = [];
const playerCoreRequests = [];
const pendingApiResponseCaptures = new Set();
const visits = [];
const samples = [];
const seekResults = [];
const qualityAttempts = [];
const navigationEvents = { full: 0, spa: 0 };
let verifiedSpaNavigations = 0;
let browser;
let client;
let control;
let page;
let pageTargetId;
let extensionId = "";
let finalDiagnostics = { sessions: [] };
let cleanupEvidence = null;
let pageEmbeddedMediaEvidence = {};
let runError = "";
let activeTargetId = "";
let activeTargetKind = "";
const startedAt = Date.now();

try {
  browser = spawn(
    browserPath,
    [
      ...(headful
        ? [
            "--window-position=-32000,-32000",
            "--window-size=1280,900",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding"
          ]
        : [
            "--headless=new",
            "--disable-gpu",
            "--disable-gpu-compositing",
            "--disable-gpu-sandbox",
            "--use-gl=angle",
            "--use-angle=swiftshader"
          ]),
      "--no-sandbox",
      "--remote-allow-origins=*",
      "--enable-automation",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--autoplay-policy=no-user-gesture-required",
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "about:blank"
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
    }
  );
  browser.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    while (stderr.join("").length > 30000) {
      stderr.shift();
    }
  });
  client = new PipeCdpClient(browser);
  const loaded = await client.send("Extensions.loadUnpacked", {
    path: extensionRoot,
    enableInIncognito: false
  });
  extensionId = loaded.id;
  assert.match(extensionId, /^[a-p]{32}$/);

  const controlTarget = await client.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/src/ui/diagnostics.html`
  });
  const controlAttachment = await client.send("Target.attachToTarget", {
    targetId: controlTarget.targetId,
    flatten: true
  });
  control = new CdpSession(client, controlAttachment.sessionId);
  await control.send("Runtime.enable");
  await waitFor(
    () =>
      control.evaluate(
        `typeof chrome.storage === "object" &&
         typeof chrome.declarativeNetRequest === "object"`
      ),
    { label: "extension control APIs" }
  );
  await control.evaluate(`(() => {
    globalThis.__biliSoakWrites = 0;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.diagnostics) {
        globalThis.__biliSoakWrites += 1;
      }
    });
    return true;
  })()`);

  const pageTarget = (await targetInfos(client)).find(
    (target) => target.type === "page" && target.url === "about:blank"
  );
  assert.ok(pageTarget, "No about:blank page target");
  pageTargetId = pageTarget.targetId;
  const pageAttachment = await client.send("Target.attachToTarget", {
    targetId: pageTargetId,
    flatten: true
  });
  page = new CdpSession(client, pageAttachment.sessionId);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Performance.enable");
  await page.send("Page.bringToFront").catch(() => {});
  await page
    .send("Emulation.setFocusEmulationEnabled", { enabled: true })
    .catch(() => {});
  await page
    .send("Page.setWebLifecycleState", { state: "active" })
    .catch(() => {});
  page.on("Page.frameNavigated", ({ frame }) => {
    if (!frame.parentId) {
      navigationEvents.full += 1;
    }
  });
  page.on("Page.navigatedWithinDocument", () => {
    navigationEvents.spa += 1;
  });
  page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    pageErrors.push(
      String(
        exceptionDetails.exception?.description ?? exceptionDetails.text ?? ""
      ).slice(0, 500)
    );
  });
  page.on(
    "Network.requestWillBeSent",
    ({ requestId, request, type, initiator, documentURL }) => {
      const requestUrl = new URL(request.url);
      if (
        type === "Script" &&
        requestUrl.hostname === "s1.hdslb.com" &&
        /\/bfs\/static\/player\/main\/core\.[a-z0-9]+\.js$/i.test(
          requestUrl.pathname
        )
      ) {
        playerCoreRequests.push({
          requestId,
          at: Date.now(),
          url: sanitizedUrl(request.url),
          status: 0,
          failed: false
        });
      }
      if (
        ["Fetch", "XHR"].includes(type) &&
        requestUrl.hostname.endsWith(".bilibili.com") &&
        !isMediaUrl(request.url) &&
        apiRequests.length < 512
      ) {
        apiRequests.push({
          requestId,
          at: Date.now(),
          targetId: activeTargetId,
          targetKind: activeTargetKind,
          type,
          url: sanitizedRoutingApiUrl(request.url),
          documentUrl: sanitizedUrl(documentURL),
          initiator: sanitizedInitiator(initiator),
          status: 0,
          failed: false
        });
      }
      if (
        /\/(?:x\/player|pgc\/player|pugv\/player)\/.*playurl/i.test(
          requestUrl.pathname
        ) ||
        requestUrl.pathname.includes("/ogv/player/pre/check/drm")
      ) {
        routingApiRequests.push({
          requestId,
          at: Date.now(),
          targetId: activeTargetId,
          targetKind: activeTargetKind,
          type,
          url: sanitizedRoutingApiUrl(request.url),
          documentUrl: sanitizedUrl(documentURL),
          initiator: sanitizedInitiator(initiator),
          status: 0,
          failed: false
        });
      }
    if (!isMediaUrl(request.url)) {
      return;
    }
    const url = new URL(request.url);
    mediaRequests.push({
      requestId,
      at: Date.now(),
      targetId: activeTargetId,
      targetKind: activeTargetKind,
      type,
      host: url.hostname,
      url: sanitizedUrl(request.url),
      blockedCatalogMatch: blockedPatterns.some((pattern) =>
        pattern.test(url.hostname)
      ),
      status: 0,
          failed: false,
          documentUrl: sanitizedUrl(documentURL),
          initiator: sanitizedInitiator(initiator),
          range: String(request.headers?.Range ?? request.headers?.range ?? "")
            .slice(0, 120)
        });
    }
  );
  page.on("Network.responseReceived", ({ requestId, response }) => {
    const request = [...mediaRequests]
      .reverse()
      .find((entry) => entry.requestId === requestId);
    if (request) {
      request.status = response.status;
      request.responseHost = new URL(response.url).hostname;
      request.contentRange = String(
        response.headers?.["content-range"] ??
          response.headers?.["Content-Range"] ??
          ""
      ).slice(0, 160);
    }
    const routingRequest = [...routingApiRequests]
      .reverse()
      .find((entry) => entry.requestId === requestId);
    if (routingRequest) {
      routingRequest.status = response.status;
      routingRequest.responseUrl = sanitizedRoutingApiUrl(response.url);
    }
    const apiRequest = [...apiRequests]
      .reverse()
      .find((entry) => entry.requestId === requestId);
    if (apiRequest) {
      apiRequest.status = response.status;
      apiRequest.responseUrl = sanitizedRoutingApiUrl(response.url);
      apiRequest.mimeType = String(response.mimeType ?? "");
    }
    const playerCoreRequest = [...playerCoreRequests]
      .reverse()
      .find((entry) => entry.requestId === requestId);
    if (playerCoreRequest) {
      playerCoreRequest.status = response.status;
      playerCoreRequest.mimeType = String(response.mimeType ?? "");
    }
  });
  page.on(
    "Network.loadingFinished",
    ({ requestId, encodedDataLength, shouldReportCorbBlocking }) => {
      const mediaRequest = [...mediaRequests]
        .reverse()
        .find((entry) => entry.requestId === requestId);
      if (mediaRequest) {
        mediaRequest.encodedDataLength = Math.max(
          0,
          Number(encodedDataLength) || 0
        );
        mediaRequest.corbBlocked = Boolean(shouldReportCorbBlocking);
      }
      const playerCoreRequest = [...playerCoreRequests]
        .reverse()
        .find((entry) => entry.requestId === requestId);
      if (
        playerCoreRequest &&
        playerCoreRequest.status >= 200 &&
        playerCoreRequest.status < 300
      ) {
        const capture = page
          .send("Network.getResponseBody", { requestId })
          .then(({ body, base64Encoded }) => {
            playerCoreRequest.responseEvidence =
              extractStaticScriptMediaEvidence(body, base64Encoded);
          })
          .catch((error) => {
            playerCoreRequest.responseEvidence = {
              error: String(
                error instanceof Error ? error.message : error
              ).slice(0, 200)
            };
          })
          .finally(() => pendingApiResponseCaptures.delete(capture));
        pendingApiResponseCaptures.add(capture);
      }
    const apiRequest = [...apiRequests]
      .reverse()
      .find((entry) => entry.requestId === requestId);
    if (
      !apiRequest ||
      apiRequest.status < 200 ||
      apiRequest.status >= 300 ||
      !shouldInspectApiResponse(apiRequest.url)
    ) {
      return;
    }
    const capture = page
      .send("Network.getResponseBody", { requestId })
      .then(({ body, base64Encoded }) => {
        apiRequest.responseEvidence = extractMediaEvidence(body, base64Encoded);
      })
      .catch((error) => {
        apiRequest.responseEvidence = {
          error: String(error instanceof Error ? error.message : error).slice(
            0,
            200
          )
        };
      })
      .finally(() => pendingApiResponseCaptures.delete(capture));
    pendingApiResponseCaptures.add(capture);
    }
  );
  page.on("Network.loadingFailed", ({ requestId, errorText }) => {
    const request = [...mediaRequests]
      .reverse()
      .find((entry) => entry.requestId === requestId);
    if (request) {
      request.failed = true;
      request.error = String(errorText).slice(0, 200);
    }
    const routingRequest = [...routingApiRequests]
      .reverse()
      .find((entry) => entry.requestId === requestId);
    if (routingRequest) {
      routingRequest.failed = true;
      routingRequest.error = String(errorText).slice(0, 200);
    }
    const apiRequest = [...apiRequests]
      .reverse()
      .find((entry) => entry.requestId === requestId);
    if (apiRequest) {
      apiRequest.failed = true;
      apiRequest.error = String(errorText).slice(0, 200);
    }
    const playerCoreRequest = [...playerCoreRequests]
      .reverse()
      .find((entry) => entry.requestId === requestId);
    if (playerCoreRequest) {
      playerCoreRequest.failed = true;
      playerCoreRequest.error = String(errorText).slice(0, 200);
    }
  });

  const queue = [...initialTargets];
  const discoveredBvids = new Set(
    queue.map((target) => target.bvid).filter(Boolean)
  );
  const deadline = startedAt + durationSeconds * 1000;
  let queueIndex = 0;

  async function controlSnapshot() {
    return control.evaluate(`(async () => {
      const { diagnostics } = await chrome.storage.local.get("diagnostics");
      const sessions = diagnostics?.sessions ?? [];
      const latest = sessions.at(-1) ?? null;
      return {
        diagnosticsBytes: new TextEncoder().encode(
          JSON.stringify({ sessions })
        ).byteLength,
        diagnosticSessions: sessions.length,
        diagnosticWrites: globalThis.__biliSoakWrites ?? 0,
        dynamicRules: (await chrome.declarativeNetRequest.getDynamicRules()).length,
        sessionRules: (await chrome.declarativeNetRequest.getSessionRules()).length,
        latestResourceStats: latest?.resourceStats ?? null
      };
    })()`);
  }

  async function pageSnapshot() {
    const state = await page
      .evaluate(`(() => {
        const videos = [...document.querySelectorAll("video")];
        const score = candidate =>
          (candidate.currentSrc ? 1000 : 0) +
          candidate.readyState * 100 +
          candidate.buffered.length * 10 +
          (candidate.currentTime > 0 ? 5 : 0) +
          (!candidate.paused ? 1 : 0);
        const video = videos
          .filter(candidate => !candidate.error)
          .sort((left, right) => score(right) - score(left))[0] ?? videos[0];
        let bufferAhead = 0;
        if (video) {
          for (let index = 0; index < video.buffered.length; index += 1) {
            if (
              video.buffered.start(index) <= video.currentTime &&
              video.currentTime <= video.buffered.end(index)
            ) {
              bufferAhead = Math.max(
                bufferAhead,
                video.buffered.end(index) - video.currentTime
              );
            }
          }
        }
        return {
          url: location.origin + location.pathname,
          bvid: location.pathname.match(/\\/video\\/(BV[0-9A-Za-z]{10})/i)?.[1] ?? "",
          title: document.title.slice(0, 200),
          visibilityState: document.visibilityState,
          hasFocus: document.hasFocus(),
          videoCandidates: videos.slice(0, 4).map(candidate => ({
            currentSrc: candidate.currentSrc
              ? candidate.currentSrc.split("?")[0].slice(0, 500)
              : "",
            currentTime: candidate.currentTime,
            readyState: candidate.readyState,
            paused: candidate.paused,
            errorCode: candidate.error?.code ?? 0
          })),
          video: video
            ? {
                currentTime: video.currentTime,
                duration: Number.isFinite(video.duration) ? video.duration : null,
                bufferAhead,
                paused: video.paused,
                seeking: video.seeking,
                readyState: video.readyState,
                networkState: video.networkState,
                errorCode: video.error?.code ?? 0
              }
            : null
        };
      })()`)
      .catch(() => null);
    const metrics = await page.send("Performance.getMetrics").catch(() => ({
      metrics: []
    }));
    const metric = (name) =>
      metrics.metrics.find((entry) => entry.name === name)?.value ?? null;
    return {
      ...state,
      heapUsedBytes: metric("JSHeapUsedSize"),
      heapTotalBytes: metric("JSHeapTotalSize"),
      domNodes: metric("Nodes"),
      documents: metric("Documents")
    };
  }

  async function addRecommendations() {
    const hrefs = await page
      .evaluate(`(() =>
        [...document.querySelectorAll('a[href*="/video/BV"]')]
          .map(anchor => anchor.href)
          .filter(Boolean)
          .slice(0, 80)
      )()`)
      .catch(() => []);
    for (const href of hrefs) {
      const bvid = bvidFromUrl(href);
      if (
        bvid &&
        !discoveredBvids.has(bvid) &&
        discoveredBvids.size < maxVideos
      ) {
        discoveredBvids.add(bvid);
        queue.push(
          normalizeLiveTargets(
            [
              {
                id: `discovered-${bvid}`,
                url: `https://www.bilibili.com/video/${bvid}/`,
                kind: "ugc",
                expectedTransport: "any",
                required: false
              }
            ],
            1
          )[0]
        );
      }
    }
  }

  async function openVideo(preferredBvid, preferSpa) {
    if (preferSpa) {
      const clickedPart = await page
        .evaluate(`(() => {
          const current = location.pathname.match(/\\/video\\/(BV[0-9A-Za-z]{10})/i)?.[1] ?? "";
          const anchors = [...document.querySelectorAll('a[href*="/video/BV"]')];
          const currentPart = new URL(location.href).searchParams.get("p") ?? "1";
          const anchor = anchors.find(candidate => {
            const url = new URL(candidate.href, location.href);
            return (
              candidate.href.includes("/video/" + current) &&
              url.searchParams.has("p") &&
              url.searchParams.get("p") !== currentPart
            );
          });
          if (anchor) {
            const href = anchor.href;
            anchor.click();
            return {
              mode: "part-url",
              bvid: current,
              href,
              token: new URL(href, location.href).searchParams.get("p") ?? ""
            };
          }
          const items = [
            ...document.querySelectorAll(".video-pod__item[data-key]")
          ];
          const item = items.find(candidate =>
            !candidate.classList.contains("active")
          );
          const token = item?.getAttribute("data-key") ?? "";
          if (!item || !token) return null;
          item.click();
          return {
            mode: "part-control",
            bvid: current,
            href: location.href,
            token
          };
        })()`)
        .catch(() => null);
      if (clickedPart?.bvid && clickedPart.token) {
        const reached = await waitFor(
          () =>
            page
              .evaluate(
                `(() => {
                  const url = new URL(location.href);
                  if (!url.pathname.includes(${JSON.stringify(
                    `/video/${clickedPart.bvid}`
                  )})) return false;
                  if (${JSON.stringify(clickedPart.mode)} === "part-url") {
                    return url.searchParams.get("p") === ${JSON.stringify(
                      clickedPart.token
                    )};
                  }
                  const active = document.querySelector(
                    ".video-pod__item.active[data-key]"
                  );
                  return active?.getAttribute("data-key") === ${JSON.stringify(
                    clickedPart.token
                  )};
                })()`
              )
              .catch(() => false),
          {
            timeoutMs: 30000,
            label: `${clickedPart.bvid} verified part control`
          }
        ).catch(() => false);
        if (reached) {
          verifiedSpaNavigations += 1;
          return {
            bvid: clickedPart.bvid,
            consumedRequested: false
          };
        }
      }
    }
    await page.send("Page.navigate", {
      url: `https://www.bilibili.com/video/${preferredBvid}/`
    });
    await waitFor(
      () =>
        page
          .evaluate(
            `location.pathname.includes(${JSON.stringify(
              `/video/${preferredBvid}`
            )}) && document.readyState !== "loading"`
          )
          .catch(() => false),
      { timeoutMs: 30000, label: `${preferredBvid} page` }
    );
    return { bvid: preferredBvid, consumedRequested: true };
  }

  async function openTarget(target, preferSpa) {
    if (target.bvid) {
      const opened = await openVideo(target.bvid, preferSpa);
      const actualTarget =
        queue.find((candidate) => candidate.bvid === opened.bvid) ?? target;
      return {
        target: actualTarget,
        bvid: opened.bvid,
        contentId: opened.bvid,
        consumedRequested: opened.consumedRequested
      };
    }
    await page.send("Page.navigate", { url: target.url });
    await waitFor(
      async () => {
        const href = await page.evaluate("location.href").catch(() => "");
        return (
          contentIdentityFromUrl(href).contentId === target.contentId &&
          (await page
            .evaluate('document.readyState !== "loading"')
            .catch(() => false))
        );
      },
      { timeoutMs: 30000, label: `${target.id} page` }
    );
    return {
      target,
      bvid: "",
      contentId: target.contentId,
      consumedRequested: true
    };
  }

  async function authenticationStatus() {
    return page
      .evaluate(`(async () => {
        try {
          const response = await fetch(
            "https://api.bilibili.com/x/web-interface/nav",
            { credentials: "include" }
          );
          const payload = await response.json();
          return payload?.data?.isLogin === true;
        } catch {
          return null;
        }
      })()`)
      .catch(() => null);
  }

  while (Date.now() < deadline) {
    const requestedTarget = queue[queueIndex % queue.length];
    const requestedBvid = requestedTarget.bvid;
    const preferSpa =
      Boolean(requestedBvid) && visits.length > 0 && visits.length % 3 === 0;
    const fullBefore = navigationEvents.full;
    const spaBefore = navigationEvents.spa;
    const visitStartedAt = Date.now();
    let actualBvid = requestedBvid;
    let actualTarget = requestedTarget;
    let actualContentId = requestedTarget.contentId;
    let consumedRequested = true;
    let visitError = "";
    let videoFound = false;
    let authenticated = null;
    activeTargetId = requestedTarget.id;
    activeTargetKind = requestedTarget.kind;
    try {
      const opened = await openTarget(requestedTarget, preferSpa);
      actualBvid = opened.bvid;
      actualTarget = opened.target;
      actualContentId = opened.contentId;
      consumedRequested = opened.consumedRequested;
      activeTargetId = actualTarget.id;
      activeTargetKind = actualTarget.kind;
      await waitFor(
        () =>
          page
            .evaluate(`Boolean(document.querySelector("video"))`)
            .catch(() => false),
        { timeoutMs: 30000, label: `${actualContentId} video element` }
      );
      videoFound = true;
      authenticated = await authenticationStatus();
      await page.evaluate(`(async () => {
        const videos = [...document.querySelectorAll("video")];
        const score = candidate =>
          (candidate.currentSrc ? 1000 : 0) +
          candidate.readyState * 100 +
          candidate.buffered.length * 10 +
          (candidate.currentTime > 0 ? 5 : 0);
        const video = videos
          .filter(candidate => !candidate.error)
          .sort((left, right) => score(right) - score(left))[0] ?? videos[0];
        await video?.play().catch(() => {});
        return Boolean(video);
      })()`);
      await addRecommendations();
    } catch (error) {
      visitError = error instanceof Error ? error.message : String(error);
    }

    const visit = {
      targetId: actualTarget.id,
      targetKind: actualTarget.kind,
      requestedTargetId: requestedTarget.id,
      requestedUrl: requestedTarget.url,
      requestedBvid,
      bvid: actualBvid,
      contentId: actualContentId,
      authenticated,
      startedAt: visitStartedAt,
      navigationIntent: preferSpa ? "site_link_click" : "direct",
      navigationObserved:
        navigationEvents.spa > spaBefore
          ? "within_document"
          : navigationEvents.full > fullBefore
            ? "full"
            : "unknown",
      videoFound,
      readyAt: videoFound ? Date.now() : null,
      seekAttempted: false,
      qualityAttempted: false,
      error: visitError
    };
    visits.push(visit);
    if (actualBvid) {
      discoveredBvids.add(actualBvid);
    }
    const visitDeadline = Math.min(
      deadline,
      (visit.readyAt ?? Date.now()) + dwellSeconds * 1000
    );
    while (videoFound && Date.now() < visitDeadline) {
      const elapsed = Date.now() - (visit.readyAt ?? visitStartedAt);
      if (!visit.seekAttempted && elapsed >= (dwellSeconds * 1000) / 3) {
        visit.seekAttempted = true;
        const seek = await page
          .evaluate(`(async () => {
            const videos = [...document.querySelectorAll("video")];
            const score = candidate =>
              (candidate.currentSrc ? 1000 : 0) +
              candidate.readyState * 100 +
              candidate.buffered.length * 10 +
              (candidate.currentTime > 0 ? 5 : 0);
            const video = videos
              .filter(candidate => !candidate.error)
              .sort((left, right) => score(right) - score(left))[0] ?? videos[0];
            const player = globalThis.player;
            if (!video && typeof player?.seek !== "function") return null;
            const playerTime =
              typeof player?.getCurrentTime === "function"
                ? Number(player.getCurrentTime())
                : NaN;
            const from = Number.isFinite(playerTime)
              ? playerTime
              : Number(video?.currentTime) || 0;
            const playerDuration =
              typeof player?.getDuration === "function"
                ? Number(player.getDuration())
                : NaN;
            const duration = Number.isFinite(playerDuration)
              ? playerDuration
              : video?.duration;
            const target = Math.min(
              from + 15,
              Number.isFinite(duration)
                ? Math.max(from, duration - 2)
                : from + 15
            );
            try {
              let method = "video.currentTime";
              if (typeof player?.seek === "function") {
                player.seek(target);
                method = "player.seek";
              } else {
                video.currentTime = target;
              }
              if (typeof player?.play === "function") {
                player.play();
              } else {
                await video?.play().catch(() => {});
              }
              return { from, target, method, error: "" };
            } catch (error) {
              return {
                from,
                target,
                error: error instanceof Error ? error.message : String(error)
              };
            }
          })()`)
          .catch(() => null);
        const seekStartedAt = Date.now();
        const recovered = seek
          ? await waitFor(
              () =>
                page
                  .evaluate(`(() => {
                    const videos = [...document.querySelectorAll("video")];
                    const score = candidate =>
                      (candidate.currentSrc ? 1000 : 0) +
                      candidate.readyState * 100 +
                      candidate.buffered.length * 10 +
                      (candidate.currentTime > 0 ? 5 : 0);
                    const video = videos
                      .filter(candidate => !candidate.error)
                      .sort((left, right) => score(right) - score(left))[0] ?? videos[0];
                    const player = globalThis.player;
                    const playerTime =
                      typeof player?.getCurrentTime === "function"
                        ? Number(player.getCurrentTime())
                        : NaN;
                    const currentTime = Number.isFinite(playerTime)
                      ? playerTime
                      : Number(video?.currentTime) || 0;
                    return Boolean(
                      (video || player) &&
                      !video?.error &&
                      !video?.seeking &&
                      currentTime >= ${JSON.stringify(seek.target - 0.5)}
                    );
                  })()`)
                  .catch(() => false),
              { timeoutMs: 5000, intervalMs: 250, label: "seek recovery" }
            ).catch(() => false)
          : false;
        seekResults.push({
          targetId: actualTarget.id,
          targetKind: actualTarget.kind,
          bvid: actualBvid,
          contentId: actualContentId,
          ...seek,
          recovered: Boolean(recovered),
          recoveryMs: Date.now() - seekStartedAt
        });
      }
      const elapsedAfterSeek =
        Date.now() - (visit.readyAt ?? visitStartedAt);
      if (
        !visit.qualityAttempted &&
        elapsedAfterSeek >= (dwellSeconds * 2000) / 3
      ) {
        visit.qualityAttempted = true;
        qualityAttempts.push(
          await page
            .evaluate(`(async () => {
              const player = globalThis.player;
              const before =
                typeof player?.getQuality === "function"
                  ? player.getQuality()
                  : null;
              const current =
                typeof before === "number"
                  ? before
                  : Number(before?.realQ ?? before?.nowQ) || 0;
              const qualityListMethods = [
                "getSupportedQualityList",
                "getQualityList",
                "getAvailableQualityList",
                "getAvailableQuality"
              ];
              const available = [];
              for (const method of qualityListMethods) {
                if (typeof player?.[method] !== "function") continue;
                try {
                  const candidate = await Promise.resolve(player[method]());
                  const items = Array.isArray(candidate)
                    ? candidate
                    : Array.isArray(candidate?.accept_quality)
                      ? candidate.accept_quality
                      : [];
                  for (const item of items) {
                    const value = Number(
                      typeof item === "object"
                        ? item?.qn ?? item?.quality ?? item?.value
                        : item
                    );
                    if (Number.isFinite(value) && !available.includes(value)) {
                      available.push(value);
                    }
                  }
                } catch {
                  // Optional player API; fall through to the conservative pair.
                }
              }
              const target =
                available
                  .filter(value => value !== current)
                  .sort(
                    (left, right) =>
                      Math.abs(left - current) - Math.abs(right - current)
                  )[0] ??
                (current >= 32 ? 16 : 32);
              try {
                if (typeof player?.requestQuality === "function") {
                  // Some Bilibili player builds return a promise that stays
                  // pending even though the quality transition proceeds. The
                  // observable contract is realQ/nowQ, so trigger once and
                  // poll that state instead of awaiting an advisory return.
                  player.requestQuality(target);
                  let after = null;
                  for (let attempt = 0; attempt < 20; attempt += 1) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                    after =
                      typeof player.getQuality === "function"
                        ? player.getQuality()
                        : null;
                    const observed =
                      typeof after === "number"
                        ? after
                        : Number(after?.realQ ?? after?.nowQ) || 0;
                    if (observed !== current) break;
                  }
                  const afterCurrent =
                    typeof after === "number"
                      ? after
                      : Number(after?.realQ ?? after?.nowQ) || 0;
                  return {
                    method: "requestQuality",
                    before,
                    after,
                    available,
                    target,
                    invoked: true,
                    changed: afterCurrent !== current
                  };
                }
                if (typeof player?.setQuality === "function") {
                  player.setQuality(target);
                  let after = null;
                  for (let attempt = 0; attempt < 20; attempt += 1) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                    after =
                      typeof player.getQuality === "function"
                        ? player.getQuality()
                        : null;
                    const observed =
                      typeof after === "number"
                        ? after
                        : Number(after?.realQ ?? after?.nowQ) || 0;
                    if (observed !== current) break;
                  }
                  const afterCurrent =
                    typeof after === "number"
                      ? after
                      : Number(after?.realQ ?? after?.nowQ) || 0;
                  return {
                    method: "setQuality",
                    before,
                    after,
                    available,
                    target,
                    invoked: true,
                    changed: afterCurrent !== current
                  };
                }
              } catch (error) {
                return {
                  method: "error",
                  before,
                  available,
                  target,
                  invoked: false,
                  error: error instanceof Error ? error.message : String(error)
                };
              }
              return {
                method: "unavailable",
                before,
                available,
                target,
                invoked: false
              };
            })()`)
            .then((result) => ({
              targetId: actualTarget.id,
              targetKind: actualTarget.kind,
              bvid: actualBvid,
              contentId: actualContentId,
              ...result
            }))
            .catch((error) => ({
              targetId: actualTarget.id,
              targetKind: actualTarget.kind,
              bvid: actualBvid,
              contentId: actualContentId,
              method: "evaluation-error",
              invoked: false,
              error: error instanceof Error ? error.message : String(error)
            }))
        );
      }

      const [pageState, extensionState] = await Promise.all([
        pageSnapshot(),
        controlSnapshot()
      ]);
      samples.push({
        at: Date.now(),
        visit: visits.length,
        targetId: actualTarget.id,
        targetKind: actualTarget.kind,
        contentId: actualContentId,
        ...pageState,
        extension: extensionState
      });
      console.log(
        `[soak] ${Math.round((Date.now() - startedAt) / 1000)}/${durationSeconds}s ` +
          `${actualContentId}(${actualTarget.kind}) samples=${samples.length} routes=${
            extensionState.latestResourceStats?.routes ?? 0
          } rules=${extensionState.sessionRules}`
      );
      await sleep(
        Math.min(sampleSeconds * 1000, Math.max(0, visitDeadline - Date.now()))
      );
    }
    if (consumedRequested) {
      queueIndex += 1;
    }
  }

  await Promise.allSettled([...pendingApiResponseCaptures]);
  pageEmbeddedMediaEvidence = await page.evaluate(`(() => {
    function evidence(value) {
      let text = "";
      try {
        text = typeof value === "string" ? value : JSON.stringify(value);
      } catch {
        return { serializedBytes: 0, mediaIds: [], serializationFailed: true };
      }
      text = String(text ?? "")
        .replace(/\\\\u002f/gi, "/")
        .replace(/\\\\\\//g, "/");
      const mediaIds = new Set();
      for (const match of text.matchAll(
        /\\/upgcxcode\\/\\d+\\/\\d+\\/(\\d+)\\//gi
      )) {
        mediaIds.add(match[1]);
      }
      return {
        serializedBytes: new TextEncoder().encode(text).length,
        mediaIds: [...mediaIds].slice(0, 64)
      };
    }
    return {
      playinfo: evidence(globalThis.__playinfo__),
      initialState: evidence(globalThis.__INITIAL_STATE__),
      inlineScripts: [...document.scripts]
        .map((script, index) => ({
          index,
          source: script.src
            ? (() => {
                try {
                  const url = new URL(script.src);
                  return url.origin + url.pathname;
                } catch {
                  return "";
                }
              })()
            : "",
          ...evidence(script.textContent)
        }))
        .filter(item => item.mediaIds.length)
    };
  })()`).catch((error) => ({
    error: String(error instanceof Error ? error.message : error).slice(0, 200)
  }));
  finalDiagnostics = await control.evaluate(`(async () => {
    const { diagnostics } = await chrome.storage.local.get("diagnostics");
    return diagnostics ?? { sessions: [] };
  })()`);
  const beforeClose = await control.evaluate(`(async () => ({
    sessionRules: (await chrome.declarativeNetRequest.getSessionRules()).length,
    diagnosticWrites: globalThis.__biliSoakWrites ?? 0
  }))()`);
  await client.send("Target.closeTarget", { targetId: pageTargetId });
  const cleanupStartedAt = Date.now();
  cleanupEvidence = await waitFor(
    async () => {
      const state = await control.evaluate(`(async () => ({
        sessionRules: (await chrome.declarativeNetRequest.getSessionRules()).length,
        diagnosticWrites: globalThis.__biliSoakWrites ?? 0
      }))()`);
      return state.sessionRules === 0 ? state : null;
    },
    { timeoutMs: 1000, intervalMs: 50, label: "tab-close session-rule cleanup" }
  )
    .then((state) => ({
      passed: true,
      latencyMs: Date.now() - cleanupStartedAt,
      beforeClose,
      afterClose: state
    }))
    .catch((error) => ({
      passed: false,
      latencyMs: Date.now() - cleanupStartedAt,
      beforeClose,
      error: error instanceof Error ? error.message : String(error)
    }));
} catch (error) {
  runError = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  const endedAt = Date.now();
  const sessions = finalDiagnostics.sessions ?? [];
  const abaOscillations = findAbaOscillations(sessions);
  const uniqueVisitedBvids = [
    ...new Set(visits.map((visit) => visit.bvid).filter(Boolean))
  ];
  const uniqueVisitedContentIds = [
    ...new Set(visits.map((visit) => visit.contentId).filter(Boolean))
  ];
  const uniquePlayableBvids = [
    ...new Set(
      samples
        .filter(
          (sample) =>
            sample.bvid &&
            Number(sample.video?.duration) > 0 &&
            (Number(sample.video?.readyState) >= 2 ||
              Number(sample.video?.currentTime) > 0)
      )
        .map((sample) => sample.bvid)
    )
  ];
  const uniquePlayableContentIds = [
    ...new Set(
      samples
        .filter(
          (sample) =>
            (sample.contentId || sample.bvid) &&
            Number(sample.video?.duration) > 0 &&
            (Number(sample.video?.readyState) >= 2 ||
              Number(sample.video?.currentTime) > 0)
        )
        .map((sample) => sample.contentId || sample.bvid)
    )
  ];
  const blockedMediaRequests = mediaRequests.filter(
    (request) => request.blockedCatalogMatch
  );
  const resourceBounds = {
    trackedTabs: maximum(
      samples,
      (sample) => sample.extension.latestResourceStats?.trackedTabs
    ),
    presentations: maximum(
      samples,
      (sample) => sample.extension.latestResourceStats?.presentations
    ),
    routes: maximum(
      samples,
      (sample) => sample.extension.latestResourceStats?.routes
    ),
    routeHosts: maximum(
      samples,
      (sample) => sample.extension.latestResourceStats?.routeHosts
    ),
    tabRules: maximum(
      samples,
      (sample) => sample.extension.latestResourceStats?.tabRules
    ),
    totalSessionRules: maximum(
      samples,
      (sample) => sample.extension.latestResourceStats?.totalSessionRules
    ),
    probeActiveGlobal: maximum(
      samples,
      (sample) => sample.extension.latestResourceStats?.probeActiveGlobal
    ),
    probeActiveTab: maximum(
      samples,
      (sample) => sample.extension.latestResourceStats?.probeActiveTab
    ),
    probeBytesGlobalMinute: maximum(
      samples,
      (sample) => sample.extension.latestResourceStats?.probeBytesGlobalMinute
    ),
    probeBytesTabMinute: maximum(
      samples,
      (sample) => sample.extension.latestResourceStats?.probeBytesTabMinute
    ),
    diagnosticBytes: maximum(
      samples,
      (sample) => sample.extension.diagnosticsBytes
    ),
    diagnosticSessions: maximum(
      samples,
      (sample) => sample.extension.diagnosticSessions
    ),
    diagnosticWrites: maximum(
      samples,
      (sample) => sample.extension.diagnosticWrites
    )
  };
  resourceBounds.diagnosticWritesPerMinute = Math.round(
    (resourceBounds.diagnosticWrites * 60000) /
      Math.max(1, endedAt - startedAt)
  );
  const boundsPassed =
    resourceBounds.trackedTabs <= 32 &&
    resourceBounds.presentations <= 4 &&
    resourceBounds.routes <= 128 &&
    resourceBounds.tabRules <= 16 &&
    resourceBounds.totalSessionRules <= 96 &&
    resourceBounds.probeActiveGlobal <= 4 &&
    resourceBounds.probeActiveTab <= 1 &&
    resourceBounds.probeBytesGlobalMinute <= 8 * 1024 * 1024 &&
    resourceBounds.probeBytesTabMinute <= 2 * 1024 * 1024 &&
    resourceBounds.diagnosticBytes <= 3 * 1024 * 1024 &&
    resourceBounds.diagnosticSessions <= 500 &&
    resourceBounds.diagnosticWritesPerMinute <= 60;
  const fullDuration = endedAt - startedAt >= 30 * 60 * 1000;
  const fullVideoSet = uniquePlayableContentIds.length >= 20;
  const successfulSeekResults = seekResults.filter(
    (result) => result.recovered && result.recoveryMs <= 5000
  );
  const requiredSeekPasses = fullVideoSet ? 20 : 1;
  const seekPassed = successfulSeekResults.length >= requiredSeekPasses;
  const allSeekAttemptsPassed =
    seekResults.length > 0 &&
    successfulSeekResults.length === seekResults.length;
  const playbackDecodingObserved = samples.some(
    (sample) =>
      Number(sample.video?.readyState) >= 2 &&
      (Number(sample.video?.currentTime) > 0 ||
        Number(sample.video?.duration) > 0)
  );
  const qualityChanged =
    qualityAttempts.length >= 1 &&
    qualityAttempts.some((attempt) => attempt.changed);
  const spaObserved = verifiedSpaNavigations >= 1;
  const blockedCatalogPassed = blockedMediaRequests.length === 0;
  const contentMatrix = evaluateLiveContentMatrix({
    targets: initialTargets,
    visits,
    samples,
    mediaRequests,
    requiredKinds: requiredContentKinds
  });
  const authenticatedObserved = visits.some(
    (visit) => visit.authenticated === true
  );
  const authenticatedScopeRequested = initialTargets.some(
    (target) => target.requiresAuthentication
  );
  const completeSoakPassed =
    fullDuration &&
    fullVideoSet &&
    seekPassed &&
    qualityChanged &&
    spaObserved &&
    blockedCatalogPassed &&
    boundsPassed &&
    contentMatrix.passed &&
    abaOscillations.length === 0 &&
    cleanupEvidence?.passed;
  const report = {
    reportVersion: 5,
    generatedAt: new Date().toISOString(),
    overallStatus: runError
      ? "live_stream_soak_harness_failed"
      : completeSoakPassed
        ? authenticatedScopeRequested
          ? "live_stream_soak_requested_authenticated_scope_passed"
          : "live_stream_soak_public_scope_passed_authenticated_scope_pending"
        : "live_stream_soak_partial_evidence_only",
    scope: {
      profile: ownsProfile
        ? "fresh_anonymous_temporary_profile"
        : "provided_dedicated_browser_profile",
      authenticated: authenticatedObserved,
      realBilibiliNetwork: true,
      extensionBuild: process.argv.includes("--release")
        ? "release"
        : "development",
      requestedDurationSeconds: durationSeconds,
      actualDurationMs: endedAt - startedAt,
      requestedMaxVideos: maxVideos,
      uniqueVisitedVideos: uniqueVisitedContentIds.length,
      uniquePlayableVideos: uniquePlayableContentIds.length,
      requestedContentKinds: contentMatrix.requiredKinds.map(
        (result) => result.kind
      ),
      requestedTargets: initialTargets.map((target) => ({
        id: target.id,
        url: target.url,
        kind: target.kind,
        expectedTransport: target.expectedTransport,
        requiresAuthentication: target.requiresAuthentication,
        required: target.required
      })),
      dwellSeconds,
      sampleSeconds
    },
    environment: {
      browser: path.basename(browserPath),
      extensionId,
      extensionRoot,
      stderrTail: stderr.join("").slice(-10000),
      pageErrors
    },
    coverage: {
      visits: visits.length,
      uniqueVisitedBvids,
      uniqueVisitedContentIds,
      uniquePlayableBvids,
      uniquePlayableContentIds,
      contentMatrix,
      successfulVideoElements: visits.filter((visit) => visit.videoFound).length,
      seekAttempts: seekResults.length,
      successfulSeekAttempts: successfulSeekResults.length,
      requiredSeekPasses,
      seekPassed,
      allSeekAttemptsPassed,
      playbackDecodingObserved,
      qualityAttempts: qualityAttempts.length,
      qualityInvoked: qualityAttempts.filter((attempt) => attempt.invoked).length,
      qualityChanged,
      fullNavigationEvents: navigationEvents.full,
      spaNavigationEvents: navigationEvents.spa,
      spaObserved,
      mediaRequests: mediaRequests.length,
      blockedCatalogMediaRequests: blockedMediaRequests.length,
      blockedCatalogPassed,
      abaOscillations
    },
    resourceBounds: {
      ...resourceBounds,
      passed: boundsPassed,
      heapUsedStartBytes: samples[0]?.heapUsedBytes ?? null,
      heapUsedEndBytes: samples.at(-1)?.heapUsedBytes ?? null,
      heapSlopeBytesPerMinute: heapSlopeBytesPerMinute(samples)
    },
    playback: {
      seeks: seekResults,
      qualityAttempts,
      samples
    },
    navigation: {
      events: {
        ...navigationEvents,
        verifiedPartNavigations: verifiedSpaNavigations
      },
      visits
    },
    network: {
      requests: mediaRequests.map(
        ({ requestId: _requestId, ...request }) => request
      ),
      blockedCatalogRequests: blockedMediaRequests.map(
        ({ requestId: _requestId, ...request }) => request
      ),
      routingApiRequests: routingApiRequests.map(
        ({ requestId: _requestId, ...request }) => request
      ),
      apiRequests: apiRequests.map(
        ({ requestId: _requestId, ...request }) => request
      ),
      playerCoreRequests: playerCoreRequests.map(
        ({ requestId: _requestId, ...request }) => request
      ),
      pageEmbeddedMediaEvidence
    },
    diagnostics: {
      sessionCount: sessions.length,
      sessions
    },
    cleanupEvidence,
    runError,
    acceptance: {
      fullThirtyMinutes: fullDuration,
      atLeastTwentyVideos: fullVideoSet,
      seekRecoveryWithinFiveSeconds: seekPassed,
      allSeekAttemptsRecovered: allSeekAttemptsPassed,
      playbackEnvironmentReady: playbackDecodingObserved,
      qualityChangeObserved: qualityChanged,
      spaNavigationObserved: spaObserved,
      noBlockedCatalogMediaRequests: blockedCatalogPassed,
      noAbaWithinThirtySeconds: abaOscillations.length === 0,
      resourceBoundsPassed: boundsPassed,
      tabCloseCleanupWithinOneSecond: Boolean(cleanupEvidence?.passed),
      contentMatrixPassed: contentMatrix.passed,
      authenticatedScopeRequested,
      authenticatedScopeObserved: authenticatedObserved,
      authenticatedPgcAndMemberQualityScope:
        authenticatedScopeRequested && contentMatrix.passed
    }
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[soak] report: ${reportPath}`);

  if (client && browser?.exitCode === null) {
    await client.send("Browser.close").catch(() => {});
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
  if (ownsProfile) {
    try {
      rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      });
    } catch {
      // Chrome may hold temporary cache files briefly after Browser.close.
    }
  }
  if (runError) {
    process.exitCode = 1;
  }
}
