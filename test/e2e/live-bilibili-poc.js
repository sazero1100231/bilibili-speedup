import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const requestedBvids = process.env.BILIBILI_POC_BVIDS?.trim();
if (!requestedBvids) {
  throw new Error(
    "Set BILIBILI_POC_BVIDS to a comma-separated list of test videos."
  );
}
const bvids = requestedBvids
  .split(",")
  .map((value) => value.trim())
  .filter((value) => /^BV[0-9A-Za-z]{10}$/.test(value))
  .slice(0, 20);
if (!bvids.length) {
  throw new Error("BILIBILI_POC_BVIDS contains no valid BVID values.");
}
const skipHash = process.env.BILIBILI_POC_SKIP_HASH === "1";
const dnrOnly = process.env.BILIBILI_POC_DNR_ONLY === "1";
const playSeconds = Math.max(
  1,
  Math.min(300, Number(process.env.BILIBILI_POC_PLAY_SECONDS) || 1)
);
const candidateHosts = [
  "upos-sz-mirrorcos.bilivideo.com",
  "upos-sz-mirrorcosb.bilivideo.com",
  "upos-sz-mirrorbos.bilivideo.com",
  "upos-sz-mirrorhw.bilivideo.com",
  "upos-sz-mirrorali.bilivideo.com"
];
const browserCandidates = [
  process.env.BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
].filter(Boolean);
const browserPath = browserCandidates.find(existsSync);
const scriptPath = fileURLToPath(import.meta.url);

if (!browserPath) {
  throw new Error("No Edge/Chrome executable found. Set BROWSER_PATH.");
}
if (typeof WebSocket !== "function") {
  throw new Error("Node.js 22+ is required.");
}

async function runIsolatedChild(bvid) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        BILIBILI_POC_BVIDS: bvid,
        BILIBILI_POC_SINGLE: "1"
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Child ${bvid} exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            `Cannot parse ${bvid} child report: ${error.message}\n${stdout}\n${stderr}`
          )
        );
      }
    });
  });
}

if (bvids.length > 1 && process.env.BILIBILI_POC_SINGLE !== "1") {
  const reports = [];
  for (const bvid of bvids) {
    reports.push(await runIsolatedChild(bvid));
    await sleep(500);
  }
  const videos = reports.flatMap((report) => report.videos);
  const combinations = videos.flatMap(
    (video) => video.crossHost?.variants ?? []
  );
  const passing = combinations.filter(
    (result) => result.status === 206 && result.hashMatchesOriginal
  ).length;
  const reportedVideos = skipHash
    ? videos.map((video) => ({
        bvid: video.bvid,
        pageUrl: video.pageUrl,
        hookObserved: Boolean(video.hookObserved),
        rewriteCount: video.diagnostic?.rewriteCount ?? 0,
        mediaHost: video.diagnostic?.mediaHost ?? "",
        blockedBeaconCount: video.diagnostic?.blockedBeaconCount ?? 0,
        error: video.error ?? ""
      }))
    : videos;
  console.log(
    JSON.stringify(
      {
        reportVersion: 1,
        generatedAt: new Date().toISOString(),
        browser: reports[0]?.browser ?? path.basename(browserPath),
        isolatedProfiles: true,
        videos: reportedVideos,
        summary: {
          requestedVideos: bvids.length,
          playurlCaptured: videos.filter((video) => video.mediaUrl).length,
          hookObserved: videos.filter((video) => video.hookObserved).length,
          crossHostCombinations: combinations.length,
          http206AndHashMatch: passing,
          passRate:
            combinations.length === 0 ? null : passing / combinations.length,
          v01ThresholdMet:
            combinations.length >= 15 &&
            passing / combinations.length >= 0.8,
          v03ThresholdMet:
            bvids.length >= 20 &&
            videos.filter((video) => video.hookObserved).length === bvids.length
        }
      },
      null,
      2
    )
  );
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, {
  timeoutMs = 20000,
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
        for (const listener of this.listeners.get(message.method) ?? []) {
          listener(message.params);
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(url)), {
        once: true
      });
    });
    return new CdpClient(socket);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
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

async function targetList(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

function findFirstMediaUrl(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return "";
  }
  seen.add(value);
  for (const key of ["baseUrl", "base_url", "url"]) {
    if (
      typeof value[key] === "string" &&
      /\.(?:m4s|flv|mp4)(?:\?|$)/i.test(value[key])
    ) {
      return value[key];
    }
  }
  for (const child of Object.values(value)) {
    const found = findFirstMediaUrl(child, seen);
    if (found) {
      return found;
    }
  }
  return "";
}

function sanitizeVideoForReport(video) {
  const sanitized = structuredClone(video);
  if (sanitized.apiUrl) {
    const apiUrl = new URL(sanitized.apiUrl);
    sanitized.apiUrl = `${apiUrl.origin}${apiUrl.pathname}`;
  }
  if (sanitized.mediaUrl) {
    const mediaUrl = new URL(sanitized.mediaUrl);
    sanitized.mediaUrl = `${mediaUrl.origin}${mediaUrl.pathname}`;
    sanitized.mediaQueryParamNames = [...mediaUrl.searchParams.keys()].sort();
  }
  return sanitized;
}

function captureNextPlayurl(pageCdp) {
  let settled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("No playurl response observed"));
      }
    }, 20000);
    const listener = ({ requestId, response }) => {
      let responseUrl;
      try {
        responseUrl = new URL(response.url);
      } catch {
        return;
      }
      if (
        settled ||
        !responseUrl.hostname.endsWith(".bilibili.com") ||
        !responseUrl.pathname.includes("playurl")
      ) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      pageCdp
        .send("Network.getResponseBody", { requestId })
        .then(({ body, base64Encoded }) => {
          const text = base64Encoded
            ? Buffer.from(body, "base64").toString("utf8")
            : body;
          resolve({ apiUrl: response.url, payload: JSON.parse(text) });
        })
        .catch(reject);
    };
    pageCdp.on("Network.responseReceived", listener);
  });
}

function sampleExpression(mediaUrl, hosts) {
  return `(async () => {
    const mediaUrl = ${JSON.stringify(mediaUrl)};
    const hosts = ${JSON.stringify(hosts)};
    const limit = 262144;
    async function sample(rawUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("timeout"), 5000);
      const startedAt = performance.now();
      try {
        const response = await fetch(rawUrl, {
          headers: { Range: "bytes=0-262143" },
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal
        });
        const ttfbMs = performance.now() - startedAt;
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        while (total < limit) {
          const { done, value } = await reader.read();
          if (done) break;
          const take = value.slice(0, Math.min(value.byteLength, limit - total));
          chunks.push(take);
          total += take.byteLength;
        }
        await reader.cancel().catch(() => {});
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const digest = await crypto.subtle.digest("SHA-256", merged);
        const hash = [...new Uint8Array(digest)]
          .map(byte => byte.toString(16).padStart(2, "0"))
          .join("");
        return {
          host: new URL(rawUrl).hostname,
          status: response.status,
          bytes: total,
          hash,
          ttfbMs: Math.round(ttfbMs),
          durationMs: Math.round(performance.now() - startedAt)
        };
      } catch (error) {
        return {
          host: new URL(rawUrl).hostname,
          status: 0,
          bytes: 0,
          hash: "",
          error: error instanceof Error ? error.message : String(error)
        };
      } finally {
        clearTimeout(timer);
      }
    }
    const original = await sample(mediaUrl);
    const variants = [];
    for (const host of hosts) {
      const url = new URL(mediaUrl);
      url.hostname = host;
      url.port = "";
      variants.push(await sample(url.href));
    }
    return { original, variants };
  })()`;
}

const profile = mkdtempSync(path.join(tmpdir(), "bili-live-poc-"));
const activePortFile = path.join(profile, "DevToolsActivePort");
let browser;
let browserCdp;
let workerCdp;
let pageCdp;

try {
  browser = spawn(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--autoplay-policy=no-user-gesture-required",
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      "--remote-debugging-port=0",
      "about:blank"
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
  );

  await waitFor(() => existsSync(activePortFile), {
    label: "DevToolsActivePort"
  });
  const [portText, browserSocketPath] = readFileSync(
    activePortFile,
    "utf8"
  )
    .trim()
    .split(/\r?\n/);
  const port = Number(portText);
  browserCdp = await CdpClient.connect(
    `ws://127.0.0.1:${port}${browserSocketPath}`
  );
  const workerTarget = await waitFor(
    async () =>
      (await targetList(port)).find(
        (target) =>
          target.type === "service_worker" &&
          target.url.includes("/src/background/service-worker.js")
      ),
    { label: "extension service worker" }
  );
  const extensionId = workerTarget.url.match(
    /^chrome-extension:\/\/([a-p]{32})\//
  )?.[1];
  assert.ok(extensionId);
  workerCdp = await CdpClient.connect(workerTarget.webSocketDebuggerUrl);
  const contexts = [];
  workerCdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (
      context.origin?.includes(extensionId) ||
      context.name?.includes(extensionId)
    ) {
      contexts.push(context);
    }
  });
  await workerCdp.send("Runtime.enable");
  workerCdp.contextId = await waitFor(async () => {
    for (const context of [...contexts].reverse()) {
      const available = await workerCdp
        .evaluate(`typeof chrome.runtime === "object"`, context.id)
        .catch(() => false);
      if (available) {
        return context.id;
      }
    }
    return null;
  }, { label: "extension execution context" });
  if (dnrOnly) {
    await waitFor(
      () =>
        workerCdp.evaluate(`(async () => {
          const { settings } = await chrome.storage.local.get("settings");
          return settings?.acceleration ? settings : null;
        })()`),
      { label: "default extension settings" }
    );
    await workerCdp.evaluate(`(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      settings.acceleration.playurlRewrite = false;
      settings.acceleration.dnrFallback = true;
      await chrome.storage.local.set({ settings });
      return true;
    })()`);
    await waitFor(
      () =>
        workerCdp.evaluate(`(async () =>
          !(await chrome.declarativeNetRequest.getDynamicRules())
            .some(rule => rule.id >= 3000 && rule.id < 3100)
        )()`),
      { label: "DNR-only starts without unprobed media rules" }
    );
  }

  const pageTarget = (await targetList(port)).find(
    (target) => target.type === "page"
  );
  pageCdp = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
  await pageCdp.send("Runtime.enable");
  await pageCdp.send("Page.enable");
  await pageCdp.send("Network.enable", {
    maxTotalBufferSize: 10_000_000,
    maxResourceBufferSize: 2_000_000
  });
  await pageCdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  let mediaRequests = [];
  pageCdp.on("Network.requestWillBeSent", ({ request }) => {
    try {
      const url = new URL(request.url);
      if (/\.(?:m4s|flv|mp4)$/i.test(url.pathname)) {
        mediaRequests.push({
          host: url.hostname,
          path: url.pathname
        });
      }
    } catch {
      // Ignore non-URL requests.
    }
  });

  const videos = [];
  for (const bvid of bvids) {
    mediaRequests = [];
    await pageCdp.send("Page.navigate", { url: "about:blank" });
    await waitFor(
      () =>
        pageCdp.evaluate(
          `location.href === "about:blank" && document.readyState === "complete"`
        ),
      { label: `${bvid} blank-page reset` }
    );
    await pageCdp.send("Network.clearBrowserCache");
    const capture = captureNextPlayurl(pageCdp);
    await pageCdp.send("Page.navigate", {
      url: `https://www.bilibili.com/video/${bvid}/`
    });
    try {
      const captured = await capture;
      const mediaUrl = findFirstMediaUrl(captured.payload);
      if (!mediaUrl) {
        throw new Error("playurl response contained no media URL");
      }
      const diagnostic = dnrOnly
        ? null
        : await waitFor(
            () =>
              workerCdp.evaluate(`(async () => {
                const { diagnostics } = await chrome.storage.local.get("diagnostics");
                return [...(diagnostics?.sessions ?? [])]
                  .reverse()
                  .find(session => session.pageUrl.includes(${JSON.stringify(bvid)}) && session.rewriteCount > 0) ?? null;
              })()`),
            { timeoutMs: 10000, label: `${bvid} rewrite diagnostic` }
          ).catch(() => null);
      let dnrEvidence = null;
      let videoState = null;
      if (dnrOnly) {
        const playbackStart = await pageCdp.evaluate(`(async () => {
          const video = document.querySelector("video");
          if (!video) return null;
          await video.play().catch(() => {});
          return video.currentTime;
        })()`);
        const probeState = await waitFor(
          () =>
            workerCdp.evaluate(`(async () => {
              const { runtimeState } = await chrome.storage.local.get("runtimeState");
              const mediaRules = (await chrome.declarativeNetRequest.getDynamicRules())
                .filter(rule => rule.id >= 3000 && rule.id < 3100)
                .map(rule => rule.id);
              const sessionRules = (await chrome.declarativeNetRequest.getSessionRules())
                .filter(rule => rule.id >= 4000000 && rule.id < 5000000)
                .map(rule => rule.id);
              return runtimeState?.lastProbeAt > 0 && mediaRules.length === 0
                ? {
                    lastProbeAt: runtimeState.lastProbeAt,
                    selectedHost: runtimeState.selectedHost,
                    mediaRules,
                    sessionRules
                  }
                : null;
            })()`),
          { timeoutMs: 30000, label: `${bvid} passive route probe` }
        );
        dnrEvidence = {
          mode: "native-playback-safe",
          globalMediaRules: probeState.mediaRules,
          sessionMediaRules: probeState.sessionRules
        };
        const playbackTarget = (playbackStart ?? 0) + playSeconds;
        await waitFor(
          () =>
            pageCdp.evaluate(`(() => {
              const video = document.querySelector("video");
              return Boolean(
                video &&
                !video.error &&
                video.currentTime >= ${JSON.stringify(playbackTarget)}
              );
            })()`),
          {
            timeoutMs: (playSeconds + 45) * 1000,
            intervalMs: 500,
            label: `${bvid} ${playSeconds}s continuous playback`
          }
        );
        const seek = await pageCdp.evaluate(`(async () => {
          const video = document.querySelector("video");
          if (!video) return null;
          const from = video.currentTime;
          const maxTarget = Number.isFinite(video.duration)
            ? Math.max(from, video.duration - 2)
            : from + 10;
          const target = Math.min(from + 10, maxTarget);
          video.currentTime = target;
          await video.play().catch(() => {});
          return { from, target };
        })()`);
        await waitFor(
          () =>
            pageCdp.evaluate(`(() => {
              const video = document.querySelector("video");
              return Boolean(
                video &&
                !video.error &&
                !video.seeking &&
                video.currentTime >= ${JSON.stringify(seek?.target ?? 0)}
              );
            })()`),
          {
            timeoutMs: 15000,
            intervalMs: 250,
            label: `${bvid} seek recovery`
          }
        );
        await sleep(1000);
        videoState = await pageCdp
          .evaluate(`(() => {
            const video = document.querySelector("video");
            return video
              ? {
                  exists: true,
                  paused: video.paused,
                  currentTime: video.currentTime,
                  readyState: video.readyState,
                  networkState: video.networkState,
                  errorCode: video.error?.code ?? 0,
                  playbackStart: ${JSON.stringify(playbackStart)},
                  requiredPlaySeconds: ${JSON.stringify(playSeconds)},
                  probeState: ${JSON.stringify(probeState)},
                  seek: ${JSON.stringify(seek)},
                  seekSucceeded:
                    !video.seeking &&
                    video.currentTime >= ${JSON.stringify(seek?.target ?? 0)}
                }
              : { exists: false };
          })()`)
          .catch(() => null);
      }
      videos.push({
        bvid,
        pageUrl: `https://www.bilibili.com/video/${bvid}/`,
        apiUrl: captured.apiUrl,
        mediaUrl,
        hookObserved: Boolean(diagnostic),
        diagnostic,
        dnrEvidence,
        videoState,
        mediaRequests: [...mediaRequests]
      });
    } catch (error) {
      videos.push({
        bvid,
        pageUrl: `https://www.bilibili.com/video/${bvid}/`,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const collected = videos.filter((video) => video.mediaUrl);
  if (collected.length && !skipHash && !dnrOnly) {
    await workerCdp.evaluate(`(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      settings.acceleration.playurlRewrite = false;
      settings.acceleration.dnrFallback = false;
      await chrome.storage.local.set({ settings });
      return true;
    })()`);
    await waitFor(
      () =>
        workerCdp.evaluate(`(async () =>
          !(await chrome.declarativeNetRequest.getDynamicRules())
            .some(rule => rule.id >= 3000 && rule.id < 3100)
        )()`),
      { label: "media DNR disable" }
    );
    await sleep(300);
    for (const video of collected) {
      video.crossHost = await pageCdp.evaluate(
        sampleExpression(video.mediaUrl, candidateHosts)
      );
      for (const variant of video.crossHost.variants) {
        variant.hashMatchesOriginal =
          Boolean(variant.hash) &&
          variant.hash === video.crossHost.original.hash;
      }
    }
  }

  const combinations = collected.flatMap(
    (video) => video.crossHost?.variants ?? []
  );
  const passing = combinations.filter(
    (result) => result.status === 206 && result.hashMatchesOriginal
  ).length;
  const report = {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    browser: path.basename(browserPath),
    extensionId,
    videos: videos.map(sanitizeVideoForReport),
    summary: {
      requestedVideos: bvids.length,
      playurlCaptured: collected.length,
      hookObserved: videos.filter((video) => video.hookObserved).length,
      crossHostCombinations: combinations.length,
      http206AndHashMatch: passing,
      passRate:
        combinations.length === 0 ? null : passing / combinations.length,
      v01ThresholdMet:
        combinations.length >= 15 && passing / combinations.length >= 0.8,
      v03ThresholdMet:
        bvids.length >= 20 &&
        videos.filter((video) => video.hookObserved).length === bvids.length,
      v02DnrObserved: videos.some((video) => video.dnrEvidence)
    }
  };
  console.log(JSON.stringify(report, null, 2));
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
  const expectedPrefix = path.join(tmpdir(), "bili-live-poc-");
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
