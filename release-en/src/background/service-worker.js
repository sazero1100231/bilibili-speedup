import {
  STORAGE_KEYS,
  mainWorldModulesEnabled,
  normalizeRuntimeState,
  normalizeSettings,
  pageModulesEnabled
} from "../lib/defaults.js";
import {
  candidateHosts,
  chooseSelectedHost,
  healthyHosts
} from "../lib/cdn-selection.js";
import { sanitizeCosmeticSelectors } from "../lib/cosmetic.js";
import {
  MAX_GLOBAL_SESSION_MEDIA_RULES,
  MAX_SESSION_MEDIA_RULES,
  compileDynamicRules,
  compileSessionMediaRules
} from "../lib/dnr.js";
import {
  PROBE_BYTES,
  PROBE_TIMEOUT_MS,
  probeMediaPath
} from "../lib/prober.js";
import { ProbeScheduler } from "../lib/probe-scheduler.js";
import {
  advanceHostCircuit,
  confirmHostRecovery,
  createHostCircuit,
  noteHostFailure as noteCircuitFailure
} from "../lib/stream-policy.js";
import {
  getHostname,
  hostnameMatches,
  isAllowedMediaHostname,
  isMediaResourceUrl,
  mediaRouteKey,
  uniqueStrings
} from "../lib/url-utils.js";

const CONTENT_SCRIPT_IDS = ["bili-oversea-main", "bili-oversea-bridge"];
const OWN_RULE_MIN = 1000;
const OWN_RULE_MAX = 3999;
const OWN_SESSION_RULE_MIN = 4_000_000;
const OWN_SESSION_RULE_MAX = 4_999_999;
const MAX_TRACKED_TABS = 32;
const MAX_PRESENTATIONS_PER_TAB = 4;
const MAX_ROUTES_PER_PRESENTATION = 32;
const MAX_HOSTS_PER_ROUTE = 8;
const MAX_PROBE_CANDIDATES_PER_ROUTE = 2;
const MAX_PROBE_CANDIDATES_PER_SWEEP = 8;
const ROUTE_THROUGHPUT_HEADROOM = 1.25;
const INACTIVE_SESSION_TTL_MS = 120_000;
const MAX_RETIRED_DOCUMENTS_PER_TAB = 32;
const RETIRED_DOCUMENT_TTL_MS = 10 * 60_000;
const MAX_NATIVE_ROUTE_BYPASS_MS = 60_000;
const PLAYBACK_RISK_WINDOW_MS = 15_000;
const ruleDataPromise = loadRuleData();
let reconcileChain = Promise.resolve();
let runtimeMutationChain = Promise.resolve();
let initializationPromise = Promise.resolve();
const probeJobs = new Map();
const probeScheduler = new ProbeScheduler();
const circuitTimers = new Map();
const nativeBypassTimers = new Map();
const sessionExpiryTimers = new Map();
const tabPlaybackSessions = new Map();
const reservedTabStarts = new Set();
const tabSessionStartChains = new Map();
const sessionTabBindings = new Map();
const tabRetiredDocuments = new Map();
const sessionRuleMutationChains = new Map();
let fairSessionRuleMutationChain = Promise.resolve();
const tabRuleBlocks = new Map();
const pendingTabRuleReplacements = new Map();
const cosmeticMutationChains = new Map();
const diagnosticMutationChains = new Map();
const pendingDiagnosticFlushes = new Map();
const diagnosticCache = new Map();
let diagnosticsCachePromise = null;
let diagnosticStorageChain = Promise.resolve();
let deferredDiagnosticStorageTimer = null;
let lastDiagnosticStorageWriteAt = 0;
let lastDiagnosticStoredBytes = 0;
const diagnosticWriteTimestamps = [];
let debugFlushTimer = null;
const pendingDebugCounts = new Map();

function mutateRuntimeState(mutator) {
  const operation = runtimeMutationChain
    .catch(() => {})
    .then(async () => {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.runtime);
      const current = normalizeRuntimeState(stored[STORAGE_KEYS.runtime]);
      const next = normalizeRuntimeState(await mutator(current));
      await chrome.storage.local.set({ [STORAGE_KEYS.runtime]: next });
      return next;
    });
  runtimeMutationChain = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

async function loadJson(path) {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) {
    throw new Error(`Cannot load ${path}: HTTP ${response.status}`);
  }
  return response.json();
}

async function loadRuleData() {
  const [cdnPool, tracking, endpoints, cosmetic] = await Promise.all([
    loadJson("rules/cdn-pool.json"),
    loadJson("rules/tracking-params.json"),
    loadJson("rules/blocked-endpoints.json"),
    loadJson("rules/cosmetic-selectors.json")
  ]);
  return { cdnPool, tracking, endpoints, cosmetic };
}

async function readState() {
  const rules = await ruleDataPromise;
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.runtime,
    STORAGE_KEYS.diagnostics
  ]);
  const settings = normalizeSettings(
    stored[STORAGE_KEYS.settings],
    rules.endpoints.endpoints
  );
  let runtime = normalizeRuntimeState(stored[STORAGE_KEYS.runtime]);
  const diagnostics = stored[STORAGE_KEYS.diagnostics] ?? { sessions: [] };

  if (
    JSON.stringify(settings) !== JSON.stringify(stored[STORAGE_KEYS.settings] ?? {})
  ) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  }
  if (
    JSON.stringify(runtime) !== JSON.stringify(stored[STORAGE_KEYS.runtime] ?? {})
  ) {
    runtime = await mutateRuntimeState((current) => current);
  }
  return { rules, settings, runtime, diagnostics };
}

function routingEnabled(settings) {
  return Boolean(
    settings?.globalEnabled &&
      settings?.acceleration?.enabled
  );
}

// Keep in sync with the two content-world copies. Search/home/space previews
// are deliberately outside playback routing and must never allocate a tab
// session, probe budget, or media DNR rules.
function isSupportedPlaybackPageUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    if (
      !["www.bilibili.com", "m.bilibili.com"].includes(
        url.hostname.toLowerCase()
      )
    ) {
      return false;
    }
    return (
      /^\/video\/(?:BV[0-9a-z_-]+|av\d+)(?:\/|$)/i.test(url.pathname) ||
      /^\/bangumi\/play\/(?:ep|ss|md)\d+(?:\/|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

async function requireRoutingEnabled() {
  const state = await readState();
  if (!routingEnabled(state.settings)) {
    throw new Error("Playback routing is disabled");
  }
  return state;
}

function tabRouteConfig(tabId) {
  const tabSession = tabPlaybackSessions.get(tabId);
  if (!tabSession) {
    return {
      playbackSessionId: "",
      routingTabId: null,
      compatibleRoutes: {},
      degradedRoutes: {},
      halfOpenRoutes: {}
    };
  }
  const halfOpenRoutes = new Map();
  for (const [key, circuit] of tabSession.hostCircuits) {
    if (circuit?.circuit !== "half-open") {
      continue;
    }
    const separator = key.lastIndexOf("\u0000");
    if (separator <= 0) {
      continue;
    }
    const stateKey = key.slice(0, separator);
    const host = key.slice(separator + 1);
    const hosts = halfOpenRoutes.get(stateKey) ?? new Set();
    hosts.add(host);
    halfOpenRoutes.set(stateKey, hosts);
  }
  return {
    playbackSessionId: tabSession.sessionId,
    routingTabId: tabId,
    compatibleRoutes: Object.fromEntries(
      [...tabSession.compatibleRoutes.entries()].map(([key, urls]) => [
        key,
        [...urls]
      ])
    ),
    degradedRoutes: Object.fromEntries(
      [...tabSession.degradedRoutes.entries()].map(([key, hosts]) => [
        key,
        [...hosts]
      ])
    ),
    halfOpenRoutes: Object.fromEntries(
      [...halfOpenRoutes.entries()].map(([key, hosts]) => [
        key,
        [...hosts]
      ])
    )
  };
}

async function pushTabRoutingConfig(tabId, session, reason) {
  if (
    tabPlaybackSessions.get(tabId) !== session ||
    typeof chrome.tabs?.sendMessage !== "function"
  ) {
    return false;
  }
  const config = await buildRuntimeConfig(null, tabId);
  await chrome.tabs.sendMessage(
    tabId,
    {
      type: "ROUTING_CONFIG_UPDATED",
      sessionId: session.sessionId,
      reason: String(reason ?? "").slice(0, 60),
      config
    },
    { frameId: 0 }
  );
  return true;
}

function routingResourceStats(tabId) {
  const probe = probeScheduler.snapshot();
  const session = tabPlaybackSessions.get(tabId);
  const routes = session ? [...session.routes.values()] : [];
  const presentations = new Set(
    routes.map((route) => route.presentationId)
  );
  return {
    trackedTabs: tabPlaybackSessions.size,
    maxTrackedTabs: MAX_TRACKED_TABS,
    presentations: presentations.size,
    maxPresentations: MAX_PRESENTATIONS_PER_TAB,
    routes: routes.length,
    maxRoutesPerPresentation: MAX_ROUTES_PER_PRESENTATION,
    routeHosts: routes.reduce(
      (sum, route) => sum + Math.min(MAX_HOSTS_PER_ROUTE, route.urls.length),
      0
    ),
    maxHostsPerRoute: MAX_HOSTS_PER_ROUTE,
    tabRules: session?.ruleCount ?? 0,
    totalSessionRules: [...tabPlaybackSessions.values()].reduce(
      (sum, entry) => sum + entry.ruleCount,
      0
    ),
    maxTabRules: MAX_SESSION_MEDIA_RULES,
    maxGlobalRules: MAX_GLOBAL_SESSION_MEDIA_RULES,
    probeActiveGlobal: probe.activeGlobal,
    probeActiveTab: probe.activeByTab[tabId] ?? 0,
    probeQueuedGlobal: Object.values(probe.queuedByTab).reduce(
      (sum, count) => sum + count,
      0
    ),
    probeQueuedTab: probe.queuedByTab[tabId] ?? 0,
    probeBytesGlobalMinute: probe.bytesInWindow,
    probeBytesTabMinute: probe.bytesByTab[tabId] ?? 0,
    pendingRuleUpdates: pendingTabRuleReplacements.size,
    pendingDiagnosticFlushes: pendingDiagnosticFlushes.size,
    diagnosticWritesMinute: diagnosticWriteTimestamps.filter(
      (at) => Date.now() - at < 60_000
    ).length,
    diagnosticStoredBytes: lastDiagnosticStoredBytes,
    maxDiagnosticBytes: MAX_DIAGNOSTIC_BYTES
  };
}

async function buildRuntimeConfig(existingState, tabId) {
  const state = existingState ?? (await readState());
  const { rules, settings, runtime } = state;
  const selectedHost = chooseSelectedHost(settings, runtime, rules.cdnPool);
  const enabledEndpoints = rules.endpoints.endpoints.filter(
    (endpoint) =>
      settings.privacy.telemetryBlocking &&
      settings.privacy.endpointToggles[endpoint.id]
  );
  return {
    version: chrome.runtime.getManifest().version,
    settings,
    selectedHost,
    healthyHosts: healthyHosts(settings, runtime, rules.cdnPool),
    candidateHosts: candidateHosts(rules.cdnPool),
    trackingParams: rules.tracking.params.map((entry) => entry.param),
    blockedHostPatterns: rules.cdnPool.blocked.map((entry) => entry.pattern),
    blockedEndpoints: enabledEndpoints.map((entry) => ({
      id: entry.id,
      domain: entry.domain,
      pathPrefix: entry.path_prefix
    })),
    endpointCatalog: rules.endpoints.endpoints,
    cosmeticSelectors: sanitizeCosmeticSelectors(
      rules.cosmetic.selectors.map((entry) => entry.selector)
    ),
    probeResults: Object.values(runtime.probeCache).sort(
      (left, right) =>
        Number(right.healthy) - Number(left.healthy) ||
        right.throughputBps - left.throughputBps
    ),
    dnrMatchCounts: runtime.dnrMatchCounts,
    lastProbeAt: runtime.lastProbeAt,
    resourceStats: routingResourceStats(tabId),
    ...tabRouteConfig(tabId)
  };
}

async function validateRegexRules(rules) {
  if (!chrome.declarativeNetRequest.isRegexSupported) {
    return;
  }
  for (const rule of rules) {
    const regex = rule.condition.regexFilter;
    if (!regex) {
      continue;
    }
    const result = await chrome.declarativeNetRequest.isRegexSupported({
      regex,
      isCaseSensitive: true
    });
    if (!result.isSupported) {
      throw new Error(
        `Unsupported DNR regex for rule ${rule.id}: ${result.reason ?? "unknown"}`
      );
    }
  }
}

async function replaceDynamicRules(addRules) {
  await validateRegexRules(addRules);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .map((rule) => rule.id)
    .filter((id) => id >= OWN_RULE_MIN && id <= OWN_RULE_MAX);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules
  });
}

function isPlaybackSessionId(value) {
  return /^[a-zA-Z0-9_-]{8,100}$/.test(String(value ?? ""));
}

function requireTabId(message, sender) {
  if (Number.isInteger(sender.tab?.id) && sender.tab.id >= 0) {
    return sender.tab.id;
  }
  const sessionId = String(message?.sessionId ?? "");
  const claimedTabId = Number(message?.routingTabId);
  if (
    Number.isInteger(claimedTabId) &&
    claimedTabId >= 0 &&
    sessionTabBindings.get(sessionId) === claimedTabId
  ) {
    return claimedTabId;
  }
  {
    const source = sender.tab ? "tab-without-id" : "extension-context";
    throw new Error(
      `Playback routing requires a tab sender (${source}; frame ${Number(sender.frameId) || 0}; document ${sender.documentId ? "yes" : "no"})`
    );
  }
}

function isOwnSessionRule(rule) {
  return (
    rule.id >= OWN_SESSION_RULE_MIN && rule.id <= OWN_SESSION_RULE_MAX
  );
}

function queueTabRuleMutation(tabId, operation) {
  const previous =
    sessionRuleMutationChains.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined
  );
  sessionRuleMutationChains.set(tabId, settled);
  void settled.finally(() => {
    if (sessionRuleMutationChains.get(tabId) === settled) {
      sessionRuleMutationChains.delete(tabId);
    }
  });
  return current;
}

function queueFairSessionRuleMutation(operation) {
  const current = fairSessionRuleMutationChain
    .catch(() => {})
    .then(operation);
  fairSessionRuleMutationChain = current.then(
    () => undefined,
    () => undefined
  );
  return current;
}

function activeRuleTabIds() {
  return [...tabPlaybackSessions.entries()]
    .filter(
      ([, session]) =>
        session.routes.size > 0 && session.degradedRoutes.size > 0
    )
    .map(([tabId]) => tabId)
    .sort((left, right) => left - right);
}

function fairRuleQuotas(tabIds) {
  const quotas = new Map();
  if (!tabIds.length) {
    return quotas;
  }
  const base = Math.min(
    MAX_SESSION_MEDIA_RULES,
    Math.floor(MAX_GLOBAL_SESSION_MEDIA_RULES / tabIds.length)
  );
  let remainder = Math.max(
    0,
    MAX_GLOBAL_SESSION_MEDIA_RULES - base * tabIds.length
  );
  for (const tabId of tabIds) {
    const extra = base < MAX_SESSION_MEDIA_RULES && remainder > 0 ? 1 : 0;
    quotas.set(tabId, base + extra);
    remainder -= extra;
  }
  return quotas;
}

function cancelPendingTabRuleReplacement(tabId, errorMessage) {
  const pending = pendingTabRuleReplacements.get(tabId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingTabRuleReplacements.delete(tabId);
  const error = new Error(errorMessage || "Session-rule update superseded");
  for (const waiter of pending.waiters) {
    waiter.reject(error);
  }
}

async function removeTabSessionRules(tabId) {
  cancelPendingTabRuleReplacement(tabId, "Playback session changed");
  return queueTabRuleMutation(tabId, async () => {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = existing
      .filter(
        (rule) =>
          isOwnSessionRule(rule) &&
          rule.condition.tabIds?.includes(tabId)
      )
      .map((rule) => rule.id);
    if (removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds,
        addRules: []
      });
    }
    return 0;
  });
}

function sessionRouteList(session) {
  const now = Date.now();
  return [...session.routes.entries()]
    .filter(([stateKey]) => {
      const until = session.nativeBypassRoutes.get(stateKey) ?? 0;
      if (until <= now) {
        session.nativeBypassRoutes.delete(stateKey);
        return true;
      }
      return false;
    })
    .sort(
      (left, right) =>
        Number(right[1].lastActiveAt || right[1].updatedAt || 0) -
        Number(left[1].lastActiveAt || left[1].updatedAt || 0)
    )
    .map(([stateKey, route]) => ({
    stateKey,
    presentationId: route.presentationId,
    routeKey: route.routeKey,
    urls: uniqueStrings([
      ...route.urls,
      ...(session.compatibleRoutes.get(stateKey) ?? [])
    ])
    }));
}

function findSessionRuleStart(existing, tabId) {
  const assigned = tabRuleBlocks.get(tabId);
  if (assigned) {
    return assigned;
  }
  const used = new Set([
    ...existing.map((rule) => rule.id),
    ...[...tabRuleBlocks.values()].flatMap((startId) =>
      Array.from(
        { length: MAX_SESSION_MEDIA_RULES },
        (_, offset) => startId + offset
      )
    )
  ]);
  const lastStart = OWN_SESSION_RULE_MAX - MAX_SESSION_MEDIA_RULES + 1;
  for (
    let startId = OWN_SESSION_RULE_MIN;
    startId <= lastStart;
    startId += MAX_SESSION_MEDIA_RULES
  ) {
    let available = true;
    for (let offset = 0; offset < MAX_SESSION_MEDIA_RULES; offset += 1) {
      if (used.has(startId + offset)) {
        available = false;
        break;
      }
    }
    if (available) {
      tabRuleBlocks.set(tabId, startId);
      return startId;
    }
  }
  throw new Error("No extension session-rule ID block is available");
}

async function replaceTabSessionRulesNow(tabId, session) {
  const ruleTabs = activeRuleTabIds();
  const fairMode =
    ruleTabs.length >
    Math.floor(
      MAX_GLOBAL_SESSION_MEDIA_RULES / MAX_SESSION_MEDIA_RULES
    );
  const operation = async () => {
    const state = await readState();
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const quotas = fairRuleQuotas(activeRuleTabIds());
    const currentQuota = quotas.get(tabId) ?? MAX_SESSION_MEDIA_RULES;
    const removeRuleIds = existing
      .filter(
        (rule) =>
          isOwnSessionRule(rule) &&
          rule.condition.tabIds?.includes(tabId)
      )
      .map((rule) => rule.id);
    const trackedRuleIdsByTab = new Map();
    for (const rule of existing.filter(isOwnSessionRule)) {
      const ruleTabId = rule.condition.tabIds?.[0];
      if (!Number.isInteger(ruleTabId) || ruleTabId === tabId) {
        continue;
      }
      const ids = trackedRuleIdsByTab.get(ruleTabId) ?? [];
      ids.push(rule.id);
      trackedRuleIdsByTab.set(ruleTabId, ids);
    }
    for (const [ruleTabId, ids] of trackedRuleIdsByTab) {
      ids.sort((left, right) => left - right);
      const quota = quotas.get(ruleTabId) ?? 0;
      removeRuleIds.push(...ids.slice(quota));
    }
    let addRules = [];
    if (
      state.settings.globalEnabled &&
      state.settings.acceleration.enabled &&
      state.settings.acceleration.dnrFallback &&
      tabPlaybackSessions.get(tabId) === session
    ) {
      const remaining = existing.filter(
        (rule) => !removeRuleIds.includes(rule.id)
      );
      addRules = compileSessionMediaRules({
        tabId,
        routes: sessionRouteList(session),
        degradedRoutes: Object.fromEntries(
          [...session.degradedRoutes.entries()].map(([key, hosts]) => [
            key,
            [...hosts]
          ])
        ),
        blockedHostPatterns: state.rules.cdnPool.blocked.map(
          (entry) => entry.pattern
        ),
        startId: findSessionRuleStart(remaining, tabId)
      });
      addRules = addRules.slice(0, currentQuota);
      const globalRemainingBudget = Math.max(
        0,
        MAX_GLOBAL_SESSION_MEDIA_RULES -
          remaining.filter(isOwnSessionRule).length
      );
      addRules = addRules.slice(0, globalRemainingBudget);
      await validateRegexRules(addRules);
    }
    if (removeRuleIds.length || addRules.length) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds,
        addRules
      });
    }
    session.ruleCount = addRules.length;
    const finalCounts = new Map();
    const removed = new Set(removeRuleIds);
    for (const rule of [
      ...existing.filter((rule) => !removed.has(rule.id)),
      ...addRules
    ]) {
      if (!isOwnSessionRule(rule)) {
        continue;
      }
      const ruleTabId = rule.condition.tabIds?.[0];
      if (Number.isInteger(ruleTabId)) {
        finalCounts.set(ruleTabId, (finalCounts.get(ruleTabId) ?? 0) + 1);
      }
    }
    for (const [ruleTabId, trackedSession] of tabPlaybackSessions) {
      trackedSession.ruleCount = finalCounts.get(ruleTabId) ?? 0;
    }
    return addRules.length;
  };
  if (fairMode) {
    return queueFairSessionRuleMutation(async () => {
      // The 6→7 tab transition changes the queue topology. Drain mutations
      // already admitted to per-tab chains before taking the first fair-mode
      // read/modify/write snapshot so the global 96-rule budget cannot see a
      // stale, mutually invisible state.
      await Promise.all([...sessionRuleMutationChains.values()]);
      return operation();
    });
  }
  return queueTabRuleMutation(tabId, operation);
}

function replaceTabSessionRules(tabId, session) {
  const existing = pendingTabRuleReplacements.get(tabId);
  if (existing && existing.session === session) {
    return new Promise((resolve, reject) => {
      existing.waiters.push({ resolve, reject });
    });
  }
  if (existing) {
    cancelPendingTabRuleReplacement(
      tabId,
      "Session-rule update replaced by a newer playback session"
    );
  }
  return new Promise((resolve, reject) => {
    const pending = {
      session,
      waiters: [{ resolve, reject }],
      timer: null
    };
    pending.timer = setTimeout(() => {
      pendingTabRuleReplacements.delete(tabId);
      replaceTabSessionRulesNow(tabId, pending.session).then(
        (value) => {
          for (const waiter of pending.waiters) {
            waiter.resolve(value);
          }
        },
        (error) => {
          for (const waiter of pending.waiters) {
            waiter.reject(error);
          }
        }
      );
    }, 50);
    pendingTabRuleReplacements.set(tabId, pending);
  });
}

async function removeOrphanedSessionRules() {
  for (const tabId of [...pendingTabRuleReplacements.keys()]) {
    cancelPendingTabRuleReplacement(tabId, "Global route cleanup");
  }
  await Promise.all(
    [...sessionRuleMutationChains.values()].map((chain) =>
      chain.catch(() => {})
    )
  );
  return queueTabRuleMutation(-1, async () => {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = existing
      .filter(isOwnSessionRule)
      .map((rule) => rule.id);
    if (removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds,
        addRules: []
      });
    }
    tabRuleBlocks.clear();
  });
}

async function reconcileContentScripts(settings) {
  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: CONTENT_SCRIPT_IDS
  });
  const pageEnabled = pageModulesEnabled(settings);
  const desiredIds = pageEnabled
    ? [
        ...(mainWorldModulesEnabled(settings)
          ? ["bili-oversea-main"]
          : []),
        "bili-oversea-bridge"
      ].sort()
    : [];
  const existingIds = existing.map((entry) => entry.id).sort();
  if (
    desiredIds.length === existingIds.length &&
    desiredIds.every((id, index) => id === existingIds[index])
  ) {
    return;
  }
  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({
      ids: existing.map((entry) => entry.id)
    });
  }
  if (!pageEnabled) {
    return;
  }
  const shared = {
    matches: ["*://*.bilibili.com/*"],
    excludeMatches: ["*://passport.bilibili.com/*"],
    runAt: "document_start",
    allFrames: false,
    persistAcrossSessions: true
  };
  const registrations = [
    {
      ...shared,
      id: "bili-oversea-bridge",
      js: ["src/content/bridge.js"],
      world: "ISOLATED"
    }
  ];
  if (desiredIds.includes("bili-oversea-main")) {
    registrations.unshift({
      ...shared,
      id: "bili-oversea-main",
      js: ["src/content/main-world.js"],
      world: "MAIN"
    });
  }
  await chrome.scripting.registerContentScripts(registrations);
}

async function reconcile() {
  const state = await readState();
  const { rules, settings } = state;
  const addRules = compileDynamicRules({
    settings,
    trackingParams: rules.tracking.params.map((entry) => entry.param),
    endpoints: rules.endpoints.endpoints
  });
  await Promise.all([
    replaceDynamicRules(addRules),
    reconcileContentScripts(settings)
  ]);
}

function queueReconcile() {
  reconcileChain = reconcileChain
    .catch(() => {})
    .then(reconcile)
    .catch((error) => console.error("bilibili-speedup reconcile failed", error));
  return reconcileChain;
}

function createPlaybackSession(
  sessionId,
  pageUrl,
  clientEpoch,
  documentId,
  documentStartedAt
) {
  return {
    sessionId,
    clientEpoch,
    documentId,
    documentStartedAt: Math.max(0, Number(documentStartedAt) || 0),
    pageUrl: String(pageUrl ?? "").slice(0, 600),
    routes: new Map(),
    compatibleRoutes: new Map(),
    // Compatibility is not enough for a high-bitrate representation. Keep
    // the measured capacity beside each exact signed URL so a later manifest
    // update cannot retain a candidate that was authorized while bandwidth
    // was missing or lower.
    compatibleRouteThroughputs: new Map(),
    degradedRoutes: new Map(),
    nativeBypassRoutes: new Map(),
    riskCounts: new Map(),
    hostCircuits: new Map(),
    // Probe rotation is scoped to one exact signed representation. A manifest
    // can register several unused ABR representations before playback starts;
    // those routes must not consume the best candidates for the route the
    // player actually selected.
    probeCandidateCursors: new Map(),
    probeCandidateStates: new Map(),
    // Keep only the byte-zero hash/status established inside this playback
    // session. Recovery can reuse it after every registered URL host has been
    // degraded, avoiding an impossible fetch from a deliberately blocked
    // reference and keeping each later round to candidate bytes only.
    probeReferences: new Map(),
    ruleCount: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  };
}

function routeRequiredThroughput(route) {
  return Math.max(
    0,
    Number(route?.bandwidth) * ROUTE_THROUGHPUT_HEADROOM
  );
}

function pruneUnderpoweredRouteCandidates(session, route) {
  const requiredBps = routeRequiredThroughput(route);
  if (!requiredBps) {
    return false;
  }
  const stateKey = route.stateKey;
  const metrics = session.compatibleRouteThroughputs.get(stateKey);
  const compatible = session.compatibleRoutes.get(stateKey) ?? [];
  const retained = compatible.filter(
    (url) => Number(metrics?.get(url)?.throughputBps) >= requiredBps
  );
  if (retained.length) {
    session.compatibleRoutes.set(stateKey, retained);
  } else {
    session.compatibleRoutes.delete(stateKey);
  }
  if (!metrics) {
    return retained.length !== compatible.length;
  }
  const retainedUrls = new Set(retained);
  for (const url of metrics.keys()) {
    if (!retainedUrls.has(url)) {
      metrics.delete(url);
    }
  }
  if (!metrics.size) {
    session.compatibleRouteThroughputs.delete(stateKey);
  }
  return retained.length !== compatible.length;
}

function senderDocumentId(sender) {
  return String(sender?.documentId ?? "").slice(0, 160);
}

function retireDocument(tabId, documentId) {
  if (!documentId) {
    return;
  }
  const now = Date.now();
  const retired = tabRetiredDocuments.get(tabId) ?? new Map();
  for (const [id, retiredAt] of retired) {
    if (now - retiredAt > RETIRED_DOCUMENT_TTL_MS) {
      retired.delete(id);
    }
  }
  retired.delete(documentId);
  retired.set(documentId, now);
  while (retired.size > MAX_RETIRED_DOCUMENTS_PER_TAB) {
    retired.delete(retired.keys().next().value);
  }
  tabRetiredDocuments.set(tabId, retired);
}

async function evictPlaybackSession(
  tabId,
  session,
  reason = "Inactive playback session evicted"
) {
  if (tabPlaybackSessions.get(tabId) !== session) {
    return false;
  }
  clearTimeout(sessionExpiryTimers.get(tabId));
  sessionExpiryTimers.delete(tabId);
  probeScheduler.cancelTab(tabId, reason);
  clearCircuitTimersForTab(tabId);
  clearNativeBypassTimersForTab(tabId);
  sessionTabBindings.delete(session.sessionId);
  tabPlaybackSessions.delete(tabId);
  tabRetiredDocuments.delete(tabId);
  await removeTabSessionRules(tabId);
  tabRuleBlocks.delete(tabId);
  return true;
}

function schedulePlaybackSessionExpiry(tabId, session) {
  clearTimeout(sessionExpiryTimers.get(tabId));
  const remaining = Math.max(
    1,
    INACTIVE_SESSION_TTL_MS - (Date.now() - session.lastActiveAt)
  );
  const timer = setTimeout(() => {
    sessionExpiryTimers.delete(tabId);
    if (tabPlaybackSessions.get(tabId) !== session) {
      return;
    }
    if (Date.now() - session.lastActiveAt < INACTIVE_SESSION_TTL_MS) {
      schedulePlaybackSessionExpiry(tabId, session);
      return;
    }
    void evictPlaybackSession(tabId, session).catch(() => {});
  }, remaining);
  timer?.unref?.();
  sessionExpiryTimers.set(tabId, timer);
}

async function ensureTabTrackingCapacity(tabId) {
  const now = Date.now();
  const expired = [...tabPlaybackSessions.entries()].filter(
    ([trackedTabId, session]) =>
      trackedTabId !== tabId &&
      now - session.lastActiveAt >= INACTIVE_SESSION_TTL_MS
  );
  await Promise.all(
    expired.map(([trackedTabId, session]) =>
      evictPlaybackSession(trackedTabId, session)
    )
  );
  if (tabPlaybackSessions.has(tabId) || tabPlaybackSessions.size < MAX_TRACKED_TABS) {
    return;
  }
  const inactive = [...tabPlaybackSessions.entries()]
    .filter(
      ([, session]) =>
        now - session.lastActiveAt > INACTIVE_SESSION_TTL_MS
    )
    .sort((left, right) => left[1].lastActiveAt - right[1].lastActiveAt);
  const victim = inactive[0];
  if (!victim) {
    throw new Error("Playback tracking capacity reached");
  }
  const [victimTabId, victimSession] = victim;
  await evictPlaybackSession(victimTabId, victimSession);
}

async function reserveTabTrackingSlot(tabId) {
  if (tabPlaybackSessions.has(tabId) || reservedTabStarts.has(tabId)) {
    return false;
  }
  if (
    tabPlaybackSessions.size + reservedTabStarts.size >=
    MAX_TRACKED_TABS
  ) {
    await ensureTabTrackingCapacity(tabId);
  }
  if (
    tabPlaybackSessions.size + reservedTabStarts.size >=
    MAX_TRACKED_TABS
  ) {
    throw new Error("Playback tracking capacity reached");
  }
  reservedTabStarts.add(tabId);
  try {
    await ensureTabTrackingCapacity(tabId);
    return true;
  } catch (error) {
    reservedTabStarts.delete(tabId);
    throw error;
  }
}

async function startPlaybackSessionNow(message, sender, tabId) {
  if (!isSupportedPlaybackPageUrl(message.pageUrl)) {
    throw new Error("Unsupported playback page");
  }
  const reserved = await reserveTabTrackingSlot(tabId);
  try {
    const sessionId = String(message.sessionId ?? "");
    if (!isPlaybackSessionId(sessionId)) {
      throw new Error("Invalid playback session ID");
    }
    const existing = tabPlaybackSessions.get(tabId);
    const documentId = senderDocumentId(sender);
    if (existing?.sessionId === sessionId) {
      if (
        existing.documentId &&
        documentId &&
        existing.documentId !== documentId
      ) {
        throw new Error("Playback session belongs to a different document");
      }
      sessionTabBindings.set(sessionId, tabId);
      existing.lastActiveAt = Date.now();
      schedulePlaybackSessionExpiry(tabId, existing);
      return { tabId, session: existing };
    }
    const clientEpoch = Math.max(0, Number(message.sessionEpoch) || 0);
    const documentStartedAt = Math.max(
      0,
      Number(message.documentStartedAt) || 0
    );
    if (existing) {
      const documentsDiffer = Boolean(
        existing.documentId &&
        documentId &&
        existing.documentId !== documentId
      );
      if (documentsDiffer) {
        if (
          existing.documentStartedAt &&
          documentStartedAt &&
          documentStartedAt <= existing.documentStartedAt
        ) {
          return { tabId, session: existing };
        }
        const retiredDocuments = tabRetiredDocuments.get(tabId);
        if (retiredDocuments?.has(documentId)) {
          if (
            !message.restoredFromBfcache ||
            documentStartedAt <= existing.documentStartedAt
          ) {
            return { tabId, session: existing };
          }
          retiredDocuments.delete(documentId);
        }
        retireDocument(tabId, existing.documentId);
      } else if (clientEpoch <= existing.clientEpoch) {
        return { tabId, session: existing };
      }
    }
    const session = createPlaybackSession(
      sessionId,
      message.pageUrl,
      clientEpoch,
      documentId,
      documentStartedAt
    );
    if (existing) {
      probeScheduler.cancelTab(tabId, "Playback session changed");
      clearCircuitTimersForTab(tabId);
      clearNativeBypassTimersForTab(tabId);
      sessionTabBindings.delete(existing.sessionId);
    }
    sessionTabBindings.set(sessionId, tabId);
    tabPlaybackSessions.set(tabId, session);
    schedulePlaybackSessionExpiry(tabId, session);
    await removeTabSessionRules(tabId);
    return { tabId, session };
  } finally {
    if (reserved) {
      reservedTabStarts.delete(tabId);
    }
  }
}

function startPlaybackSession(message, sender) {
  const tabId = requireTabId(message, sender);
  const previous = tabSessionStartChains.get(tabId) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => startPlaybackSessionNow(message, sender, tabId));
  const settled = current.then(
    () => undefined,
    () => undefined
  );
  tabSessionStartChains.set(tabId, settled);
  void settled.finally(() => {
    if (tabSessionStartChains.get(tabId) === settled) {
      tabSessionStartChains.delete(tabId);
    }
  });
  return current;
}

function requirePlaybackSession(message, sender) {
  const tabId = requireTabId(message, sender);
  const sessionId = String(message.sessionId ?? "");
  const session = tabPlaybackSessions.get(tabId);
  if (!isPlaybackSessionId(sessionId) || session?.sessionId !== sessionId) {
    throw new Error("Stale or unknown playback session");
  }
  const documentId = senderDocumentId(sender);
  if (
    session.documentId &&
    documentId &&
    session.documentId !== documentId
  ) {
    throw new Error("Stale playback document");
  }
  session.lastActiveAt = Date.now();
  schedulePlaybackSessionExpiry(tabId, session);
  return { tabId, session, sessionId };
}

function sanitizePresentationId(value) {
  const raw = String(value ?? "").slice(0, 160);
  return /^[a-zA-Z0-9._:-]{1,160}$/.test(raw) ? raw : "unassigned";
}

function sanitizeObservedProbeReference(message) {
  if (message?.observedReference !== true) {
    return null;
  }
  const sampleHash = String(message.referenceHash ?? "").toLowerCase();
  const status = Number(message.referenceStatus) || 0;
  const bytes = Number(message.referenceBytes) || 0;
  if (
    !/^[0-9a-f]{64}$/.test(sampleHash) ||
    (status !== 200 && status !== 206) ||
    bytes < PROBE_BYTES
  ) {
    throw new Error("Rejected observed probe reference");
  }
  return {
    sampleHash,
    status,
    // Never trust a page-supplied accounting value beyond the exact sample
    // size used by the compatibility gate.
    bytes: PROBE_BYTES
  };
}

function routeStateKey(presentationId, routeKey) {
  return `${sanitizePresentationId(presentationId)}::${routeKey}`;
}

function rememberProbeReference(session, stateKey, evidence) {
  const sampleHash = String(evidence?.sampleHash ?? "").toLowerCase();
  const status = Number(evidence?.status) || 0;
  const bytes = Number(evidence?.bytes) || 0;
  if (
    !/^[0-9a-f]{64}$/.test(sampleHash) ||
    (status !== 200 && status !== 206) ||
    bytes < PROBE_BYTES
  ) {
    return false;
  }
  const previous = session.probeReferences.get(stateKey);
  if (previous && previous.sampleHash !== sampleHash) {
    session.probeCandidateCursors.delete(stateKey);
    session.probeCandidateStates.delete(stateKey);
    session.compatibleRoutes.delete(stateKey);
    session.compatibleRouteThroughputs.delete(stateKey);
  }
  session.probeReferences.set(stateKey, {
    sampleHash,
    status,
    bytes: PROBE_BYTES
  });
  return true;
}

function findSessionRoute(session, presentationId, routeKey) {
  const normalizedPresentation = sanitizePresentationId(presentationId);
  const exact = session.routes.get(
    routeStateKey(normalizedPresentation, routeKey)
  );
  if (exact) {
    return exact;
  }
  if (normalizedPresentation !== "unassigned") {
    return null;
  }
  const matches = [...session.routes.values()].filter(
    (route) => route.routeKey === routeKey
  );
  return matches.length === 1 ? matches[0] : null;
}

function sanitizeMediaRoutes(input) {
  const routes = [];
  for (const candidate of Array.isArray(input) ? input.slice(0, 64) : []) {
    const urls = uniqueStrings([
      ...(Array.isArray(candidate?.urls) ? candidate.urls : []),
      ...(Array.isArray(candidate?.originalUrls) ? candidate.originalUrls : [])
    ])
      .filter((url) => url.length <= 4096 && isMediaResourceUrl(url))
      .slice(0, 8);
    if (!urls.length) {
      continue;
    }
    const routeKey = mediaRouteKey(urls[0]);
    const sameRepresentation = urls.filter(
      (url) => mediaRouteKey(url) === routeKey
    );
    if (!sameRepresentation.length) {
      continue;
    }
    const presentationId = sanitizePresentationId(candidate.presentationId);
    routes.push({
      stateKey: routeStateKey(presentationId, routeKey),
      presentationId,
      routeKey,
      urls: sameRepresentation,
      bandwidth: Math.min(
        200_000_000,
        Math.max(0, Number(candidate.bandwidth) || 0)
      ),
      kind: String(candidate.kind ?? "").slice(0, 20)
    });
  }
  return routes;
}

async function registerMediaRoutes(message, sender) {
  const { tabId, session, sessionId } = requirePlaybackSession(message, sender);
  const state = await readState();
  const blockedPatterns = state.rules.cdnPool.blocked.map(
    (entry) => entry.pattern
  );
  let routeCapacityChanged = false;
  for (const route of sanitizeMediaRoutes(message.routes)) {
    const presentations = new Set(
      [...session.routes.values()].map((entry) => entry.presentationId)
    );
    if (
      !presentations.has(route.presentationId) &&
      presentations.size >= MAX_PRESENTATIONS_PER_TAB
    ) {
      continue;
    }
    const presentationRouteCount = [...session.routes.values()].filter(
      (entry) => entry.presentationId === route.presentationId
    ).length;
    if (
      !session.routes.has(route.stateKey) &&
      presentationRouteCount >= MAX_ROUTES_PER_PRESENTATION
    ) {
      continue;
    }
    const existing = session.routes.get(route.stateKey);
    if (
      existing &&
      Number(existing.bandwidth) !== Number(route.bandwidth)
    ) {
      session.probeCandidateCursors.delete(route.stateKey);
      session.probeCandidateStates.delete(route.stateKey);
    }
    const merged = {
      ...route,
      urls: uniqueStrings([...(existing?.urls ?? []), ...route.urls]),
      updatedAt: Date.now(),
      lastActiveAt: existing?.lastActiveAt ?? 0
    };
    session.routes.set(route.stateKey, merged);
    routeCapacityChanged =
      pruneUnderpoweredRouteCandidates(session, merged) ||
      routeCapacityChanged;
    const safeTarget = merged.urls.find(
      (url) => !hostnameMatches(getHostname(url), blockedPatterns)
    );
    if (safeTarget) {
      const staticallyBlocked = new Set(
        merged.urls
          .map(getHostname)
          .filter((host) => hostnameMatches(host, blockedPatterns))
          .slice(0, MAX_HOSTS_PER_ROUTE)
      );
      if (staticallyBlocked.size) {
        const blocked =
          session.degradedRoutes.get(route.stateKey) ?? new Set();
        for (const host of staticallyBlocked) {
          blocked.add(host);
        }
        session.degradedRoutes.set(route.stateKey, blocked);
      }
    }
  }
  if (session.degradedRoutes.size) {
    await replaceTabSessionRules(tabId, session);
  }
  return {
    sessionId,
    routeCount: session.routes.size,
    ruleCount: session.ruleCount,
    resourceStats: routingResourceStats(tabId),
    ...(routeCapacityChanged
      ? { config: await buildRuntimeConfig(state, tabId) }
      : {})
  };
}

function runtimeProbeEntry(result, requiredBps = 0, routeAllowed = true) {
  const routeQualified =
    routeAllowed &&
    (!requiredBps || Number(result.throughputBps) >= requiredBps);
  return {
    host: result.host,
    healthy: Boolean(
      result.eligible !== false &&
        result.healthy &&
        result.compatible &&
        routeQualified
    ),
    compatible: Boolean(result.compatible),
    routeQualified,
    requiredBps: Math.max(0, Math.round(requiredBps)),
    status: Number(result.status) || 0,
    bytes: Number(result.bytes) || 0,
    ttfbMs: Number(result.ttfbMs) || 0,
    transferDurationMs: Number(result.transferDurationMs) || 0,
    durationMs: Number(result.durationMs) || 0,
    throughputBps: Number(result.throughputBps) || 0,
    measuredAt: Number(result.measuredAt) || Date.now(),
    error: String(result.error ?? "").slice(0, 160)
  };
}

function decodeProbeBodyBase64(value, declaredBytes) {
  const encoded = String(value ?? "");
  const bytes = Math.max(0, Number(declaredBytes) || 0);
  const maxEncodedLength = Math.ceil(PROBE_BYTES / 3) * 4;
  if (
    bytes > PROBE_BYTES ||
    encoded.length > maxEncodedLength ||
    (
      encoded &&
      (
        encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      )
    )
  ) {
    throw new Error("Rejected malformed page probe body");
  }
  let binary;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("Rejected malformed page probe body");
  }
  if (binary.length !== bytes) {
    throw new Error("Rejected mismatched page probe body");
  }
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

function probeFetchThroughTab(
  tabId,
  tabSession,
  presentationId,
  routeKey
) {
  return (targetUrl, init = {}) =>
    new Promise((resolve, reject) => {
      const startedAt = performance.now();
      if (
        tabPlaybackSessions.get(tabId) !== tabSession ||
        init.signal?.aborted
      ) {
        reject(new Error("Page probe cancelled"));
        return;
      }
      const probeId =
        crypto.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const message = {
        type: "RUN_PAGE_PROBE_FETCH",
        version: 1,
        probeId,
        sessionId: tabSession.sessionId,
        sessionEpoch: tabSession.clientEpoch,
        presentationId,
        routeKey,
        targetUrl
      };
      const target = tabSession.documentId
        ? { documentId: tabSession.documentId }
        : { frameId: 0 };
      let settled = false;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        init.signal?.removeEventListener?.("abort", onAbort);
        callback(value);
      };
      const onAbort = () => {
        void chrome.tabs
          .sendMessage(
            tabId,
            {
              type: "CANCEL_PAGE_PROBE_FETCH",
              version: 1,
              probeId,
              sessionId: tabSession.sessionId
            },
            target
          )
          .catch(() => {});
        finish(reject, new Error("Page probe cancelled"));
      };
      init.signal?.addEventListener?.("abort", onAbort, { once: true });
      chrome.tabs
        .sendMessage(tabId, message, target)
        .then((result) => {
          if (
            settled ||
            tabPlaybackSessions.get(tabId) !== tabSession
          ) {
            finish(reject, new Error("Page probe session changed"));
            return;
          }
          if (
            !result?.ok ||
            result.type !== "PAGE_PROBE_FETCH_RESULT" ||
            result.version !== 1 ||
            result.probeId !== probeId ||
            result.sessionId !== tabSession.sessionId
          ) {
            throw new Error(
              String(result?.error ?? "Invalid page probe response").slice(
                0,
                160
              )
            );
          }
          const status = Number(result.status);
          if (
            !Number.isInteger(status) ||
            status < 0 ||
            status > 599
          ) {
            throw new Error("Rejected invalid page probe status");
          }
          const body = decodeProbeBodyBase64(
            result.bodyBase64,
            result.bytes
          );
          const reportedTiming = {
            ttfbMs: Number(result.ttfbMs),
            transferDurationMs: Number(result.transferDurationMs),
            durationMs: Number(result.durationMs)
          };
          const validReportedTiming =
            Object.values(reportedTiming).every(Number.isFinite) &&
            reportedTiming.ttfbMs >= 0 &&
            reportedTiming.transferDurationMs >= 0 &&
            reportedTiming.durationMs >= 1 &&
            reportedTiming.durationMs <= PROBE_TIMEOUT_MS + 1000 &&
            reportedTiming.ttfbMs <= reportedTiming.durationMs &&
            reportedTiming.transferDurationMs <=
              reportedTiming.durationMs &&
            Math.abs(
              reportedTiming.durationMs -
                reportedTiming.ttfbMs -
                reportedTiming.transferDurationMs
            ) <= 5;
          const legacyDurationMs = Math.max(
            1,
            Math.round(performance.now() - startedAt)
          );
          finish(resolve, {
            status,
            url: String(result.finalUrl ?? "").slice(0, 4096),
            body: null,
            probeTiming: validReportedTiming
              ? reportedTiming
              : {
                  // During an extension update an older content script can
                  // answer without timing fields. Preserve the old,
                  // conservative wall-clock estimate for that one request.
                  ttfbMs: 0,
                  transferDurationMs: legacyDurationMs,
                  durationMs: legacyDurationMs
                },
            async arrayBuffer() {
              return body.buffer.slice(
                body.byteOffset,
                body.byteOffset + body.byteLength
              );
            }
          });
        })
        .catch((error) => {
          finish(
            reject,
            error instanceof Error ? error : new Error(String(error))
          );
        });
    });
}

async function performProbe(
  mediaUrl,
  tabId,
  sessionId,
  presentationId = "unassigned",
  requestedRouteKey = "",
  referenceEvidence = null,
  recovery = false,
  signal
) {
  const tabSession = tabPlaybackSessions.get(tabId);
  if (tabSession?.sessionId !== sessionId) {
    throw new Error("Probe belongs to a stale playback session");
  }
  const state = await readState();
  const { settings, runtime, rules } = state;
  if (
    !settings.globalEnabled ||
    !settings.acceleration.enabled ||
    settings.acceleration.strategy !== "auto"
  ) {
    return {
      value: {
        config: await buildRuntimeConfig(state, tabId),
        probeOutcome: {
          attemptedPoolCandidates: 0,
          qualifiedCandidates: 0,
          compatiblePoolCandidates: 0,
          underpoweredPoolCandidates: 0,
          underpoweredPoolSeen: false,
          coveredPoolCandidates: 0,
          candidatePoolSize: 0,
          poolExhausted: false
        }
      },
      bytes: 0
    };
  }
  let probeBytes = 0;
  const suppliedRouteKey =
    requestedRouteKey || mediaRouteKey(mediaUrl);
  const registeredRoute = findSessionRoute(
    tabSession,
    presentationId,
    suppliedRouteKey
  );
  if (
    !registeredRoute ||
    !registeredRoute.urls.includes(mediaUrl)
  ) {
    throw new Error("Probe URL is not registered for this playback route");
  }
  const routeKey = registeredRoute.routeKey;
  const exactPresentationId = registeredRoute.presentationId;
  const blockedPatterns = (rules.cdnPool.blocked ?? []).map(
    (entry) => entry.pattern
  );
  const stateKey = registeredRoute.stateKey;
  if (referenceEvidence) {
    rememberProbeReference(tabSession, stateKey, referenceEvidence);
  }
  const currentlyBlockedHosts =
    tabSession.degradedRoutes.get(stateKey) ?? new Set();
  // A route may have been captured before the latest blocked-host policy was
  // applied. Never spend the bounded reference probe on that stale first URL
  // when the same registered representation has an unblocked exact backup.
  const referenceUrl = referenceEvidence
    ? mediaUrl
    : uniqueStrings([mediaUrl, ...registeredRoute.urls]).find(
        (url) => {
          const host = getHostname(url);
          return (
            !currentlyBlockedHosts.has(host) &&
            !hostnameMatches(host, blockedPatterns)
          );
        }
      );
  if (!referenceUrl) {
    throw new Error("No unblocked page probe reference is available");
  }
  const availableProbePool = {
    ...rules.cdnPool,
    preferred: rules.cdnPool.preferred.filter(
      (entry) => !currentlyBlockedHosts.has(entry.host)
    ),
    conditional: rules.cdnPool.conditional.filter(
      (entry) => !currentlyBlockedHosts.has(entry.host)
    )
  };
  const boundedCandidateHosts = candidateHosts(availableProbePool)
    .filter((host) => host !== getHostname(referenceUrl))
    .slice(0, MAX_PROBE_CANDIDATES_PER_SWEEP);
  const boundedCandidateSet = new Set(boundedCandidateHosts);
  const candidateStates =
    tabSession.probeCandidateStates.get(stateKey) ?? new Map();
  for (const host of candidateStates.keys()) {
    if (!boundedCandidateSet.has(host)) {
      candidateStates.delete(host);
    }
  }
  const hostsToProbe = recovery
    ? boundedCandidateHosts.filter((host) => !candidateStates.has(host))
    : boundedCandidateHosts;
  const hostsToProbeSet = new Set(hostsToProbe);
  const probePool = {
    ...availableProbePool,
    preferred: availableProbePool.preferred.filter((entry) =>
      hostsToProbeSet.has(entry.host)
    ),
    conditional: availableProbePool.conditional.filter((entry) =>
      hostsToProbeSet.has(entry.host)
    )
  };
  const hostCount = boundedCandidateHosts.length;
  const candidateOffset =
    recovery
      ? 0
      : tabSession.probeCandidateCursors.get(stateKey) ?? 0;
  const result = await probeMediaPath({
    mediaUrl: referenceUrl,
    pool: probePool,
    // Compatibility is scoped to this signed representation. Never reuse a
    // different video's host-only result as permission to rewrite this URL.
    cache: {},
    cacheMinutes: 0,
    maxCandidates: MAX_PROBE_CANDIDATES_PER_ROUTE,
    candidateConcurrency: 1,
    candidateOffset,
    referenceEvidence,
    fetchImpl: probeFetchThroughTab(
      tabId,
      tabSession,
      exactPresentationId,
      routeKey
    ),
    signal,
    onBytes(bytes) {
      probeBytes += Math.max(0, Number(bytes) || 0);
    }
  });
  if (tabPlaybackSessions.get(tabId) !== tabSession) {
    throw new Error("Probe completed after playback session changed");
  }
  if (
    result.reference?.healthy &&
    /^[0-9a-f]{64}$/.test(String(result.reference.sampleHash ?? "")) &&
    (
      result.reference.status === 200 ||
      result.reference.status === 206
    ) &&
    Number(result.reference.bytes) >= PROBE_BYTES
  ) {
    rememberProbeReference(tabSession, stateKey, result.reference);
  }
  // A failed reference does not test any pool candidate. Advance by the
  // candidates actually attempted so transient reference failures cannot
  // silently skip the highest-priority hosts on the next recovery probe.
  const attemptedPoolCandidates = result.results.filter(
    (entry) => entry.source === "pool"
  ).length;
  if (!recovery && hostCount && attemptedPoolCandidates) {
    tabSession.probeCandidateCursors.set(
      stateKey,
      (candidateOffset + attemptedPoolCandidates) % hostCount
    );
  }
  const requiredBps = routeRequiredThroughput(registeredRoute);
  const compatiblePoolResults = result.results.filter(
    (entry) =>
      entry.source === "pool" &&
      entry.eligible !== false &&
      entry.healthy &&
      entry.compatible &&
      !currentlyBlockedHosts.has(entry.host)
  );
  const underpoweredPoolResults = compatiblePoolResults.filter(
    (entry) =>
      requiredBps && Number(entry.throughputBps) < requiredBps
  );
  const underpoweredHosts = new Set(
    underpoweredPoolResults.map((entry) => entry.host)
  );
  const compatibleHosts = new Set(
    compatiblePoolResults.map((entry) => entry.host)
  );
  for (const entry of result.results) {
    if (
      entry.source !== "pool" ||
      !boundedCandidateSet.has(entry.host)
    ) {
      continue;
    }
    candidateStates.set(
      entry.host,
      underpoweredHosts.has(entry.host)
        ? "underpowered"
        : compatibleHosts.has(entry.host)
          ? "qualified"
          : "failed"
    );
  }
  if (candidateStates.size) {
    tabSession.probeCandidateStates.set(stateKey, candidateStates);
  } else {
    tabSession.probeCandidateStates.delete(stateKey);
  }
  const coveredPoolCandidates = candidateStates.size;
  const underpoweredPoolSeen = [...candidateStates.values()].some(
    (value) => value === "underpowered"
  );
  const poolExhausted =
    hostCount > 0 && coveredPoolCandidates >= hostCount;
  const qualifiedResults = result.results.filter(
    (entry) =>
      entry.eligible !== false &&
      entry.healthy &&
      entry.compatible &&
      !currentlyBlockedHosts.has(entry.host) &&
      (!requiredBps || Number(entry.throughputBps) >= requiredBps)
  );
  const qualifiedHosts = new Set(qualifiedResults.map((entry) => entry.host));
  const measuredHosts = new Set(
    result.results
      // Reused byte-zero evidence proves content identity but does not
      // remeasure that host's capacity. It must not erase a prior, real
      // candidate measurement merely because its URL carried the hash.
      .filter((entry) => entry.source !== "observed-reference")
      .map((entry) => entry.host)
  );
  const compatibleMetrics =
    tabSession.compatibleRouteThroughputs.get(stateKey) ?? new Map();
  for (const [url] of compatibleMetrics) {
    if (measuredHosts.has(getHostname(url))) {
      compatibleMetrics.delete(url);
    }
  }
  for (const entry of qualifiedResults) {
    if (!entry.targetUrl) {
      continue;
    }
    compatibleMetrics.set(entry.targetUrl, {
      throughputBps: Math.max(0, Number(entry.throughputBps) || 0),
      measuredAt: Math.max(0, Number(entry.measuredAt) || Date.now())
    });
  }
  const newlyCompatibleUrls = qualifiedResults
    .filter(
      (entry) => entry.targetUrl
    )
    .sort(
      (left, right) =>
        right.throughputBps - left.throughputBps || left.ttfbMs - right.ttfbMs
    )
    .map((entry) => entry.targetUrl);
  // A rotated recovery probe tests a different bounded subset of candidates.
  // Keep earlier byte-verified URLs for this exact signed representation;
  // replacing the set with only the latest subset could erase the one usable
  // fallback at the moment the active host degrades.
  const earlierCompatibleUrls = (tabSession.compatibleRoutes.get(stateKey) ?? [])
    .filter((url) => {
      const host = getHostname(url);
      const stillQualified =
        !requiredBps ||
        Number(compatibleMetrics.get(url)?.throughputBps) >= requiredBps;
      return (
        !currentlyBlockedHosts.has(host) &&
        stillQualified &&
        (!measuredHosts.has(host) || qualifiedHosts.has(host))
      );
    });
  const compatibleUrls = uniqueStrings([
    ...newlyCompatibleUrls,
    ...earlierCompatibleUrls
  ])
    .filter(
      (url) =>
        isMediaResourceUrl(url) &&
        mediaRouteKey(url) === routeKey
    )
    .slice(0, MAX_HOSTS_PER_ROUTE);
  tabSession.compatibleRoutes.set(stateKey, compatibleUrls);
  const retainedCompatibleUrls = new Set(compatibleUrls);
  for (const url of compatibleMetrics.keys()) {
    if (!retainedCompatibleUrls.has(url)) {
      compatibleMetrics.delete(url);
    }
  }
  if (compatibleMetrics.size) {
    tabSession.compatibleRouteThroughputs.set(stateKey, compatibleMetrics);
  } else {
    tabSession.compatibleRouteThroughputs.delete(stateKey);
  }
  if (tabSession.degradedRoutes.size) {
    await replaceTabSessionRules(tabId, tabSession);
  }
  const nextRuntime = await mutateRuntimeState((current) => ({
    ...current,
    probeCache: {
      ...current.probeCache,
      ...Object.fromEntries(
        result.results.map((entry) => [
          entry.host,
          runtimeProbeEntry(
            entry,
            requiredBps,
            !currentlyBlockedHosts.has(entry.host)
          )
        ])
      )
    },
    rankedHosts: qualifiedResults
      .slice()
      .sort(
        (left, right) =>
          right.throughputBps - left.throughputBps ||
          left.ttfbMs - right.ttfbMs
      )
      .map((entry) => entry.host),
    selectedHost: qualifiedResults
      .slice()
      .sort(
        (left, right) =>
          right.throughputBps - left.throughputBps ||
          left.ttfbMs - right.ttfbMs
      )[0]?.host ?? "",
    lastProbeAt: Date.now()
  }));
  if (recovery && poolExhausted) {
    // The bridge may choose a session-long capacity bypass, or only a finite
    // retry when every candidate failed for a transient reason. In either
    // case the completed sweep must not make a later finite retry a zero-work
    // loop over permanently "seen" hosts.
    tabSession.probeCandidateStates.delete(stateKey);
    tabSession.probeCandidateCursors.set(stateKey, 0);
  }
  return {
    value: {
      config: await buildRuntimeConfig(
        { ...state, runtime: nextRuntime },
        tabId
      ),
      probeOutcome: {
        attemptedPoolCandidates,
        qualifiedCandidates: qualifiedResults.length,
        compatiblePoolCandidates: compatiblePoolResults.length,
        underpoweredPoolCandidates: underpoweredPoolResults.length,
        underpoweredPoolSeen,
        coveredPoolCandidates,
        candidatePoolSize: hostCount,
        poolExhausted
      }
    },
    bytes: probeBytes
  };
}

function queueProbe(
  mediaUrl,
  tabId,
  sessionId,
  presentationId = "unassigned",
  requestedRouteKey = "",
  referenceEvidence = null,
  recovery = false
) {
  const routeKey = requestedRouteKey || mediaRouteKey(mediaUrl);
  const activeSession = tabPlaybackSessions.get(tabId);
  const registeredRoute =
    activeSession?.sessionId === sessionId
      ? findSessionRoute(activeSession, presentationId, routeKey)
      : null;
  const stateKey =
    registeredRoute?.stateKey ??
    routeStateKey(presentationId, routeKey);
  const storedReference =
    activeSession?.sessionId === sessionId
      ? activeSession.probeReferences.get(stateKey) ?? null
      : null;
  const effectiveReferenceEvidence =
    referenceEvidence ?? storedReference;
  const key =
    `${tabId}:${sessionId}:` +
    `${stateKey}\u0000${getHostname(mediaUrl)}` +
    `${effectiveReferenceEvidence ? "\u0000verified" : "\u0000network"}` +
    `${recovery ? "\u0000recovery" : "\u0000normal"}`;
  if (!probeJobs.has(key)) {
    const job = probeScheduler.schedule({
      tabId,
      estimatedBytes:
        PROBE_BYTES * (effectiveReferenceEvidence ? 2 : 3),
      run: (signal) =>
        performProbe(
          mediaUrl,
          tabId,
          sessionId,
          presentationId,
          routeKey,
          effectiveReferenceEvidence,
          recovery,
          signal
        )
    }).finally(() => {
        if (probeJobs.get(key) === job) {
          probeJobs.delete(key);
        }
      });
    probeJobs.set(key, job);
  }
  return probeJobs.get(key);
}

function hostCircuitKey(stateKey, host) {
  return `${stateKey}\u0000${host}`;
}

function circuitTimerKey(tabId, sessionId, stateKey, host) {
  return `${tabId}:${sessionId}:${hostCircuitKey(stateKey, host)}`;
}

function clearCircuitTimersForTab(tabId) {
  for (const [key, timer] of circuitTimers) {
    if (key.startsWith(`${tabId}:`)) {
      clearTimeout(timer);
      circuitTimers.delete(key);
    }
  }
}

function nativeBypassTimerKey(tabId, sessionId, stateKey) {
  return `${tabId}:${sessionId}:${stateKey}`;
}

function clearNativeBypassTimersForTab(tabId) {
  for (const [key, timer] of nativeBypassTimers) {
    if (key.startsWith(`${tabId}:`)) {
      clearTimeout(timer);
      nativeBypassTimers.delete(key);
    }
  }
}

function scheduleNativeRouteBypassExpiry(tabId, session, stateKey) {
  const key = nativeBypassTimerKey(tabId, session.sessionId, stateKey);
  clearTimeout(nativeBypassTimers.get(key));
  const until = session.nativeBypassRoutes.get(stateKey) ?? 0;
  const timer = setTimeout(() => {
    nativeBypassTimers.delete(key);
    void (async () => {
      const active = tabPlaybackSessions.get(tabId);
      if (active !== session) {
        return;
      }
      const activeUntil = active.nativeBypassRoutes.get(stateKey) ?? 0;
      if (activeUntil > Date.now()) {
        scheduleNativeRouteBypassExpiry(tabId, active, stateKey);
        return;
      }
      active.nativeBypassRoutes.delete(stateKey);
      await replaceTabSessionRules(tabId, active);
    })().catch(() => {});
  }, Math.min(2_147_483_647, Math.max(1, until - Date.now() + 1)));
  timer?.unref?.();
  nativeBypassTimers.set(key, timer);
}

async function bypassPlaybackRoute(message, sender) {
  const { tabId, session, sessionId } = requirePlaybackSession(message, sender);
  const presentationId = sanitizePresentationId(message.presentationId);
  const routeKey = String(message.routeKey ?? "").slice(0, 1000);
  const route = findSessionRoute(session, presentationId, routeKey);
  if (!route || route.presentationId !== presentationId) {
    throw new Error("Rejected native route bypass");
  }
  const persistent = message.persistent === true;
  const now = Date.now();
  const requestedUntil = Math.max(now + 1_000, Number(message.until) || 0);
  const until = persistent
    ? Number.POSITIVE_INFINITY
    : Math.min(now + MAX_NATIVE_ROUTE_BYPASS_MS, requestedUntil);
  const timerKey = nativeBypassTimerKey(
    tabId,
    session.sessionId,
    route.stateKey
  );
  const hadPrevious = session.nativeBypassRoutes.has(route.stateKey);
  const previousUntil =
    session.nativeBypassRoutes.get(route.stateKey) ?? 0;
  clearTimeout(nativeBypassTimers.get(timerKey));
  nativeBypassTimers.delete(timerKey);
  session.nativeBypassRoutes.set(route.stateKey, until);
  let ruleCount;
  try {
    ruleCount = await replaceTabSessionRules(tabId, session);
  } catch (error) {
    if (hadPrevious) {
      session.nativeBypassRoutes.set(route.stateKey, previousUntil);
      if (Number.isFinite(previousUntil)) {
        scheduleNativeRouteBypassExpiry(
          tabId,
          session,
          route.stateKey
        );
      }
    } else {
      session.nativeBypassRoutes.delete(route.stateKey);
    }
    throw error;
  }
  if (persistent) {
    // A finite bypass request may have shared this debounced DNR update and
    // resumed first. Remove any timer it could have scheduled for the route
    // that is now authoritatively persistent.
    clearTimeout(nativeBypassTimers.get(timerKey));
    nativeBypassTimers.delete(timerKey);
  } else if (
    session.nativeBypassRoutes.get(route.stateKey) === until
  ) {
    scheduleNativeRouteBypassExpiry(tabId, session, route.stateKey);
  }
  return {
    sessionId,
    presentationId: route.presentationId,
    routeKey: route.routeKey,
    persistent,
    bypassUntil: persistent ? 0 : until,
    ruleCount,
    resourceStats: routingResourceStats(tabId),
    config: await buildRuntimeConfig(null, tabId)
  };
}

function scheduleCircuitCooldown(tabId, session, stateKey, host) {
  const circuit = session.hostCircuits.get(hostCircuitKey(stateKey, host));
  if (!circuit || circuit.circuit !== "open") {
    return;
  }
  const key = circuitTimerKey(tabId, session.sessionId, stateKey, host);
  clearTimeout(circuitTimers.get(key));
  const delay = Math.max(0, circuit.cooldownUntil - Date.now());
  const timer = setTimeout(() => {
    circuitTimers.delete(key);
    void (async () => {
      const active = tabPlaybackSessions.get(tabId);
      if (active !== session) {
        return;
      }
      const circuitKey = hostCircuitKey(stateKey, host);
      const advanced = advanceHostCircuit(
        active.hostCircuits.get(circuitKey),
        Date.now()
      );
      active.hostCircuits.set(circuitKey, advanced.state);
      if (advanced.state.circuit !== "half-open") {
        scheduleCircuitCooldown(tabId, active, stateKey, host);
        return;
      }
      const blocked = active.degradedRoutes.get(stateKey);
      blocked?.delete(host);
      if (blocked && !blocked.size) {
        active.degradedRoutes.delete(stateKey);
      }
      await replaceTabSessionRules(tabId, active);
      await pushTabRoutingConfig(tabId, active, "circuit-half-open");
    })().catch(() => {});
  }, Math.min(2_147_483_647, delay + 1));
  circuitTimers.set(key, timer);
}

async function degradePlaybackHost(message, sender, reason = "media-failure") {
  const { tabId, session, sessionId } = requirePlaybackSession(message, sender);
  const host = String(message.host ?? "").toLowerCase();
  const routeKey = String(message.routeKey ?? "").slice(0, 1000);
  const presentationId = sanitizePresentationId(message.presentationId);
  const route = findSessionRoute(session, presentationId, routeKey);
  const stateKey = route?.stateKey ?? routeStateKey(presentationId, routeKey);
  const routeHosts = new Set(
    uniqueStrings([
      ...(route?.urls ?? []),
      ...(session.compatibleRoutes.get(stateKey) ?? [])
    ]).map(getHostname)
  );
  if (
    !route ||
    !isAllowedMediaHostname(host) ||
    !routeHosts.has(host)
  ) {
    throw new Error("Rejected degraded media host");
  }
  const startedAt = performance.now();
  route.lastActiveAt = Date.now();
  const { cdnPool } = await ruleDataPromise;
  const staticallyBlocked = hostnameMatches(
    host,
    cdnPool.blocked.map((entry) => entry.pattern)
  );
  const severity =
    String(reason) === "slow-body" ? "soft" : "hard";
  const circuitKey = hostCircuitKey(stateKey, host);
  const transition = noteCircuitFailure(
    session.hostCircuits.get(circuitKey) ?? createHostCircuit(Date.now()),
    {
      severity,
      reason: String(reason).slice(0, 60),
      now: Date.now()
    }
  );
  const circuitState =
    severity === "hard"
      ? {
          ...transition.state,
          // A real media failure invalidates the small qualification sample
          // for this signed route. Do not automatically reauthorize the same
          // host later in the session merely because wall time passed.
          cooldownUntil: Number.MAX_SAFE_INTEGER,
          quarantined: true
        }
      : transition.state;
  session.hostCircuits.set(circuitKey, circuitState);
  let ruleCount = session.ruleCount;
  if (staticallyBlocked || transition.opened) {
    const blocked = session.degradedRoutes.get(stateKey) ?? new Set();
    const wasBlocked = blocked.has(host);
    if (!wasBlocked && blocked.size >= MAX_HOSTS_PER_ROUTE) {
      throw new Error("Route host-state capacity reached");
    }
    blocked.add(host);
    session.degradedRoutes.set(stateKey, blocked);
    if (!wasBlocked || transition.changed) {
      ruleCount = await replaceTabSessionRules(tabId, session);
    }
    if (!staticallyBlocked && severity === "soft") {
      scheduleCircuitCooldown(tabId, session, stateKey, host);
    } else {
      const timerKey = circuitTimerKey(
        tabId,
        session.sessionId,
        stateKey,
        host
      );
      clearTimeout(circuitTimers.get(timerKey));
      circuitTimers.delete(timerKey);
    }
    if (severity === "hard") {
      const retainedUrls = (
        session.compatibleRoutes.get(stateKey) ?? []
      ).filter((url) => getHostname(url) !== host);
      if (retainedUrls.length) {
        session.compatibleRoutes.set(stateKey, retainedUrls);
      } else {
        session.compatibleRoutes.delete(stateKey);
      }
      const compatibleMetrics =
        session.compatibleRouteThroughputs.get(stateKey);
      if (compatibleMetrics) {
        for (const url of compatibleMetrics.keys()) {
          if (getHostname(url) === host) {
            compatibleMetrics.delete(url);
          }
        }
        if (!compatibleMetrics.size) {
          session.compatibleRouteThroughputs.delete(stateKey);
        }
      }
    }
  }
  const degradedHosts =
    session.degradedRoutes.get(stateKey) ?? new Set();
  const fallbackAvailable = [...routeHosts].some(
    (candidateHost) =>
      candidateHost !== host &&
      isAllowedMediaHostname(candidateHost) &&
      !degradedHosts.has(candidateHost) &&
      !hostnameMatches(
        candidateHost,
        cdnPool.blocked.map((entry) => entry.pattern)
      )
  );
  const escalated = staticallyBlocked || transition.opened;
  return {
    sessionId,
    presentationId: route.presentationId,
    kind: route.kind,
    host,
    routeKey,
    reason: String(reason).slice(0, 60),
    circuit: staticallyBlocked ? "static-open" : circuitState.circuit,
    escalated,
    fallbackAvailable: escalated && fallbackAvailable,
    exhausted: escalated && !fallbackAvailable,
    ruleCount,
    latencyMs: Math.round(performance.now() - startedAt),
    resourceStats: routingResourceStats(tabId),
    config: await buildRuntimeConfig(null, tabId)
  };
}

async function recoverPlaybackHost(message, sender) {
  const { tabId, session, sessionId } = requirePlaybackSession(message, sender);
  const host = String(message.host ?? "").toLowerCase();
  const routeKey = String(message.routeKey ?? "").slice(0, 1000);
  const presentationId = sanitizePresentationId(message.presentationId);
  const route = findSessionRoute(session, presentationId, routeKey);
  const stateKey = route?.stateKey ?? routeStateKey(presentationId, routeKey);
  const routeHosts = new Set(
    uniqueStrings([
      ...(route?.urls ?? []),
      ...(session.compatibleRoutes.get(stateKey) ?? [])
    ]).map(getHostname)
  );
  if (!route || !isAllowedMediaHostname(host) || !routeHosts.has(host)) {
    throw new Error("Rejected recovered media host");
  }
  const { cdnPool } = await ruleDataPromise;
  if (
    hostnameMatches(
      host,
      cdnPool.blocked.map((entry) => entry.pattern)
    )
  ) {
    const blocked = session.degradedRoutes.get(stateKey) ?? new Set();
    const wasBlocked = blocked.has(host);
    blocked.add(host);
    session.degradedRoutes.set(stateKey, blocked);
    const ruleCount = wasBlocked
      ? session.ruleCount
      : await replaceTabSessionRules(tabId, session);
    return {
      sessionId,
      presentationId: route.presentationId,
      routeKey,
      host,
      recovered: false,
      circuit: "static-open",
      ruleCount,
      resourceStats: routingResourceStats(tabId),
      config: await buildRuntimeConfig(null, tabId)
    };
  }
  const circuitKey = hostCircuitKey(stateKey, host);
  const current = session.hostCircuits.get(circuitKey);
  if (!current) {
    return {
      sessionId,
      presentationId: route.presentationId,
      routeKey,
      host,
      recovered: false,
      circuit: "closed",
      ruleCount: session.ruleCount,
      resourceStats: routingResourceStats(tabId),
      config: await buildRuntimeConfig(null, tabId)
    };
  }
  const transition = confirmHostRecovery(current, Date.now());
  session.hostCircuits.set(circuitKey, transition.state);
  let ruleCount = session.ruleCount;
  if (transition.recovered) {
    session.riskCounts.delete(`${stateKey}\u0000${host}`);
    const blocked = session.degradedRoutes.get(stateKey);
    blocked?.delete(host);
    if (blocked && !blocked.size) {
      session.degradedRoutes.delete(stateKey);
    }
    clearTimeout(
      circuitTimers.get(
        circuitTimerKey(tabId, session.sessionId, stateKey, host)
      )
    );
    circuitTimers.delete(
      circuitTimerKey(tabId, session.sessionId, stateKey, host)
    );
    ruleCount = await replaceTabSessionRules(tabId, session);
  }
  return {
    sessionId,
    presentationId: route.presentationId,
    routeKey,
    host,
    recovered: transition.recovered,
    circuit: transition.state.circuit,
    ruleCount,
    resourceStats: routingResourceStats(tabId),
    config: await buildRuntimeConfig(null, tabId)
  };
}

async function notePlaybackRisk(message, sender) {
  const { session } = requirePlaybackSession(message, sender);
  const host = String(message.host ?? "").toLowerCase();
  const routeKey = String(message.routeKey ?? "").slice(0, 1000);
  const presentationId = sanitizePresentationId(message.presentationId);
  const route = findSessionRoute(session, presentationId, routeKey);
  const stateKey = route?.stateKey ?? routeStateKey(presentationId, routeKey);
  const routeHosts = new Set(
    uniqueStrings([
      ...(route?.urls ?? []),
      ...(session.compatibleRoutes.get(stateKey) ?? [])
    ]).map(getHostname)
  );
  if (
    !route ||
    !isAllowedMediaHostname(host) ||
    !routeHosts.has(host)
  ) {
    return { sessionId: session.sessionId, escalated: false };
  }
  const riskKey = `${stateKey}\u0000${host}`;
  const now = Date.now();
  const previous = session.riskCounts.get(riskKey);
  const count =
    previous &&
    typeof previous === "object" &&
    now - Number(previous.lastAt) <= PLAYBACK_RISK_WINDOW_MS
      ? Math.max(0, Number(previous.count) || 0) + 1
      : 1;
  session.riskCounts.set(riskKey, { count, lastAt: now });
  if (
    count < 2 ||
    session.degradedRoutes.get(stateKey)?.has(host)
  ) {
    return { sessionId: session.sessionId, escalated: false, count };
  }
  const result = await degradePlaybackHost(
    { ...message, host },
    sender,
    "repeated-playback-risk"
  );
  return { ...result, escalated: result.escalated === true, count };
}

function sanitizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  return {
    type: String(event.type ?? "").slice(0, 40),
    at: Number(event.at) || Date.now(),
    host: String(event.host ?? "").slice(0, 255),
    detail: String(event.detail ?? "").slice(0, 300)
  };
}

function sanitizeBeaconAggregates(input) {
  const output = {};
  for (const [key, value] of Object.entries(
    input && typeof input === "object" ? input : {}
  ).slice(0, 16)) {
    const endpoint = String(value?.endpoint ?? key).slice(0, 300);
    output[String(key).slice(0, 300)] = {
      endpoint,
      count: Math.max(0, Number(value?.count) || 0),
      firstAt: Math.max(0, Number(value?.firstAt) || 0),
      lastAt: Math.max(0, Number(value?.lastAt) || 0)
    };
  }
  return output;
}

function sanitizeResourceStats(input) {
  const output = {};
  for (const [key, value] of Object.entries(
    input && typeof input === "object" ? input : {}
  ).slice(0, 32)) {
    if (/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(key)) {
      output[key] = Math.max(0, Number(value) || 0);
    }
  }
  return output;
}

function sanitizeRouteDetail(input, fallbackId = "") {
  if (!input || typeof input !== "object") {
    return null;
  }
  const routeKey = String(input.routeKey ?? "").slice(0, 1000);
  if (!routeKey) {
    return null;
  }
  const presentationId = sanitizePresentationId(input.presentationId);
  return {
    id: String(input.id ?? fallbackId).slice(0, 1200),
    presentationId,
    routeKey,
    kind: String(input.kind ?? "media").slice(0, 20),
    bandwidth: Math.min(
      200_000_000,
      Math.max(0, Number(input.bandwidth) || 0)
    ),
    plannedHost: String(input.plannedHost ?? "").slice(0, 255),
    mediaHost: String(input.mediaHost ?? "").slice(0, 255),
    routeSwitchCount: Math.max(0, Number(input.routeSwitchCount) || 0),
    degradedCount: Math.max(0, Number(input.degradedCount) || 0),
    fallbackCount: Math.max(0, Number(input.fallbackCount) || 0),
    lastThroughputBps: Math.max(0, Number(input.lastThroughputBps) || 0),
    lastRequiredBps: Math.max(0, Number(input.lastRequiredBps) || 0),
    lastBufferAhead: Math.max(0, Number(input.lastBufferAhead) || 0),
    lastStatus: Math.max(0, Number(input.lastStatus) || 0),
    lastBytes: Math.max(0, Number(input.lastBytes) || 0),
    lastExpectedBytes: Math.max(0, Number(input.lastExpectedBytes) || 0),
    lastDurationMs: Math.max(0, Number(input.lastDurationMs) || 0),
    lastProgressAgeMs: Math.max(0, Number(input.lastProgressAgeMs) || 0),
    lastResponseRange: String(input.lastResponseRange ?? "").slice(0, 160),
    lastAttemptedHost: String(input.lastAttemptedHost ?? "").slice(0, 255),
    latestSuccessfulRequestStartedAt: Math.max(
      0,
      Number(input.latestSuccessfulRequestStartedAt) || 0
    ),
    latestSuccessfulRoutingGeneration: Math.max(
      0,
      Number(input.latestSuccessfulRoutingGeneration) || 0
    ),
    lastObservedAt: Math.max(0, Number(input.lastObservedAt) || 0),
    recoveryStatus: String(input.recoveryStatus ?? "idle").slice(0, 20),
    recoveryStartedAt: Math.max(0, Number(input.recoveryStartedAt) || 0),
    recoveryBaselineBuffer: Math.max(
      0,
      Number(input.recoveryBaselineBuffer) || 0
    ),
    recoveryHealthySegments: Math.max(
      0,
      Number(input.recoveryHealthySegments) || 0
    ),
    recoveryStrongTransfers: Math.max(
      0,
      Number(input.recoveryStrongTransfers) || 0
    ),
    rewritten: Boolean(input.rewritten),
    updatedAt: Number(input.updatedAt) || Date.now()
  };
}

function sanitizePlayerDetail(input, fallbackId = "") {
  if (!input || typeof input !== "object") {
    return null;
  }
  const playerId = String(input.playerId ?? fallbackId).slice(0, 80);
  if (!playerId) {
    return null;
  }
  return {
    playerId,
    presentationId: sanitizePresentationId(input.presentationId),
    routeKey: String(input.routeKey ?? "").slice(0, 1000),
    kind: String(input.kind ?? "video").slice(0, 20),
    mediaHost: String(input.mediaHost ?? "").slice(0, 255),
    waitingCount: Math.max(0, Number(input.waitingCount) || 0),
    stalledCount: Math.max(0, Number(input.stalledCount) || 0),
    playbackSeconds: Math.max(0, Number(input.playbackSeconds) || 0),
    bufferAhead: Math.max(0, Number(input.bufferAhead) || 0),
    buffering: Boolean(input.buffering),
    paused: Boolean(input.paused),
    updatedAt: Number(input.updatedAt) || Date.now()
  };
}

function sanitizeDetailMap(input, limit, sanitizer) {
  const output = {};
  for (const [key, value] of Object.entries(
    input && typeof input === "object" ? input : {}
  ).slice(0, limit)) {
    const sanitized = sanitizer(value, key);
    if (sanitized) {
      output[String(key).slice(0, 1200)] = sanitized;
    }
  }
  return output;
}

function sanitizeNewestDetailMap(input, limit, sanitizer) {
  const entries = Object.entries(
    input && typeof input === "object" ? input : {}
  )
    .sort(
      (left, right) =>
        (Number(right[1]?.updatedAt) || 0) -
        (Number(left[1]?.updatedAt) || 0)
    )
    .slice(0, limit);
  return sanitizeDetailMap(Object.fromEntries(entries), limit, sanitizer);
}

function sanitizeDiagnosticRouteDetails(input) {
  const entries = Object.entries(
    input && typeof input === "object" ? input : {}
  );
  const scored = entries
    .map(([key, value]) => {
      const score =
        (value?.mediaHost ? 8 : 0) +
        (Number(value?.degradedCount) > 0 ? 8 : 0) +
        (Number(value?.fallbackCount) > 0 ? 8 : 0) +
        (Number(value?.routeSwitchCount) > 0 ? 6 : 0) +
        (
          value?.recoveryStatus &&
          value.recoveryStatus !== "idle"
            ? 4
            : 0
        );
      return [key, value, score];
    })
    .sort(
      (left, right) =>
        right[2] - left[2] ||
        (Number(right[1]?.updatedAt) || 0) -
          (Number(left[1]?.updatedAt) || 0)
    );
  const valuable = scored.filter((entry) => entry[2] > 0);
  const planningOnly = scored.filter((entry) => entry[2] === 0).slice(0, 8);
  const selected = [...valuable, ...planningOnly]
    .slice(0, 32)
    .map(([key, value]) => [key, value]);
  return sanitizeDetailMap(
    Object.fromEntries(selected),
    32,
    sanitizeRouteDetail
  );
}

function sanitizeSession(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid diagnostic session");
  }
  const id = String(input.id ?? "");
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) {
    throw new Error("Invalid diagnostic session ID");
  }
  return {
    id,
    pageUrl: String(input.pageUrl ?? "").slice(0, 600),
    startedAt: Number(input.startedAt) || Date.now(),
    updatedAt: Number(input.updatedAt) || Date.now(),
    firstPlayingMs:
      input.firstPlayingMs === null || input.firstPlayingMs === undefined
        ? null
        : Math.max(0, Number(input.firstPlayingMs) || 0),
    waitingCount: Math.max(0, Number(input.waitingCount) || 0),
    stalledCount: Math.max(0, Number(input.stalledCount) || 0),
    bufferingMs: Math.max(0, Number(input.bufferingMs) || 0),
    playbackSeconds: Math.max(0, Number(input.playbackSeconds) || 0),
    mediaHost: String(input.mediaHost ?? "").slice(0, 255),
    plannedMediaHost: String(input.plannedMediaHost ?? "").slice(0, 255),
    rewritten: Boolean(input.rewritten),
    rewriteCount: Math.max(0, Number(input.rewriteCount) || 0),
    fallbackCount: Math.max(0, Number(input.fallbackCount) || 0),
    degradedCount: Math.max(0, Number(input.degradedCount) || 0),
    routeSwitchCount: Math.max(0, Number(input.routeSwitchCount) || 0),
    activeRuleCount: Math.max(0, Number(input.activeRuleCount) || 0),
    lastRuleLatencyMs: Math.max(0, Number(input.lastRuleLatencyMs) || 0),
    lastThroughputBps: Math.max(0, Number(input.lastThroughputBps) || 0),
    lastBufferAhead: Math.max(0, Number(input.lastBufferAhead) || 0),
    blockedBeaconCount: Math.max(0, Number(input.blockedBeaconCount) || 0),
    resourceStats: sanitizeResourceStats(input.resourceStats),
    routeDetails: sanitizeDiagnosticRouteDetails(input.routeDetails),
    playerDetails: sanitizeNewestDetailMap(
      input.playerDetails,
      4,
      sanitizePlayerDetail
    ),
    beaconAggregates: sanitizeBeaconAggregates(input.beaconAggregates),
    criticalEvents: Array.isArray(input.criticalEvents)
      ? input.criticalEvents.map(sanitizeEvent).filter(Boolean).slice(-64)
      : [],
    ordinaryEvents: Array.isArray(input.ordinaryEvents)
      ? input.ordinaryEvents.map(sanitizeEvent).filter(Boolean).slice(-32)
      : [],
    recentEvents: Array.isArray(input.recentEvents)
      ? input.recentEvents.map(sanitizeEvent).filter(Boolean).slice(-30)
      : []
  };
}

const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const DIAGNOSTIC_FLUSH_MS = 1000;
const DIAGNOSTIC_MIN_STORAGE_WRITE_MS = 10_000;

function serializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function loadDiagnosticsCache() {
  diagnosticsCachePromise ??= chrome.storage.local
    .get(STORAGE_KEYS.diagnostics)
    .then((stored) => {
      for (const session of Array.isArray(
        stored[STORAGE_KEYS.diagnostics]?.sessions
      )
        ? stored[STORAGE_KEYS.diagnostics].sessions
        : []) {
        try {
          const sanitized = sanitizeSession(session);
          diagnosticCache.set(sanitized.id, sanitized);
        } catch {
          // Ignore malformed historical diagnostics.
        }
      }
    });
  return diagnosticsCachePromise;
}

function boundedDiagnosticSessions(maxSessions) {
  const sessions = [...diagnosticCache.values()]
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .slice(-maxSessions);
  while (
    sessions.length > 1 &&
    serializedBytes({ sessions }) > MAX_DIAGNOSTIC_BYTES
  ) {
    sessions.shift();
  }
  return sessions;
}

function queueDiagnosticStorageWrite(force = false) {
  diagnosticStorageChain = diagnosticStorageChain
    .catch(() => {})
    .then(async () => {
      const elapsed = Date.now() - lastDiagnosticStorageWriteAt;
      if (
        !force &&
        lastDiagnosticStorageWriteAt > 0 &&
        elapsed < DIAGNOSTIC_MIN_STORAGE_WRITE_MS
      ) {
        if (!deferredDiagnosticStorageTimer) {
          deferredDiagnosticStorageTimer = setTimeout(() => {
            deferredDiagnosticStorageTimer = null;
            void queueDiagnosticStorageWrite(true);
          }, DIAGNOSTIC_MIN_STORAGE_WRITE_MS - elapsed);
          deferredDiagnosticStorageTimer?.unref?.();
        }
        return diagnosticCache.size;
      }
      const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
      const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
      const sessions = boundedDiagnosticSessions(
        settings.diagnostics.maxSessions
      );
      const retained = new Set(sessions.map((session) => session.id));
      for (const id of diagnosticCache.keys()) {
        if (!retained.has(id)) {
          diagnosticCache.delete(id);
        }
      }
      const diagnostics = { sessions };
      await chrome.storage.local.set({
        [STORAGE_KEYS.diagnostics]: diagnostics
      });
      lastDiagnosticStorageWriteAt = Date.now();
      lastDiagnosticStoredBytes = serializedBytes(diagnostics);
      diagnosticWriteTimestamps.push(lastDiagnosticStorageWriteAt);
      while (
        diagnosticWriteTimestamps.length &&
        Date.now() - diagnosticWriteTimestamps[0] >= 60_000
      ) {
        diagnosticWriteTimestamps.shift();
      }
      return sessions.length;
    });
  return diagnosticStorageChain;
}

function queueDiagnosticMutation(tabId, operation) {
  const previous =
    diagnosticMutationChains.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined
  );
  diagnosticMutationChains.set(tabId, settled);
  void settled.finally(() => {
    if (diagnosticMutationChains.get(tabId) === settled) {
      diagnosticMutationChains.delete(tabId);
    }
  });
  return current;
}

function flushDiagnosticTab(tabId) {
  const pending = pendingDiagnosticFlushes.get(tabId);
  if (!pending) {
    return Promise.resolve(0);
  }
  clearTimeout(pending.timer);
  pendingDiagnosticFlushes.delete(tabId);
  return queueDiagnosticMutation(tabId, async () => {
    try {
      await loadDiagnosticsCache();
      for (const session of pending.sessions.values()) {
        diagnosticCache.set(session.id, session);
      }
      const count = await queueDiagnosticStorageWrite();
      for (const waiter of pending.waiters) {
        waiter.resolve(count);
      }
      return count;
    } catch (error) {
      for (const waiter of pending.waiters) {
        waiter.reject(error);
      }
      throw error;
    }
  });
}

function recordDiagnostic(input, tabId = -1) {
  const session = sanitizeSession(input);
  let pending = pendingDiagnosticFlushes.get(tabId);
  if (!pending) {
    pending = {
      sessions: new Map(),
      waiters: [],
      timer: setTimeout(
        () => void flushDiagnosticTab(tabId),
        DIAGNOSTIC_FLUSH_MS
      )
    };
    pendingDiagnosticFlushes.set(tabId, pending);
  }
  pending.sessions.set(session.id, session);
  return new Promise((resolve, reject) => {
    pending.waiters.push({ resolve, reject });
  });
}

function clearDiagnosticState() {
  for (const pending of pendingDiagnosticFlushes.values()) {
    clearTimeout(pending.timer);
    for (const waiter of pending.waiters) {
      waiter.resolve(0);
    }
  }
  pendingDiagnosticFlushes.clear();
  clearTimeout(deferredDiagnosticStorageTimer);
  deferredDiagnosticStorageTimer = null;
  lastDiagnosticStorageWriteAt = 0;
  lastDiagnosticStoredBytes = 0;
  diagnosticWriteTimestamps.length = 0;
  diagnosticCache.clear();
  diagnosticsCachePromise = Promise.resolve();
}

function applyCosmetic(enabled, sender) {
  if (!Number.isInteger(sender.tab?.id)) {
    return Promise.resolve();
  }
  const frameId = sender.frameId ?? 0;
  const key = `${sender.tab.id}:${frameId}`;
  const previous = cosmeticMutationChains.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const { cosmetic } = await ruleDataPromise;
      const css = sanitizeCosmeticSelectors(
        cosmetic.selectors.map((entry) => entry.selector)
      )
        .map((selector) => `${selector}{display:none!important;}`)
        .join("\n");
      const target = {
        tabId: sender.tab.id,
        frameIds: [frameId]
      };
      await chrome.scripting
        .removeCSS({ target, css, origin: "USER" })
        .catch(() => {});
      if (enabled) {
        await chrome.scripting.insertCSS({ target, css, origin: "USER" });
      }
    });
  cosmeticMutationChains.set(key, operation);
  return operation.finally(() => {
    if (cosmeticMutationChains.get(key) === operation) {
      cosmeticMutationChains.delete(key);
    }
  });
}

async function handleMessage(message, sender) {
  await initializationPromise;
  switch (message?.type) {
    case "GET_RUNTIME_CONFIG": {
      const state = await readState();
      let tabId;
      if (
        routingEnabled(state.settings) &&
        isPlaybackSessionId(message.sessionId) &&
        isSupportedPlaybackPageUrl(message.pageUrl)
      ) {
        ({ tabId } = await startPlaybackSession(message, sender));
      } else if (
        routingEnabled(state.settings) &&
        typeof message.pageUrl === "string" &&
        message.pageUrl.length > 0 &&
        !isSupportedPlaybackPageUrl(message.pageUrl) &&
        Number(sender.frameId ?? 0) === 0 &&
        Number.isInteger(sender.tab?.id) &&
        sender.tab.id >= 0
      ) {
        tabId = sender.tab.id;
        const staleSession = tabPlaybackSessions.get(tabId);
        if (staleSession) {
          await evictPlaybackSession(
            tabId,
            staleSession,
            "Unsupported playback page"
          );
        }
      }
      return { config: await buildRuntimeConfig(state, tabId) };
    }
    case "START_PLAYBACK_SESSION": {
      const state = await requireRoutingEnabled();
      const { tabId, session } = await startPlaybackSession(message, sender);
      return {
        sessionId: session.sessionId,
        routingTabId: tabId,
        config: await buildRuntimeConfig(state, tabId)
      };
    }
    case "STOP_PLAYBACK_SESSION": {
      await requireRoutingEnabled();
      const { tabId, session, sessionId } = requirePlaybackSession(
        message,
        sender
      );
      await evictPlaybackSession(
        tabId,
        session,
        "Playback page left"
      );
      return {
        sessionId,
        stopped: true,
        config: await buildRuntimeConfig(null, tabId)
      };
    }
    case "REGISTER_MEDIA_ROUTES":
      await requireRoutingEnabled();
      return registerMediaRoutes(message, sender);
    case "PROBE_MEDIA": {
      await requireRoutingEnabled();
      const mediaUrl = String(message.mediaUrl ?? "");
      if (mediaUrl.length > 4096 || !isMediaResourceUrl(mediaUrl)) {
        throw new Error("Rejected probe URL");
      }
      const {
        tabId,
        session,
        sessionId
      } = requirePlaybackSession(message, sender);
      const presentationId = sanitizePresentationId(
        message.presentationId
      );
      const routeKey = String(message.routeKey ?? "").slice(0, 1000);
      const registeredRoute = findSessionRoute(
        session,
        presentationId,
        routeKey || mediaRouteKey(mediaUrl)
      );
      if (
        !registeredRoute ||
        !registeredRoute.urls.includes(mediaUrl)
      ) {
        throw new Error(
          "Probe URL is not registered for this playback route"
        );
      }
      const referenceEvidence = sanitizeObservedProbeReference(message);
      if (referenceEvidence) {
        rememberProbeReference(
          session,
          registeredRoute.stateKey,
          referenceEvidence
        );
      }
      const probeResult = await queueProbe(
        mediaUrl,
        tabId,
        sessionId,
        registeredRoute.presentationId,
        registeredRoute.routeKey,
        referenceEvidence,
        message.recovery === true
      );
      return {
        sessionId,
        config: probeResult.config,
        probeOutcome: probeResult.probeOutcome
      };
    }
    case "HOST_DEGRADED":
      await requireRoutingEnabled();
      return degradePlaybackHost(message, sender, message.reason);
    case "BYPASS_PLAYBACK_ROUTE":
      await requireRoutingEnabled();
      return bypassPlaybackRoute(message, sender);
    case "HOST_RECOVERED":
      await requireRoutingEnabled();
      return recoverPlaybackHost(message, sender);
    case "PLAYBACK_RISK":
      await requireRoutingEnabled();
      return notePlaybackRisk(message, sender);
    case "RECORD_DIAGNOSTIC":
      await recordDiagnostic(
        message.session,
        Number.isInteger(sender.tab?.id) ? sender.tab.id : -1
      );
      return { recorded: true };
    case "APPLY_COSMETIC":
      await applyCosmetic(Boolean(message.enabled), sender);
      return { applied: Boolean(message.enabled) };
    case "CLEAR_DIAGNOSTICS":
      clearDiagnosticState();
      await chrome.storage.local.set({
        [STORAGE_KEYS.diagnostics]: { sessions: [] }
      });
      return { cleared: true };
    case "CLEAR_PROBE_CACHE": {
      const state = await readState();
      const runtime = await mutateRuntimeState((current) => ({
        ...current,
        selectedHost: "",
        rankedHosts: [],
        probeCache: {},
        lastProbeAt: 0
      }));
      await queueReconcile();
      return {
        config: await buildRuntimeConfig(
          { ...state, runtime },
          Number.isInteger(sender.tab?.id) ? sender.tab.id : undefined
        )
      };
    }
    default:
      throw new Error("Unknown message type");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  initializationPromise = initializationPromise
    .catch(() => {})
    .then(removeOrphanedSessionRules)
    .then(queueReconcile);
  void initializationPromise;
});

chrome.runtime.onStartup.addListener(() => {
  initializationPromise = initializationPromise
    .catch(() => {})
    .then(removeOrphanedSessionRules)
    .then(queueReconcile);
  void initializationPromise;
});

function clearPlaybackRoutingState() {
  probeScheduler.cancelAll("Playback routing disabled");
  for (const tabId of [...pendingTabRuleReplacements.keys()]) {
    cancelPendingTabRuleReplacement(tabId, "Playback routing disabled");
  }
  for (const timer of circuitTimers.values()) {
    clearTimeout(timer);
  }
  circuitTimers.clear();
  for (const timer of nativeBypassTimers.values()) {
    clearTimeout(timer);
  }
  nativeBypassTimers.clear();
  for (const timer of sessionExpiryTimers.values()) {
    clearTimeout(timer);
  }
  sessionExpiryTimers.clear();
  tabPlaybackSessions.clear();
  reservedTabStarts.clear();
  tabSessionStartChains.clear();
  sessionTabBindings.clear();
  tabRetiredDocuments.clear();
  probeJobs.clear();
  tabRuleBlocks.clear();
}

async function handleSettingsChanged(rawSettings, rawPreviousSettings) {
  const { endpoints } = await ruleDataPromise;
  const settings = normalizeSettings(rawSettings, endpoints.endpoints);
  const previousSettings = normalizeSettings(
    rawPreviousSettings,
    endpoints.endpoints
  );
  if (
    !routingEnabled(settings) ||
    !routingEnabled(previousSettings)
  ) {
    clearPlaybackRoutingState();
    await removeOrphanedSessionRules();
  } else {
    await Promise.all(
      [...tabPlaybackSessions].map(([tabId, session]) =>
        replaceTabSessionRules(tabId, session)
      )
    );
  }
  await queueReconcile();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEYS.settings]) {
    void handleSettingsChanged(
      changes[STORAGE_KEYS.settings].newValue,
      changes[STORAGE_KEYS.settings].oldValue
    ).catch((error) =>
      console.error("bilibili-speedup settings reconciliation failed", error)
    );
  }
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  clearTimeout(sessionExpiryTimers.get(tabId));
  sessionExpiryTimers.delete(tabId);
  probeScheduler.cancelTab(tabId, "Playback tab closed");
  clearCircuitTimersForTab(tabId);
  clearNativeBypassTimersForTab(tabId);
  const session = tabPlaybackSessions.get(tabId);
  if (session) {
    sessionTabBindings.delete(session.sessionId);
    tabPlaybackSessions.delete(tabId);
  }
  tabRetiredDocuments.delete(tabId);
  for (const key of probeJobs.keys()) {
    if (key.startsWith(`${tabId}:`)) {
      probeJobs.delete(key);
    }
  }
  void removeTabSessionRules(tabId).finally(() => {
    tabRuleBlocks.delete(tabId);
  });
});

async function flushDebugCounts() {
  debugFlushTimer = null;
  if (!pendingDebugCounts.size) {
    return;
  }
  const deltas = [...pendingDebugCounts.entries()];
  pendingDebugCounts.clear();
  await mutateRuntimeState((current) => {
    const counts = { ...current.dnrMatchCounts };
    for (const [ruleId, count] of deltas) {
      counts[ruleId] = (counts[ruleId] ?? 0) + count;
    }
    return { ...current, dnrMatchCounts: counts };
  });
}

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((details) => {
    const ruleId = details.rule.ruleId;
    if (
      (ruleId < OWN_RULE_MIN || ruleId > OWN_RULE_MAX) &&
      (ruleId < OWN_SESSION_RULE_MIN || ruleId > OWN_SESSION_RULE_MAX)
    ) {
      return;
    }
    pendingDebugCounts.set(ruleId, (pendingDebugCounts.get(ruleId) ?? 0) + 1);
    if (!debugFlushTimer) {
      debugFlushTimer = setTimeout(() => void flushDebugCounts(), 500);
    }
  });
}

initializationPromise = removeOrphanedSessionRules()
  .catch((error) =>
    console.error("bilibili-speedup session rule cleanup failed", error)
  )
  .then(queueReconcile);
