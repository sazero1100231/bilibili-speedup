(() => {
  "use strict";

  const CHANNEL = "bilibili-speedup";
  const INIT_EVENT = `${CHANNEL}:init`;
  const READY_EVENT = `${CHANNEL}:ready`;
  const dispatchDocumentEvent = document.dispatchEvent.bind(document);
  const PLAYURL_MARKERS = [
    "/x/player/wbi/playurl",
    "/pgc/player/web/playurl",
    "/ogv/player/pre/check/drm"
  ];
  const MAX_PRESENTATIONS = 4;
  const MAX_STAGED_PRESENTATIONS = 1;
  const MAX_ROUTES_PER_PRESENTATION = 32;
  const MAX_HOSTS_PER_ROUTE = 8;
  const CONFIG_STARTUP_WAIT_MS = 150;
  const POLICY_READY_WAIT_MS = 150;
  const LOCAL_HOST_STRIKE_TTL_MS = 60_000;
  const ACTIVE_BODY_THROUGHPUT_HEADROOM = 1;
  const MIN_BODY_COMPLETION_GRACE_MS = 2_000;
  const MIN_SAFE_BODY_TAIL_BYTES = 64 * 1024;
  const SAFE_BODY_TAIL_RATIO = 0.05;
  const SAFE_BODY_TAIL_GRACE_MS = 4_000;
  const SAFE_HANDOFF_IDLE_MS = 2_000;
  const MAX_NATIVE_BYPASS_MS = 60_000;
  const PROBE_REFERENCE_BYTES = 262_144;
  const MAX_PROBE_REFERENCES_PER_PRESENTATION = 2;
  const DOCUMENT_STARTED_AT = performance.now();
  let resolveInitialConfig;
  const initialConfigReady = new Promise((resolve) => {
    resolveInitialConfig = resolve;
  });
  const state = {
    // Hooks install early for timing, but stay behaviorally inert until the
    // authenticated private channel supplies the real normalized config.
    config: {
      settings: {
        globalEnabled: false,
        acceleration: { enabled: false, playurlRewrite: false },
        privacy: { urlCleaning: false, telemetryBlocking: false }
      },
      trackingParams: [],
      blockedHostPatterns: [],
      blockedEndpoints: [],
      compatibleRoutes: {},
      degradedRoutes: {}
    },
    blockedRegexes: [],
    privateInboundEvent: "",
    privateOutboundEvent: "",
    installed: false,
    originals: {},
    wrappers: {},
    xhrMeta: new WeakMap(),
    xhrRewriteCache: new WeakMap(),
    activeMediaXhrs: new Map(),
    mediaRoutes: new Map(),
    routeBlockedHosts: new Map(),
    localRouteBlockedHosts: new Map(),
    nativeEscapeRoutes: new Set(),
    nativeBypassRoutes: new Map(),
    halfOpenRoutes: new Map(),
    halfOpenLeaders: new Set(),
    hostFailures: new Map(),
    degradedReports: new Map(),
    probedKeys: new Set(),
    probeReferenceKeys: new Set(),
    probeReferenceCountsByPresentation: new Map(),
    lastReportedHosts: new Map(),
    routeSwitchWindows: new Map(),
    bootstrapPlayinfo: {
      installed: false,
      originalDescriptor: null,
      getter: null,
      setter: null,
      raw: undefined,
      value: undefined,
      revision: 0,
      processedRevision: -1
    },
    presentationSerial: 0,
    presentationCapacityDrops: 0,
    presentationCapacityDiagnosticScheduled: false,
    presentationCapacityDiagnosticEmitted: false,
    configReady: false,
    policySerial: 0,
    policyWaiters: new Map(),
    routingGeneration: 0,
    historyReentry: {
      pushState: false,
      replaceState: false
    },
    navigationKey: "",
    pristineHistory: {},
    lifecycleActive: true
  };

  function emit(type, payload = {}) {
    if (!state.privateOutboundEvent) {
      return;
    }
    dispatchDocumentEvent(
      new CustomEvent(state.privateOutboundEvent, {
        detail: JSON.stringify({ type, payload })
      })
    );
  }

  function rawRequestUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return typeof input?.url === "string" ? input.url : "";
  }

  function parseUrl(raw, base = location.href) {
    try {
      return new URL(raw, base);
    } catch {
      return null;
    }
  }

  // Keep in sync with bridge.js and service-worker.js. Acceleration is a
  // playback-page feature; search/home/space card previews stay native so a
  // result grid cannot allocate full player, probe, DNR, and diagnostics state.
  function isPlaybackPage(raw = location.href) {
    const url = parseUrl(raw);
    if (
      !url ||
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
  }

  function playbackNavigationKey(raw = location.href) {
    const url = parseUrl(raw);
    if (!url || !isPlaybackPage(url.href)) {
      return "non-playback";
    }
    const video = url.pathname.match(
      /^\/video\/(BV[0-9a-z_-]+|av\d+)(?:\/|$)/i
    )?.[1];
    if (video) {
      const rawPart = Number.parseInt(url.searchParams.get("p") ?? "1", 10);
      const part = Number.isFinite(rawPart) && rawPart > 1 ? rawPart : 1;
      return `video:${video.toLowerCase()}:p=${part}`;
    }
    const bangumi = url.pathname.match(
      /^\/bangumi\/play\/((?:ep|ss|md)\d+)(?:\/|$)/i
    )?.[1];
    return bangumi
      ? `bangumi:${bangumi.toLowerCase()}`
      : `playback:${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
  }

  // Keep in sync with the strict media surface in src/lib/url-utils.js.
  function isAllowedMediaHostname(hostname) {
    const host = String(hostname ?? "").toLowerCase();
    return (
      host.endsWith(".bilivideo.com") ||
      host.endsWith(".bilivideo.cn") ||
      host === "upos-hz-mirrorakam.akamaized.net"
    );
  }

  function isAllowedMediaUrl(raw) {
    const url = parseUrl(raw);
    return Boolean(
      url &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        isAllowedMediaHostname(url.hostname)
    );
  }

  function isMediaUrl(raw) {
    const url = parseUrl(raw);
    return Boolean(
      url &&
        /\.(?:m4s|flv|mp4)$/i.test(url.pathname) &&
        isAllowedMediaUrl(url.href)
    );
  }

  function mediaKey(raw) {
    const url = parseUrl(raw);
    return url ? url.pathname : "";
  }

  function normalizedPresentationId(value) {
    const raw = String(value ?? "").slice(0, 160);
    return /^[a-zA-Z0-9._:-]{1,160}$/.test(raw) ? raw : "";
  }

  function presentationParts(presentationId) {
    const normalized = normalizedPresentationId(presentationId);
    return normalized ? new Set(normalized.split(":")) : new Set();
  }

  function presentationIdForPlayurl(rawUrl) {
    const url = parseUrl(rawUrl);
    // Playurl requests often gain cid/avid parameters after bootstrap. A
    // representation must not move to a second breaker/routing namespace just
    // because the API enriched the same presentation identity.
    for (const key of ["bvid", "ep_id", "season_id", "cid", "avid"]) {
      const value = url?.searchParams.get(key);
      if (value && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
        return normalizedPresentationId(`${key}-${value}`);
      }
    }
    if (url?.pathname.includes("/ogv/player/pre/check/drm")) {
      return presentationIdForPage();
    }
    state.presentationSerial += 1;
    return `manifest-${state.presentationSerial}`;
  }

  function presentationIdForPage() {
    const bvid = location.pathname.match(
      /\/video\/(BV[0-9a-zA-Z]{10})/i
    )?.[1];
    if (bvid) {
      return normalizedPresentationId(`bvid-${bvid}`);
    }
    const episode = location.pathname.match(/\/bangumi\/play\/(ep\d+)/i)?.[1];
    if (episode) {
      return normalizedPresentationId(`ep_id-${episode.slice(2)}`);
    }
    const season = location.pathname.match(/\/bangumi\/play\/ss(\d+)/i)?.[1];
    if (season) {
      return normalizedPresentationId(`season_id-${season}`);
    }
    return presentationIdForPlayurl(location.href);
  }

  function presentationMatchesPage(presentationId, rawUrl = location.href) {
    const normalized = normalizedPresentationId(presentationId);
    const url = parseUrl(rawUrl);
    if (!normalized || !url) {
      return false;
    }
    const parts = presentationParts(normalized);
    const bvid = url.pathname.match(
      /\/video\/(BV[0-9a-zA-Z]{10})/i
    )?.[1];
    if (bvid) {
      return parts.has(`bvid-${bvid}`);
    }
    const episode = url.pathname.match(/\/bangumi\/play\/ep(\d+)/i)?.[1];
    if (episode) {
      return (
        normalized === `episode-ep${episode}` ||
        parts.has(`ep_id-${episode}`)
      );
    }
    const season = url.pathname.match(/\/bangumi\/play\/ss(\d+)/i)?.[1];
    if (season) {
      return (
        normalized === `season-ss${season}` ||
        parts.has(`season_id-${season}`)
      );
    }
    return false;
  }

  function routeIdentity(presentationId, routeKey) {
    return `${normalizedPresentationId(presentationId) || "unassigned"}::${routeKey}`;
  }

  function routeUsesNativeBypass(presentationId, routeKey) {
    const identity = routeIdentity(presentationId, routeKey);
    const until = state.nativeBypassRoutes.get(identity) ?? 0;
    if (until <= Date.now()) {
      state.nativeBypassRoutes.delete(identity);
      return false;
    }
    return true;
  }

  function applyNativeRouteBypass(payload) {
    const presentationId = normalizedPresentationId(payload?.presentationId);
    const routeKey = String(payload?.routeKey ?? "").slice(0, 1000);
    const identity = routeIdentity(presentationId, routeKey);
    if (
      !presentationId ||
      !routeKey ||
      !state.mediaRoutes.has(identity)
    ) {
      return;
    }
    if (payload?.persistent === true) {
      state.nativeBypassRoutes.set(identity, Number.POSITIVE_INFINITY);
    } else {
      const now = Date.now();
      const requestedUntil = Math.max(
        now + 1_000,
        Number(payload?.until) || 0
      );
      state.nativeBypassRoutes.set(
        identity,
        Math.min(now + MAX_NATIVE_BYPASS_MS, requestedUntil)
      );
    }
    // Do not abort a Range that already has useful bytes. It completes
    // natively, but it must no longer emit extension degradation or trigger a
    // second handoff while this representation is in exhausted-pool bypass.
    for (const xhr of state.activeMediaXhrs.get(identity) ?? []) {
      const meta = state.xhrMeta.get(xhr);
      if (!meta) {
        continue;
      }
      meta.nativeBypass = true;
      meta.monitoring = false;
      clearTimeout(meta.slowTimer);
    }
  }

  function hasStablePagePresentation(rawUrl = location.href) {
    const url = parseUrl(rawUrl);
    return Boolean(
      url &&
        (
          /\/video\/BV[0-9a-zA-Z]{10}(?:\/|$)/i.test(url.pathname) ||
          /\/bangumi\/play\/(?:ep|ss)\d+(?:\/|$)/i.test(url.pathname)
        )
    );
  }

  function presentationIsActive(
    presentationId,
    rawUrl = location.href
  ) {
    return (
      !hasStablePagePresentation(rawUrl) ||
      presentationMatchesPage(presentationId, rawUrl)
    );
  }

  function stagePresentation(presentationId) {
    if (
      presentationIsActive(presentationId) ||
      !hasStablePagePresentation()
    ) {
      return;
    }
    const stagedPresentations = unique(
      [...state.mediaRoutes.values()]
        .filter(
          (route) =>
            !presentationIsActive(route.presentationId) &&
            route.presentationId !== presentationId
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((route) => route.presentationId)
    );
    for (const stalePresentation of stagedPresentations.slice(
      MAX_STAGED_PRESENTATIONS - 1
    )) {
      for (const [identity, route] of state.mediaRoutes) {
        if (route.presentationId === stalePresentation) {
          state.mediaRoutes.delete(identity);
        }
      }
    }
  }

  function findMediaRoute(rawUrl) {
    const routeKey = mediaKey(rawUrl);
    const routes = [...state.mediaRoutes.values()].filter(
      (route) =>
        route.routeKey === routeKey &&
        presentationIsActive(route.presentationId)
    );
    return (
      routes.find(
        (route) =>
          route.urls.includes(rawUrl) || route.originalUrls.includes(rawUrl)
      ) ??
      routes.sort((left, right) => right.updatedAt - left.updatedAt)[0] ??
      null
    );
  }

  function canTrackRoute(presentationId, routeKey) {
    const routes = [...state.mediaRoutes.values()];
    const presentations = new Set(
      routes.map((route) => route.presentationId)
    );
    if (
      !presentations.has(presentationId) &&
      presentations.size >= MAX_PRESENTATIONS
    ) {
      state.presentationCapacityDrops += 1;
      if (
        !state.presentationCapacityDiagnosticScheduled &&
        !state.presentationCapacityDiagnosticEmitted
      ) {
        state.presentationCapacityDiagnosticScheduled = true;
        Promise.resolve().then(() => {
          state.presentationCapacityDiagnosticScheduled = false;
          if (
            state.presentationCapacityDiagnosticEmitted ||
            !state.presentationCapacityDrops
          ) {
            return;
          }
          state.presentationCapacityDiagnosticEmitted = true;
          emit("PRESENTATION_CAPACITY", {
            maxPresentations: MAX_PRESENTATIONS,
            droppedRoutes: state.presentationCapacityDrops
          });
        });
      }
      return false;
    }
    return (
      routes.some(
        (route) =>
          route.presentationId === presentationId &&
          route.routeKey === routeKey
      ) ||
      routes.filter((route) => route.presentationId === presentationId)
        .length < MAX_ROUTES_PER_PRESENTATION
    );
  }

  function isBlockedHost(host) {
    return state.blockedRegexes.some((regex) => regex.test(host));
  }

  function isLocalRouteHostBlocked(
    routeKey,
    host,
    presentationId = "unassigned"
  ) {
    const now = Date.now();
    const identities = [
      routeIdentity(presentationId, routeKey),
      routeKey
    ];
    for (const identity of identities) {
      const local = state.localRouteBlockedHosts.get(identity);
      if (!local) {
        continue;
      }
      for (const [localHost, expiresAt] of local) {
        if (expiresAt <= now) {
          local.delete(localHost);
        }
      }
      if (!local.size) {
        state.localRouteBlockedHosts.delete(identity);
      } else if ((local.get(host) ?? 0) > now) {
        return true;
      }
    }
    return false;
  }

  function isSessionHostBlocked(
    routeKey,
    host,
    presentationId = "unassigned"
  ) {
    if (isLocalRouteHostBlocked(routeKey, host, presentationId)) {
      return true;
    }
    return Boolean(
      state.routeBlockedHosts
        .get(routeIdentity(presentationId, routeKey))
        ?.has(host) ||
      state.routeBlockedHosts.get(routeKey)?.has(host)
    );
  }

  function isHalfOpenHost(route, host) {
    return Boolean(
      state.halfOpenRoutes
        .get(routeIdentity(route.presentationId, route.routeKey))
        ?.has(host) ||
      state.halfOpenRoutes.get(route.routeKey)?.has(host)
    );
  }

  function claimHalfOpenLeader(route, host) {
    if (!isHalfOpenHost(route, host)) {
      return "";
    }
    const key = `${routeIdentity(
      route.presentationId,
      route.routeKey
    )}\u0000${host}`;
    if (state.halfOpenLeaders.has(key)) {
      return null;
    }
    state.halfOpenLeaders.add(key);
    return key;
  }

  function releaseHalfOpenLeader(key) {
    if (key) {
      state.halfOpenLeaders.delete(key);
    }
  }

  function isEligibleRouteUrl(
    routeKey,
    rawUrl,
    presentationId = "unassigned"
  ) {
    const url = parseUrl(rawUrl);
    return Boolean(
      url &&
        isMediaUrl(url.href) &&
        mediaKey(url.href) === routeKey &&
        !isBlockedHost(url.hostname) &&
        !isSessionHostBlocked(routeKey, url.hostname, presentationId)
    );
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function cleanUrl(raw) {
    if (raw === null || raw === undefined || raw === "") {
      return raw;
    }
    const url = parseUrl(String(raw));
    if (!url) {
      return raw;
    }
    let changed = false;
    for (const param of state.config.trackingParams) {
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param);
        changed = true;
      }
    }
    if (!changed) {
      return raw;
    }
    const input = String(raw);
    if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
      return url.href;
    }
    if (input.startsWith("//")) {
      return `//${url.host}${url.pathname}${url.search}${url.hash}`;
    }
    if (input.startsWith("?")) {
      return `${url.search}${url.hash}`;
    }
    if (input.startsWith("/")) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
    return url.href;
  }

  function cleanTextUrls(text) {
    return String(text).replace(
      /https?:\/\/[^\s"'<>，。；）)\]]+/g,
      (candidate) => cleanUrl(candidate)
    );
  }

  function isPlayurl(raw) {
    if (!raw) {
      return false;
    }
    const url = parseUrl(raw);
    return Boolean(
      url &&
        url.hostname.endsWith(".bilibili.com") &&
        PLAYURL_MARKERS.some((path) => url.pathname.includes(path))
    );
  }

  function isBlockedEndpoint(raw) {
    const url = parseUrl(raw);
    if (!url) {
      return false;
    }
    return state.config.blockedEndpoints.some((endpoint) => {
      if (url.hostname !== endpoint.domain) {
        return false;
      }
      if (endpoint.pathPrefix === "/") {
        return true;
      }
      if (endpoint.pathPrefix.endsWith("/")) {
        return (
          url.pathname === endpoint.pathPrefix.slice(0, -1) ||
          url.pathname.startsWith(endpoint.pathPrefix)
        );
      }
      return (
        url.pathname === endpoint.pathPrefix ||
        url.pathname.startsWith(`${endpoint.pathPrefix}/`)
      );
    });
  }

  function resetPlaybackRouting() {
    state.routingGeneration += 1;
    for (const waiter of state.policyWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    state.policyWaiters.clear();
    state.mediaRoutes.clear();
    state.routeBlockedHosts.clear();
    state.localRouteBlockedHosts.clear();
    state.nativeEscapeRoutes.clear();
    state.nativeBypassRoutes.clear();
    state.halfOpenRoutes.clear();
    state.halfOpenLeaders.clear();
    state.hostFailures.clear();
    state.degradedReports.clear();
    state.probedKeys.clear();
    state.probeReferenceKeys.clear();
    state.probeReferenceCountsByPresentation.clear();
    state.lastReportedHosts.clear();
    state.routeSwitchWindows.clear();
    for (const active of state.activeMediaXhrs.values()) {
      for (const xhr of active) {
        const meta = state.xhrMeta.get(xhr);
        if (meta) {
          meta.monitoring = false;
          clearTimeout(meta.slowTimer);
        }
      }
    }
    state.activeMediaXhrs.clear();
    state.presentationSerial = 0;
    state.presentationCapacityDrops = 0;
    state.presentationCapacityDiagnosticScheduled = false;
    state.presentationCapacityDiagnosticEmitted = false;
    state.config.compatibleRoutes = {};
    state.config.degradedRoutes = {};
  }

  function emitNavigation(previousHref = "") {
    const previousKey = previousHref
      ? playbackNavigationKey(previousHref)
      : state.navigationKey || playbackNavigationKey(location.href);
    const nextKey = playbackNavigationKey(location.href);
    state.navigationKey = nextKey;
    if (previousKey === nextKey) {
      return false;
    }
    // Bilibili may fetch and rewrite the next autoplay presentation before
    // history.pushState changes the visible URL. Keep only routes whose
    // authenticated presentation identity matches that new URL; otherwise the
    // navigation reset would delete the newly prepared rules and let the next
    // player fall back to an explicitly blocked host.
    const retainedRoutes = [...state.mediaRoutes.values()].filter((route) =>
      presentationMatchesPage(route.presentationId)
    );
    resetPlaybackRouting();
    for (const route of retainedRoutes) {
      state.mediaRoutes.set(
        routeIdentity(route.presentationId, route.routeKey),
        route
      );
    }
    emit("NAVIGATION", { url: location.href });
    void emitRouteManifest(retainedRoutes);
    return true;
  }

  function playurlRewriteEnabled() {
    return Boolean(
      isPlaybackPage() &&
      state.lifecycleActive &&
      state.config.settings.globalEnabled &&
        state.config.settings.acceleration.enabled &&
        state.config.settings.acceleration.playurlRewrite
    );
  }

  function compatibleRouteUrls(key, presentationId = "unassigned") {
    const configured =
      state.config.compatibleRoutes?.[routeIdentity(presentationId, key)] ??
      state.config.compatibleRoutes?.[key];
    return unique(Array.isArray(configured) ? configured : []).filter(
      (url) => isMediaUrl(url) && mediaKey(url) === key
    );
  }

  function rememberRoute(baseUrl, exactUrls, originalUrls, node, manifests, context) {
    const key = mediaKey(baseUrl);
    if (!key) {
      return;
    }
    const presentationId =
      normalizedPresentationId(context?.presentationId) || "unassigned";
    const identity = routeIdentity(presentationId, key);
    const previous = state.mediaRoutes.get(identity);
    // The latest policy decision must lead the route. Keeping a URL captured
    // before blocked-host policy at the front caused the initial probe to hit
    // that stale blocked URL even after playurl had selected a safe backup.
    const urls = unique([...exactUrls, ...(previous?.urls ?? [])]).slice(
      0,
      MAX_HOSTS_PER_ROUTE
    );
    const kind = String(node.mimeType ?? node.mime_type ?? "").includes("audio")
      ? "audio"
      : String(node.mimeType ?? node.mime_type ?? "").includes("video")
        ? "video"
        : key.toLowerCase().endsWith(".mp4")
          ? "mp4"
          : "media";
    const route = {
      presentationId,
      routeKey: key,
      kind,
      urls,
      originalUrls: unique([
        ...(previous?.originalUrls ?? []),
        ...originalUrls
      ]).slice(0, MAX_HOSTS_PER_ROUTE),
      bandwidth: Math.min(
        200_000_000,
        Math.max(0, Number(node.bandwidth) || previous?.bandwidth || 0)
      ),
      updatedAt: Date.now()
    };
    state.mediaRoutes.set(identity, route);
    manifests.push({
      presentationId,
      routeKey: key,
      urls,
      originalUrls: route.originalUrls,
      bandwidth: route.bandwidth,
      kind
    });
  }

  function rewriteStreamNode(node, baseKey, backupKey, rewriteContext) {
    const originalBase = node[baseKey];
    if (!isMediaUrl(originalBase)) {
      return false;
    }
    const originalBackups = Array.isArray(node[backupKey])
      ? node[backupKey].filter((url) => isMediaUrl(url))
      : [];
    const originalUrls = unique([originalBase, ...originalBackups]);
    const key = mediaKey(originalBase);
    if (!canTrackRoute(rewriteContext.presentationId, key)) {
      return false;
    }
    if (routeUsesNativeBypass(rewriteContext.presentationId, key)) {
      rememberRoute(
        originalBase,
        originalUrls,
        originalUrls,
        node,
        rewriteContext.routes,
        rewriteContext
      );
      return false;
    }
    const compatible = compatibleRouteUrls(
      key,
      rewriteContext.presentationId
    );
    const exactUrls = unique([...originalUrls, ...compatible]).filter(
      (raw) => mediaKey(raw) === key
    );
    const unblockedOriginals = originalUrls.filter((raw) => {
      const url = parseUrl(raw);
      return (
        url &&
        !isBlockedHost(url.hostname) &&
        !isSessionHostBlocked(
          key,
          url.hostname,
          rewriteContext.presentationId
        )
      );
    });
    const safeCompatible = compatible.filter((raw) => {
      const host = new URL(raw).hostname;
      return (
        !isBlockedHost(host) &&
        !isSessionHostBlocked(key, host, rewriteContext.presentationId)
      );
    });
    const safeExactUrls = exactUrls.filter((raw) =>
      isEligibleRouteUrl(key, raw, rewriteContext.presentationId)
    );
    const originalHost = new URL(originalBase).hostname;
    let nextBase;
    if (safeCompatible.length) {
      nextBase = safeCompatible[0];
    } else if (
      !isBlockedHost(originalHost) &&
      !isSessionHostBlocked(
        key,
        originalHost,
        rewriteContext.presentationId
      )
    ) {
      nextBase = originalBase;
    } else {
      nextBase = unblockedOriginals[0] ?? originalBase;
    }

    const nextBackups = unique([
      ...safeCompatible,
      ...unblockedOriginals,
      ...safeExactUrls
    ]).filter((url) => url !== nextBase);

    node[baseKey] = nextBase;
    node[backupKey] = nextBackups;
    rememberRoute(
      nextBase,
      unique([nextBase, ...nextBackups]),
      originalUrls,
      node,
      rewriteContext.routes,
      rewriteContext
    );
    rewriteContext.host ||= new URL(nextBase).hostname;
    return (
      nextBase !== originalBase ||
      JSON.stringify(nextBackups) !== JSON.stringify(originalBackups)
    );
  }

  function rewritePlayurl(payload, presentationId = "") {
    let changed = false;
    let streams = 0;
    const seen = new WeakSet();
    const rewriteContext = {
      host: "",
      routes: [],
      presentationId:
        normalizedPresentationId(presentationId) || "unassigned"
    };
    stagePresentation(rewriteContext.presentationId);

    function visit(value) {
      if (!value || typeof value !== "object" || seen.has(value)) {
        return;
      }
      seen.add(value);
      const baseKey = ["baseUrl", "base_url", "url"].find(
        (key) => typeof value[key] === "string"
      );
      const backupKey =
        ["backupUrl", "backup_url"].find((key) =>
          Object.prototype.hasOwnProperty.call(value, key)
        ) ?? (baseKey === "baseUrl" ? "backupUrl" : "backup_url");
      if (
        baseKey &&
        backupKey &&
        rewriteStreamNode(value, baseKey, backupKey, rewriteContext)
      ) {
        changed = true;
        streams += 1;
      }
      for (const child of Object.values(value)) {
        visit(child);
      }
    }

    visit(payload);
    return {
      payload,
      changed,
      streams,
      host: rewriteContext.host,
      routes: rewriteContext.routes.slice(0, 64)
    };
  }

  function emitRouteManifest(routes, waitForReady = false) {
    const activeRoutes = routes.filter((route) =>
      presentationIsActive(route?.presentationId)
    );
    if (activeRoutes.length) {
      state.policySerial += 1;
      const requestId = `policy-${state.policySerial}`;
      let policyReady = Promise.resolve(true);
      if (waitForReady) {
        policyReady = new Promise((resolve) => {
          const timer = setTimeout(() => {
            state.policyWaiters.delete(requestId);
            resolve(false);
          }, POLICY_READY_WAIT_MS);
          timer?.unref?.();
          state.policyWaiters.set(requestId, { resolve, timer });
          while (state.policyWaiters.size > 32) {
            const oldestKey = state.policyWaiters.keys().next().value;
            const oldest = state.policyWaiters.get(oldestKey);
            clearTimeout(oldest?.timer);
            oldest?.resolve(false);
            state.policyWaiters.delete(oldestKey);
          }
        });
      }
      emit("ROUTE_MANIFEST", { routes: activeRoutes, requestId });
      // Reserve one of the two presentation-scoped probe slots for the
      // representation that the native ABR actually requests. Seeding both
      // the first video and first audio entries consumed the whole budget even
      // when neither entry was selected for playback.
      const initialRoute =
        activeRoutes.find((route) => route.kind === "video") ??
        activeRoutes[0];
      emitProbeForRoute(initialRoute);
      return policyReady;
    }
    return Promise.resolve(true);
  }

  function emitProbeForRoute(route, preferredUrl = "") {
    if (
      !route ||
      routeUsesNativeBypass(route.presentationId, route.routeKey)
    ) {
      return false;
    }
    const preferredParsed = parseUrl(preferredUrl);
    const preferred =
      preferredParsed &&
      isMediaUrl(preferredParsed.href) &&
      mediaKey(preferredUrl) === route?.routeKey &&
      !isBlockedHost(preferredParsed.hostname)
        ? preferredParsed.href
        : "";
    const mediaUrl =
      preferred ||
      route?.urls?.find((url) =>
        isEligibleRouteUrl(
          route.routeKey,
          url,
          route.presentationId
        )
      );
    const key = mediaKey(mediaUrl);
    const host = isMediaUrl(mediaUrl) ? new URL(mediaUrl).hostname : "";
    const probeKey = route
      ? `${routeIdentity(route.presentationId, key)}\u0000${host}`
      : "";
    if (!route || !key || !host || state.probedKeys.has(probeKey)) {
      return false;
    }
    state.probedKeys.add(probeKey);
    emit("PROBE_URL", {
      mediaUrl,
      presentationId: route.presentationId,
      kind: route.kind,
      routeKey: route.routeKey
    });
    return true;
  }

  async function sha256Hex(bytes) {
    const digest = await globalThis.crypto?.subtle?.digest?.(
      "SHA-256",
      bytes
    );
    if (!digest) {
      return "";
    }
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function xhrByteZeroSample(xhr) {
    const status = Number(xhr.status) || 0;
    if (status !== 200 && status !== 206) {
      return null;
    }
    if (status === 206) {
      let contentRange = "";
      try {
        contentRange = String(
          xhr.getResponseHeader?.("content-range") ?? ""
        );
      } catch {
        return null;
      }
      if (!/^bytes\s+0-\d+\/(?:\d+|\*)$/i.test(contentRange.trim())) {
        return null;
      }
    }
    const response = xhr.response;
    if (response instanceof ArrayBuffer) {
      return response.byteLength >= PROBE_REFERENCE_BYTES
        ? new Uint8Array(response, 0, PROBE_REFERENCE_BYTES)
        : null;
    }
    if (ArrayBuffer.isView(response)) {
      return response.byteLength >= PROBE_REFERENCE_BYTES
        ? new Uint8Array(
            response.buffer,
            response.byteOffset,
            PROBE_REFERENCE_BYTES
          )
        : null;
    }
    if (typeof Blob !== "undefined" && response instanceof Blob) {
      return response.size >= PROBE_REFERENCE_BYTES
        ? response.slice(0, PROBE_REFERENCE_BYTES)
        : null;
    }
    return null;
  }

  async function emitObservedProbeReference(
    xhr,
    meta,
    actualUrl,
    routingGeneration
  ) {
    const presentationId =
      normalizedPresentationId(meta?.presentationId) || "unassigned";
    const parsed = parseUrl(actualUrl);
    if (
      !playurlRewriteEnabled() ||
      state.routingGeneration !== routingGeneration ||
      presentationId === "unassigned" ||
      meta?.kind !== "video" ||
      !meta?.route ||
      !parsed ||
      !isMediaUrl(parsed.href) ||
      mediaKey(parsed.href) !== meta.routeKey
    ) {
      return false;
    }
    const registeredUrls = [
      ...(meta.route.urls ?? []),
      ...(meta.route.originalUrls ?? [])
    ].map((url) => parseUrl(url)?.href);
    if (!registeredUrls.includes(parsed.href)) {
      return false;
    }
    const referenceKey =
      `${routeIdentity(presentationId, meta.routeKey)}` +
      `\u0000${parsed.hostname}`;
    const referenceCount =
      state.probeReferenceCountsByPresentation.get(presentationId) ?? 0;
    if (
      state.probeReferenceKeys.has(referenceKey) ||
      referenceCount >= MAX_PROBE_REFERENCES_PER_PRESENTATION
    ) {
      return false;
    }
    let sample;
    try {
      sample = xhrByteZeroSample(xhr);
    } catch {
      return false;
    }
    if (!sample) {
      return false;
    }
    state.probeReferenceKeys.add(referenceKey);
    state.probeReferenceCountsByPresentation.set(
      presentationId,
      referenceCount + 1
    );
    let emitted = false;
    try {
      const bytes =
        sample instanceof Blob
          ? new Uint8Array(await sample.arrayBuffer())
          : sample;
      const sampleHash = await sha256Hex(bytes);
      if (
        !/^[0-9a-f]{64}$/.test(sampleHash) ||
        state.routingGeneration !== routingGeneration ||
        !playurlRewriteEnabled()
      ) {
        return false;
      }
      emit("PROBE_REFERENCE", {
        mediaUrl: parsed.href,
        presentationId,
        kind: meta.kind,
        routeKey: meta.routeKey,
        referenceHash: sampleHash,
        referenceStatus: Number(xhr.status) || 0,
        referenceBytes: PROBE_REFERENCE_BYTES
      });
      emitted = true;
      return true;
    } catch {
      return false;
    } finally {
      if (!emitted && state.probeReferenceKeys.delete(referenceKey)) {
        const count =
          state.probeReferenceCountsByPresentation.get(presentationId) ?? 1;
        if (count <= 1) {
          state.probeReferenceCountsByPresentation.delete(presentationId);
        } else {
          state.probeReferenceCountsByPresentation.set(
            presentationId,
            count - 1
          );
        }
      }
    }
  }

  function acknowledgePolicyReady(requestId) {
    const waiter = state.policyWaiters.get(String(requestId ?? ""));
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    state.policyWaiters.delete(String(requestId));
    waiter.resolve(true);
  }

  async function waitForInitialConfig() {
    if (state.configReady) {
      return true;
    }
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), CONFIG_STARTUP_WAIT_MS);
      timer?.unref?.();
    });
    const ready = await Promise.race([
      initialConfigReady.then(() => true),
      timedOut
    ]);
    clearTimeout(timer);
    return ready;
  }

  function copyResponseMetadata(target, source) {
    for (const property of ["url", "redirected", "type"]) {
      try {
        Object.defineProperty(target, property, {
          configurable: true,
          value: source[property]
        });
      } catch {
        // Response metadata is best-effort only.
      }
    }
    return target;
  }

  async function rewriteFetchResponse(response, requestUrl) {
    if (!response.ok) {
      return response;
    }
    try {
      const text = await response.clone().text();
      const presentationId = presentationIdForPlayurl(requestUrl);
      const result = rewritePlayurl(JSON.parse(text), presentationId);
      await emitRouteManifest(result.routes, true);
      if (!result.changed) {
        return response;
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      const rewritten = new Response(JSON.stringify(result.payload), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
      if (presentationIsActive(presentationId)) {
        emit("MEDIA_REWRITE", {
          presentationId,
          streams: result.streams,
          host: result.host
        });
      }
      return copyResponseMetadata(rewritten, response);
    } catch {
      return response;
    }
  }

  function clonePlayinfo(value) {
    try {
      return structuredClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return value;
      }
    }
  }

  function rewriteBootstrapPlayinfo(value) {
    if (
      !playurlRewriteEnabled() ||
      !value ||
      typeof value !== "object"
    ) {
      return value;
    }
    try {
      const presentationId = presentationIdForPage();
      const result = rewritePlayurl(clonePlayinfo(value), presentationId);
      void emitRouteManifest(result.routes);
      if (result.changed && presentationIsActive(presentationId)) {
        emit("MEDIA_REWRITE", {
          presentationId,
          streams: result.streams,
          host: result.host,
          source: "bootstrap-playinfo"
        });
      }
      return result.payload;
    } catch {
      return value;
    }
  }

  function installBootstrapPlayinfoHook() {
    if (state.bootstrapPlayinfo.installed) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      window,
      "__playinfo__"
    );
    if (descriptor && !descriptor.configurable) {
      return;
    }
    const initialValue = descriptor?.get
      ? descriptor.get.call(window)
      : descriptor?.value;
    state.bootstrapPlayinfo.originalDescriptor = descriptor ?? null;
    state.bootstrapPlayinfo.raw = initialValue;
    state.bootstrapPlayinfo.value = initialValue;
    state.bootstrapPlayinfo.getter = function biliBootstrapPlayinfoGet() {
      return state.bootstrapPlayinfo.value;
    };
    state.bootstrapPlayinfo.setter = function biliBootstrapPlayinfoSet(next) {
      state.bootstrapPlayinfo.revision += 1;
      state.bootstrapPlayinfo.raw = next;
      state.bootstrapPlayinfo.value = rewriteBootstrapPlayinfo(next);
      if (playurlRewriteEnabled()) {
        state.bootstrapPlayinfo.processedRevision =
          state.bootstrapPlayinfo.revision;
      }
    };
    Object.defineProperty(window, "__playinfo__", {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: state.bootstrapPlayinfo.getter,
      set: state.bootstrapPlayinfo.setter
    });
    state.bootstrapPlayinfo.installed = true;
    if (initialValue !== undefined) {
      state.bootstrapPlayinfo.setter(initialValue);
    }
  }

  function refreshBootstrapPlayinfo() {
    if (!state.bootstrapPlayinfo.installed) {
      installBootstrapPlayinfoHook();
    }
    if (
      state.bootstrapPlayinfo.installed &&
      state.bootstrapPlayinfo.raw !== undefined &&
      state.bootstrapPlayinfo.processedRevision !==
        state.bootstrapPlayinfo.revision
    ) {
      state.bootstrapPlayinfo.value = rewriteBootstrapPlayinfo(
        state.bootstrapPlayinfo.raw
      );
      if (playurlRewriteEnabled()) {
        state.bootstrapPlayinfo.processedRevision =
          state.bootstrapPlayinfo.revision;
      }
    }
  }

  function restoreBootstrapPlayinfoHook() {
    if (!state.bootstrapPlayinfo.installed) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      window,
      "__playinfo__"
    );
    if (
      descriptor?.get !== state.bootstrapPlayinfo.getter ||
      descriptor?.set !== state.bootstrapPlayinfo.setter
    ) {
      state.bootstrapPlayinfo.installed = false;
      return;
    }
    const value = state.bootstrapPlayinfo.value;
    const original = state.bootstrapPlayinfo.originalDescriptor;
    if (original) {
      Object.defineProperty(window, "__playinfo__", {
        ...original,
        ...("value" in original ? { value } : {})
      });
    } else {
      Object.defineProperty(window, "__playinfo__", {
        configurable: true,
        enumerable: true,
        writable: true,
        value
      });
    }
    state.bootstrapPlayinfo.installed = false;
    state.bootstrapPlayinfo.getter = null;
    state.bootstrapPlayinfo.setter = null;
  }

  function responseFailed(response) {
    return (
      response.status === 0 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status >= 500
    );
  }

  function noteHostFailure(route, host, detail, failureThreshold = 2) {
    const routeKey = route.routeKey;
    const stateKey = routeIdentity(route.presentationId, routeKey);
    const failureKey = `${stateKey}\u0000${host}`;
    const failures = (state.hostFailures.get(failureKey) ?? 0) + 1;
    state.hostFailures.set(failureKey, failures);
    if (
      failures >= Math.max(1, Number(failureThreshold) || 2) &&
      !isLocalRouteHostBlocked(routeKey, host, route.presentationId)
    ) {
      const blocked =
        state.localRouteBlockedHosts.get(stateKey) ?? new Map();
      blocked.set(host, Date.now() + LOCAL_HOST_STRIKE_TTL_MS);
      state.localRouteBlockedHosts.set(stateKey, blocked);
      emit("FALLBACK", {
        presentationId: route.presentationId,
        kind: route.kind,
        routeKey,
        host,
        detail: detail || "host blacklisted"
      });
    }
    return failures;
  }

  function originalFallbackUrl(route, defaultUrl) {
    const defaultHost = parseUrl(defaultUrl)?.hostname ?? "";
    const availableOriginal = route.originalUrls.find((rawUrl) => {
      const url = parseUrl(rawUrl);
      return (
        url &&
        !isBlockedHost(url.hostname) &&
        !isSessionHostBlocked(
          route.routeKey,
          url.hostname,
          route.presentationId
        )
      );
    });
    if (availableOriginal) {
      return availableOriginal;
    }
    // If every ordinary candidate is unavailable, permit one exact URL that
    // Bilibili itself supplied as the final native availability escape. Static
    // catalog hosts remain excluded from compatibleRoutes and DNR targets.
    // After two real failures the local strike prevents repeatedly cycling
    // back to the same native escape.
    const nativeEscape = route.originalUrls.find((rawUrl) => {
        const url = parseUrl(rawUrl);
        return Boolean(
          url &&
          url.hostname !== defaultHost &&
          isBlockedHost(url.hostname) &&
          !isLocalRouteHostBlocked(
            route.routeKey,
            url.hostname,
            route.presentationId
          )
        );
      });
    if (!nativeEscape) {
      return defaultUrl;
    }
    const stateKey = routeIdentity(route.presentationId, route.routeKey);
    if (state.nativeEscapeRoutes.has(stateKey)) {
      return defaultUrl;
    }
    // A native escape is an availability exception, not another route in the
    // retry ring. Once the extension has selected it for this representation,
    // later requests stay on Bilibili's requested URL until a verified route
    // or a new representation appears. This prevents Akamai <-> ov bouncing
    // when every measured candidate is unusable.
    state.nativeEscapeRoutes.add(stateKey);
    return nativeEscape;
  }

  function requestForUrl(input, init, targetUrl, timeoutMs) {
    const baseRequest = new Request(input, init);
    const controller = new AbortController();
    const originalSignal = baseRequest.signal;
    const abortFromOriginal = () => controller.abort(originalSignal.reason);
    if (originalSignal) {
      if (originalSignal.aborted) {
        abortFromOriginal();
      } else {
        originalSignal.addEventListener("abort", abortFromOriginal, {
          once: true
        });
      }
    }
    const timer = setTimeout(() => controller.abort("cdn fallback timeout"), timeoutMs);
    const request = new Request(targetUrl, {
      method: baseRequest.method,
      headers: baseRequest.headers,
      mode: baseRequest.mode,
      credentials: baseRequest.credentials,
      cache: baseRequest.cache,
      redirect: baseRequest.redirect,
      referrer: baseRequest.referrer,
      referrerPolicy: baseRequest.referrerPolicy,
      integrity: baseRequest.integrity,
      keepalive: baseRequest.keepalive,
      signal: controller.signal
    });
    return {
      request,
      release() {
        clearTimeout(timer);
        originalSignal?.removeEventListener?.("abort", abortFromOriginal);
      }
    };
  }

  async function mediaFetchWithFallback(input, init, rawUrl, route) {
    const routingGeneration = state.routingGeneration;
    const routeKey = route.routeKey;
    // Static blocked hosts are never ordinary retry candidates. The original
    // Bilibili URL remains separately available through originalFallbackUrl()
    // as the final native availability escape after safe candidates fail.
    const safeCandidates = unique([
      ...compatibleRouteUrls(routeKey, route.presentationId),
      rawUrl,
      ...route.urls
    ]).filter((url) => {
      const parsed = parseUrl(url);
      return (
        parsed &&
        isEligibleRouteUrl(routeKey, url, route.presentationId) &&
        policyHostChangeAllowed(route, parsed.hostname)
      );
    });
    const nativeFallback = originalFallbackUrl(route, rawUrl);
    // A media segment may perform one primary request and one fallback request.
    // This keeps a failure storm bounded to 2N network attempts. Prefer a second
    // safe exact candidate; the native URL is retained only when no distinct
    // safe fallback exists.
    const candidateUrls = safeCandidates.slice(0, 2);
    if (
      candidateUrls.length < 2 &&
      nativeFallback &&
      !candidateUrls.includes(nativeFallback) &&
      policyHostChangeAllowed(route, new URL(nativeFallback).hostname)
    ) {
      candidateUrls.push(nativeFallback);
    }
    if (!candidateUrls.length) {
      emit("FALLBACK", {
        presentationId: route.presentationId,
        kind: route.kind,
        routeKey: route.routeKey,
        host: parseUrl(rawUrl)?.hostname ?? "",
        detail: "route switch budget exhausted; native pass-through"
      });
      return state.originals.fetch.call(
        window,
        new Request(rawUrl, new Request(input, init))
      );
    }
    const startedAt = performance.now();
    let lastError;

    for (let routeIndex = 0; routeIndex < candidateUrls.length; routeIndex += 1) {
      const targetUrl = candidateUrls[routeIndex];
      const host = new URL(targetUrl).hostname;
      const halfOpenLeader = claimHalfOpenLeader(route, host);
      if (halfOpenLeader === null) {
        continue;
      }
      if (routeIndex > 0) {
        emit("FALLBACK", {
          presentationId: route.presentationId,
          kind: route.kind,
          routeKey: route.routeKey,
          host,
          detail:
            lastError instanceof Error
              ? lastError.message
              : "bounded media retry"
        });
      }
      const remainingBudget = 3200 - (performance.now() - startedAt);
      if (remainingBudget < 250) {
        break;
      }
      const attemptTimeout = Math.min(
        1300,
        remainingBudget
      );
      const prepared = requestForUrl(input, init, targetUrl, attemptTimeout);
      try {
        const response = await state.originals.fetch.call(window, prepared.request);
        if (state.routingGeneration !== routingGeneration) {
          return response;
        }
        if (!responseFailed(response)) {
          reportActualMediaHost(
            targetUrl,
            targetUrl !== route.originalUrls[0],
            route
          );
          const durationMs = Math.max(1, performance.now() - startedAt);
          emit("MEDIA_REQUEST_RESULT", {
            presentationId: route.presentationId,
            kind: route.kind,
            host,
            routeKey: route.routeKey,
            status: Number(response.status) || 0,
            bytes: 0,
            durationMs: Math.round(durationMs),
            throughputBps: 0,
            bufferAhead: bufferAheadSeconds(route.routeKey),
            origin: "fetch",
            routingGeneration,
            requestStartedAt: startedAt
          });
          return response;
        }
        lastError = new Error(`HTTP ${response.status}`);
        noteHostFailure(route, host, lastError.message);
        reportMediaDegraded(
          {
            url: targetUrl,
            presentationId: route.presentationId,
            kind: route.kind,
            routeKey: route.routeKey,
            routingGeneration,
            requestStartedAt: startedAt
          },
          "http-failure",
          {
            status: response.status,
            bufferAhead: bufferAheadSeconds(route.routeKey)
          }
        );
        if (routeIndex === candidateUrls.length - 1) {
          return response;
        }
        response.body?.cancel?.().catch?.(() => {});
      } catch (error) {
        if (state.routingGeneration !== routingGeneration) {
          throw error;
        }
        lastError = error;
        noteHostFailure(
          route,
          host,
          error instanceof Error ? error.message : String(error)
        );
        reportMediaDegraded(
          {
            url: targetUrl,
            presentationId: route.presentationId,
            kind: route.kind,
            routeKey: route.routeKey,
            routingGeneration,
            requestStartedAt: startedAt
          },
          "network-failure",
          { bufferAhead: bufferAheadSeconds(route.routeKey) }
        );
      } finally {
        prepared.release();
        releaseHalfOpenLeader(halfOpenLeader);
      }
    }

    emit("FALLBACK", {
      presentationId: route.presentationId,
      kind: route.kind,
      routeKey: route.routeKey,
      host: candidateUrls.at(-1)
        ? new URL(candidateUrls.at(-1)).hostname
        : "",
      detail:
        lastError instanceof Error ? lastError.message : "healthy hosts exhausted"
    });
    throw lastError ?? new Error("No eligible media route");
  }

  function createFetchWrapper() {
    return async function biliFetch(input, init) {
      const rawUrl = rawRequestUrl(input);
      const playurlRequest = isPlayurl(rawUrl);
      if (playurlRequest && isPlaybackPage() && !state.configReady) {
        // Start the API request immediately and overlap the bounded CONFIG
        // wait with its network flight. This retains C29's 150 ms maximum
        // startup hold while still allowing a safe config that arrives before
        // the response is consumed to rewrite a warm-navigation response.
        const responsePromise = state.originals.fetch.apply(this, arguments);
        const readyWithinBudget = await waitForInitialConfig();
        const response = await responsePromise;
        if (readyWithinBudget && playurlRewriteEnabled()) {
          return rewriteFetchResponse(response, rawUrl);
        }
        emit("STARTUP_PASSTHROUGH", {
          readyWithinBudget,
          configReady: state.configReady,
          elapsedMs: Math.round(performance.now() - DOCUMENT_STARTED_AT)
        });
        return response;
      }
      if (
        !playurlRequest &&
        !rawUrl.includes(".m4s") &&
        !rawUrl.includes(".flv") &&
        !rawUrl.includes(".mp4")
      ) {
        return state.originals.fetch.apply(this, arguments);
      }
      if (playurlRewriteEnabled()) {
        if (playurlRequest) {
          const response = await state.originals.fetch.apply(this, arguments);
          return rewriteFetchResponse(response, rawUrl);
        }
        if (isMediaUrl(rawUrl)) {
          const route = findMediaRoute(rawUrl);
          if (
            route &&
            !routeUsesNativeBypass(
              route.presentationId,
              route.routeKey
            )
          ) {
            emitProbeForRoute(route, rawUrl);
            return mediaFetchWithFallback(input, init, rawUrl, route);
          }
        }
      }
      return state.originals.fetch.apply(this, arguments);
    };
  }

  function pristineHistoryMethod(method) {
    if (state.pristineHistory[method]) {
      return state.pristineHistory[method];
    }
    const parent = document.documentElement ?? document.head;
    if (!parent) {
      return null;
    }
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.setAttribute("aria-hidden", "true");
    parent.append(iframe);
    try {
      const candidate = iframe.contentWindow?.history?.[method];
      if (typeof candidate === "function") {
        state.pristineHistory[method] = candidate;
        return candidate;
      }
    } finally {
      iframe.remove();
    }
    return null;
  }

  function callHistoryOriginal(method, thisValue, args) {
    if (state.historyReentry[method]) {
      const pristine = pristineHistoryMethod(method);
      return pristine ? pristine.apply(thisValue, args) : undefined;
    }
    state.historyReentry[method] = true;
    try {
      return state.originals[method].apply(thisValue, args);
    } finally {
      state.historyReentry[method] = false;
    }
  }

  function rewrittenXhrText(xhr, rawText) {
    const meta = state.xhrMeta.get(xhr);
    if (
      !meta ||
      !isPlayurl(meta.url) ||
      !playurlRewriteEnabled()
    ) {
      return rawText;
    }
    const cached = state.xhrRewriteCache.get(xhr);
    if (cached?.rawText === rawText) {
      return cached.text;
    }
    try {
      const presentationId = presentationIdForPlayurl(meta.url);
      const result = rewritePlayurl(JSON.parse(rawText), presentationId);
      emitRouteManifest(result.routes);
      const text = result.changed ? JSON.stringify(result.payload) : rawText;
      state.xhrRewriteCache.set(xhr, {
        rawText,
        text,
        json: result.payload
      });
      if (result.changed && presentationIsActive(presentationId)) {
        emit("MEDIA_REWRITE", {
          presentationId,
          streams: result.streams,
          host: result.host
        });
      }
      return text;
    } catch {
      return rawText;
    }
  }

  function bufferAheadSeconds(routeKey = "") {
    const videos = document.querySelectorAll?.("video");
    if (!videos?.length) {
      return null;
    }
    let selected = [...videos];
    if (routeKey) {
      const matching = selected.filter((video) => {
        const source = parseUrl(video.currentSrc || video.src);
        return source?.pathname === routeKey;
      });
      if (matching.length) {
        selected = matching;
      } else if (selected.length !== 1) {
        // A page-wide maximum lets one well-buffered player hide a different
        // stalled player. Ambiguous attribution must stay diagnostic-only.
        return null;
      }
    } else if (selected.length !== 1) {
      return null;
    }
    let best = null;
    for (const video of selected) {
      const currentTime = Number(video.currentTime) || 0;
      const ranges = video.buffered;
      if (!ranges) {
        continue;
      }
      for (let index = 0; index < ranges.length; index += 1) {
        if (
          ranges.start(index) <= currentTime + 0.25 &&
          ranges.end(index) >= currentTime
        ) {
          best = Math.max(best ?? 0, ranges.end(index) - currentTime);
        }
      }
    }
    return best ?? 0;
  }

  function reportMediaDegraded(meta, reason, details = {}) {
    if (
      reason === "slow-body" &&
      meta.reportedDegradationReasons?.has(reason)
    ) {
      return false;
    }
    const host = new URL(meta.url).hostname;
    const reportKey =
      `${routeIdentity(meta.presentationId, meta.routeKey)}` +
      `|${host}|${reason}`;
    const now = Date.now();
    const reportWindowMs = reason === "slow-body" ? 30_000 : 60_000;
    let reportState = state.degradedReports.get(reportKey);
    if (
      !reportState ||
      now - reportState.windowStartedAt >= reportWindowMs
    ) {
      reportState = { count: 0, windowStartedAt: now };
    }
    const reportLimit = reason === "slow-body" ? 2 : 1;
    if (reportState.count >= reportLimit) {
      return false;
    }
    reportState.count += 1;
    state.degradedReports.set(reportKey, reportState);
    meta.reportedDegradationReasons?.add(reason);
    if (reason === "body-stalled") {
      meta.handoffSafe = true;
    }
    emit("MEDIA_DEGRADED", {
      presentationId:
        normalizedPresentationId(meta.presentationId) || "unassigned",
      kind: meta.kind || "media",
      host,
      routeKey: meta.routeKey,
      reason,
      throughputBps: Math.max(0, Math.round(details.throughputBps || 0)),
      requiredBps: Math.max(0, Math.round(details.requiredBps || 0)),
      bufferAhead:
        details.bufferAhead === null
          ? null
          : Math.max(0, Number(details.bufferAhead) || 0),
      status: Math.max(0, Number(details.status) || 0),
      bytes: Math.max(0, Number(details.bytes) || 0),
      expectedBytes: Math.max(0, Number(details.expectedBytes) || 0),
      progressAgeMs: Math.max(0, Math.round(details.progressAgeMs || 0)),
      routingGeneration: Math.max(
        0,
        Number(meta.routingGeneration) || 0
      ),
      requestStartedAt: Math.max(
        0,
        Number(meta.requestStartedAt ?? meta.startedAt) || 0
      )
    });
    if (meta.route && (reason === "body-stalled" || reason === "slow-body")) {
      noteHostFailure(
        meta.route,
        host,
        `XHR ${reason}`,
        reason === "body-stalled" ? 1 : 2
      );
    }
    return true;
  }

  function routeSwitchWindow(route) {
    const key = routeIdentity(route.presentationId, route.routeKey);
    const now = Date.now();
    const current = state.routeSwitchWindows.get(key) ?? {
      host: "",
      switches: []
    };
    current.switches = current.switches.filter(
      (at) => now - at < 30_000
    );
    state.routeSwitchWindows.set(key, current);
    return current;
  }

  function policyHostChangeAllowed(route, host) {
    const windowState = routeSwitchWindow(route);
    return (
      !windowState.host ||
      windowState.host === host ||
      windowState.switches.length < 2
    );
  }

  function recordRouteHost(route, host) {
    const windowState = routeSwitchWindow(route);
    if (windowState.host && windowState.host !== host) {
      windowState.switches.push(Date.now());
    }
    windowState.host = host;
  }

  function reportActualMediaHost(rawUrl, rewritten, route = findMediaRoute(rawUrl)) {
    const parsed = parseUrl(rawUrl);
    if (!parsed || !isAllowedMediaHostname(parsed.hostname)) {
      return;
    }
    const routeKey = route?.routeKey ?? mediaKey(parsed.href);
    const presentationId = route?.presentationId ?? "unassigned";
    const reportKey = routeIdentity(presentationId, routeKey);
    if (route) {
      recordRouteHost(route, parsed.hostname);
      state.hostFailures.delete(`${reportKey}\u0000${parsed.hostname}`);
      const local = state.localRouteBlockedHosts.get(reportKey);
      local?.delete(parsed.hostname);
      if (local && !local.size) {
        state.localRouteBlockedHosts.delete(reportKey);
      }
    }
    if (state.lastReportedHosts.get(reportKey) !== parsed.hostname) {
      state.lastReportedHosts.set(reportKey, parsed.hostname);
      emit("MEDIA_HOST", {
        presentationId,
        kind: route?.kind ?? "media",
        host: parsed.hostname,
        rewritten: Boolean(rewritten),
        routeKey
      });
    }
  }

  function activeXhrsForRoute(route) {
    const identity = routeIdentity(route.presentationId, route.routeKey);
    let active = state.activeMediaXhrs.get(identity);
    if (!active) {
      active = new Set();
      state.activeMediaXhrs.set(identity, active);
    }
    return active;
  }

  function unregisterActiveXhr(xhr, meta) {
    if (!meta?.route) {
      return;
    }
    const identity = routeIdentity(
      meta.route.presentationId,
      meta.route.routeKey
    );
    const active = state.activeMediaXhrs.get(identity);
    active?.delete(xhr);
    if (active && !active.size) {
      state.activeMediaXhrs.delete(identity);
    }
  }

  function triggerSafeXhrHandoffs() {
    if (
      document.hidden ||
      !playurlRewriteEnabled() ||
      !state.activeMediaXhrs.size
    ) {
      return;
    }
    for (const active of state.activeMediaXhrs.values()) {
      for (const xhr of active) {
        const meta = state.xhrMeta.get(xhr);
        if (
          !meta?.route ||
          meta.handoffRequested ||
          routeUsesNativeBypass(
            meta.presentationId,
            meta.routeKey
          ) ||
          !presentationIsActive(meta.presentationId)
        ) {
          continue;
        }
        const currentHost = parseUrl(meta.url)?.hostname ?? "";
        if (
          !currentHost ||
          !isSessionHostBlocked(
            meta.routeKey,
            currentHost,
            meta.presentationId
          )
        ) {
          continue;
        }
        const bufferAhead = bufferAheadSeconds(meta.routeKey);
        if (bufferAhead === null || bufferAhead > 4) {
          continue;
        }
        const progressIdleMs = Math.max(
          0,
          performance.now() - meta.lastProgressAt
        );
        // A soft throughput warning may open policy while the current Range
        // is still advancing. Aborting that body discards useful bytes and
        // restarts the same segment on an unproven path. Mid-body handoff is
        // reserved for a real progress stall; soft decisions affect the next
        // request instead.
        if (!meta.handoffSafe && progressIdleMs < SAFE_HANDOFF_IDLE_MS) {
          continue;
        }
        const candidate = compatibleRouteUrls(
          meta.routeKey,
          meta.presentationId
        ).find((raw) => {
          const parsed = parseUrl(raw);
          return Boolean(
            parsed &&
              parsed.hostname !== currentHost &&
              isEligibleRouteUrl(
                meta.routeKey,
                parsed.href,
                meta.presentationId
              )
          );
        });
        if (!candidate || typeof xhr.abort !== "function") {
          continue;
        }
        meta.handoffRequested = true;
        meta.termination = "handoff";
        emit("HANDOFF_TRIGGERED", {
          presentationId: meta.presentationId,
          kind: meta.kind,
          routeKey: meta.routeKey,
          fromHost: currentHost,
          toHost: new URL(candidate).hostname,
          bufferAhead
        });
        try {
          xhr.abort();
        } catch {
          meta.handoffRequested = false;
          meta.termination = "";
        }
      }
    }
  }

  function xhrResponseRange(xhr) {
    try {
      return String(xhr.getResponseHeader?.("content-range") ?? "").slice(
        0,
        160
      );
    } catch {
      return "";
    }
  }

  function xhrExpectedBytes(xhr, meta) {
    if (meta.total > 0) {
      return meta.total;
    }
    const match = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i.exec(
      xhrResponseRange(xhr).trim()
    );
    if (!match) {
      return 0;
    }
    return Math.max(0, Number(match[2]) - Number(match[1]) + 1);
  }

  function installXhrHooks() {
    const prototype = window.XMLHttpRequest?.prototype;
    if (!prototype) {
      return;
    }
    state.originals.xhrOpen = prototype.open;
    state.originals.xhrSend = prototype.send;
    state.originals.responseTextDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "responseText"
    );
    state.originals.responseDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "response"
    );

    state.wrappers.xhrOpen = function biliXhrOpen(method, url) {
      if (!isPlaybackPage()) {
        return state.originals.xhrOpen.apply(this, arguments);
      }
      let nextUrl = url;
      const rawUrl = typeof url === "string" ? url : String(url);
      const absoluteRawUrl = new URL(rawUrl, location.href).href;
      const routeKey = mediaKey(absoluteRawUrl);
      let route = null;
      let halfOpenLeader = "";
      if (playurlRewriteEnabled() && isMediaUrl(rawUrl)) {
        route = findMediaRoute(absoluteRawUrl);
        if (
          route &&
          routeUsesNativeBypass(
            route.presentationId,
            route.routeKey
          )
        ) {
          route = null;
        }
        if (route) {
          emitProbeForRoute(route, absoluteRawUrl);
        }
        const currentHost = new URL(absoluteRawUrl).hostname;
        if (
          route &&
          (
            isBlockedHost(currentHost) ||
            isSessionHostBlocked(
              routeKey,
              currentHost,
              route.presentationId
            )
          )
        ) {
          nextUrl = unique([
            ...compatibleRouteUrls(
              routeKey,
              route.presentationId
            ),
            ...route.urls
          ]).find(
            (candidate) =>
              isEligibleRouteUrl(
                routeKey,
                candidate,
                route.presentationId
              )
          );
          nextUrl ||= originalFallbackUrl(route, rawUrl);
        }
        if (route) {
          const selectedHost = new URL(nextUrl, location.href).hostname;
          const leader = claimHalfOpenLeader(route, selectedHost);
          if (leader === null) {
            nextUrl =
              route.urls.find((candidate) => {
                const candidateHost = new URL(
                  candidate,
                  location.href
                ).hostname;
                return (
                  candidateHost !== selectedHost &&
                  !isHalfOpenHost(route, candidateHost) &&
                  isEligibleRouteUrl(
                    routeKey,
                    candidate,
                    route.presentationId
                  )
                );
              }) ?? originalFallbackUrl(route, rawUrl);
          } else if (leader) {
            halfOpenLeader = leader;
          }
        }
      }
      state.xhrMeta.set(this, {
        requestedUrl: absoluteRawUrl,
        url: new URL(nextUrl, location.href).href,
        presentationId: route?.presentationId ?? "unassigned",
        kind: route?.kind ?? "media",
        routeKey: route?.routeKey ?? routeKey,
        route,
        startedAt: 0,
        requestStartedAt: 0,
        routingGeneration: 0,
        loaded: 0,
        total: 0,
        lastProgressAt: 0,
        slowTimer: null,
        monitoring: false,
        halfOpenLeader,
        handoffRequested: false,
        handoffSafe: false,
        nativeBypass: false,
        reportedDegradationReasons: new Set(),
        termination: ""
      });
      const args = [...arguments];
      args[1] = nextUrl;
      return state.originals.xhrOpen.apply(this, args);
    };

    state.wrappers.xhrSend = function biliXhrSend() {
      const meta = state.xhrMeta.get(this);
      if (
        playurlRewriteEnabled() &&
        meta?.route &&
        presentationIsActive(meta.presentationId) &&
        isMediaUrl(meta.url)
      ) {
        const routingGeneration = state.routingGeneration;
        meta.startedAt = performance.now();
        meta.requestStartedAt = meta.startedAt;
        meta.routingGeneration = routingGeneration;
        meta.lastProgressAt = meta.startedAt;
        meta.monitoring = Boolean(meta.route);
        if (meta.route) {
          activeXhrsForRoute(meta.route).add(this);
        }
        for (const type of ["abort", "error", "timeout"]) {
          this.addEventListener(
            type,
            () => {
              meta.termination ||= type;
            },
            { once: true }
          );
        }
        const scheduleStallWatchdog = () => {
          clearTimeout(meta.slowTimer);
          if (!meta.monitoring) {
            return;
          }
          meta.slowTimer = setTimeout(() => {
            if (!meta.monitoring) {
              return;
            }
            const bufferAhead = bufferAheadSeconds(meta.routeKey);
            const bandwidth = Number(meta.route?.bandwidth) || 0;
            const expectedBytes = xhrExpectedBytes(this, meta);
            const remainingBytes = Math.max(0, expectedBytes - meta.loaded);
            const elapsedMs = Math.max(
              1,
              performance.now() - meta.startedAt
            );
            const averageThroughputBps = meta.loaded
              ? (meta.loaded * 8 * 1000) / elapsedMs
              : 0;
            const remainingMs = averageThroughputBps
              ? (remainingBytes * 8 * 1000) / averageThroughputBps
              : Number.POSITIVE_INFINITY;
            const progressAgeMs = Math.max(
              0,
              performance.now() - meta.lastProgressAt
            );
            const completionBudgetMs =
              bufferAhead === null
                ? MIN_BODY_COMPLETION_GRACE_MS
                : Math.max(
                    MIN_BODY_COMPLETION_GRACE_MS,
                    bufferAhead * 1000
                  );
            const safeTailBytes = expectedBytes
              ? Math.max(
                  MIN_SAFE_BODY_TAIL_BYTES,
                  expectedBytes * SAFE_BODY_TAIL_RATIO
                )
              : 0;
            const completionIsSafe =
              expectedBytes > 0 &&
              (
                (
                  remainingBytes <= safeTailBytes &&
                  progressAgeMs <= SAFE_BODY_TAIL_GRACE_MS
                ) ||
                (
                  remainingMs <= completionBudgetMs &&
                  progressAgeMs <= completionBudgetMs
                )
              );
            if (
              playurlRewriteEnabled() &&
              bandwidth &&
              bufferAhead !== null &&
              bufferAhead < 8 &&
              !completionIsSafe
            ) {
              reportMediaDegraded(meta, "body-stalled", {
                throughputBps: 0,
                requiredBps: bandwidth * 1.25,
                bufferAhead,
                bytes: meta.loaded,
                expectedBytes,
                progressAgeMs: Math.max(
                  2000,
                  performance.now() - meta.lastProgressAt
                )
              });
            }
            scheduleStallWatchdog();
          }, 2000);
          meta.slowTimer?.unref?.();
        };
        const onProgress = (event) => {
          const previousLoaded = meta.loaded;
          const loaded = Math.max(previousLoaded, Number(event.loaded) || 0);
          const progressAt = performance.now();
          meta.loaded = loaded;
          meta.total = Math.max(meta.total, Number(event.total) || 0);
          if (loaded > previousLoaded) {
            meta.lastProgressAt = progressAt;
            scheduleStallWatchdog();
          }
          const elapsedMs = progressAt - meta.startedAt;
          const bandwidth = Number(meta.route?.bandwidth) || 0;
          const bufferAhead = bufferAheadSeconds(meta.routeKey);
          if (elapsedMs < 1500 || !bandwidth || bufferAhead === null) {
            return;
          }
          const throughputBps = (loaded * 8 * 1000) / elapsedMs;
          const requiredBps =
            bandwidth * ACTIVE_BODY_THROUGHPUT_HEADROOM;
          const expectedBytes = xhrExpectedBytes(this, meta);
          const remainingBytes = Math.max(0, expectedBytes - loaded);
          const remainingMs = throughputBps
            ? (remainingBytes * 8 * 1000) / throughputBps
            : Number.POSITIVE_INFINITY;
          const completionBudgetMs = Math.max(
            MIN_BODY_COMPLETION_GRACE_MS,
            bufferAhead * 1000
          );
          const completionAtRisk =
            !expectedBytes || remainingMs > completionBudgetMs;
          if (
            bufferAhead < 8 &&
            throughputBps < requiredBps &&
            completionAtRisk
          ) {
            reportMediaDegraded(meta, "slow-body", {
              throughputBps,
              requiredBps,
              bufferAhead,
              bytes: meta.loaded,
              expectedBytes,
              progressAgeMs: 0
            });
          }
        };
        this.addEventListener("progress", onProgress);
        scheduleStallWatchdog();
        this.addEventListener(
          "loadend",
          () => {
            meta.monitoring = false;
            clearTimeout(meta.slowTimer);
            releaseHalfOpenLeader(meta.halfOpenLeader);
            unregisterActiveXhr(this, meta);
            if (meta.nativeBypass) {
              return;
            }
            const actualUrl =
              typeof this.responseURL === "string" && this.responseURL
                ? this.responseURL
                : meta.url;
            const actualHost = new URL(actualUrl).hostname;
            meta.url = actualUrl;
            const durationMs = Math.max(1, performance.now() - meta.startedAt);
            if (
              meta.termination === "abort" ||
              meta.termination === "handoff"
            ) {
              emit("MEDIA_REQUEST_CANCELLED", {
                presentationId: meta.presentationId,
                kind: meta.kind,
                host: actualHost,
                routeKey: meta.routeKey,
                reason:
                  meta.termination === "handoff"
                    ? "handoff-abort"
                    : "xhr-abort",
                bytes: meta.loaded,
                expectedBytes: xhrExpectedBytes(this, meta),
                durationMs: Math.round(durationMs),
                progressAgeMs: Math.max(
                  0,
                  Math.round(performance.now() - meta.lastProgressAt)
                ),
                responseRange: xhrResponseRange(this),
                routingGeneration: meta.routingGeneration,
                requestStartedAt: meta.requestStartedAt
              });
              return;
            }
            emit("MEDIA_REQUEST_RESULT", {
              presentationId: meta.presentationId,
              kind: meta.kind,
              host: actualHost,
              routeKey: meta.routeKey,
              status: Number(this.status) || 0,
              bytes: meta.loaded,
              expectedBytes: xhrExpectedBytes(this, meta),
              durationMs: Math.round(durationMs),
              progressAgeMs: Math.max(
                0,
                Math.round(performance.now() - meta.lastProgressAt)
              ),
              responseRange: xhrResponseRange(this),
              routingGeneration: meta.routingGeneration,
              requestStartedAt: meta.requestStartedAt,
              throughputBps: Math.round(
                (meta.loaded * 8 * 1000) / durationMs
              ),
              bufferAhead: bufferAheadSeconds(meta.routeKey)
            });
            if (playurlRewriteEnabled() && responseFailed(this)) {
              const reason =
                meta.termination === "timeout"
                  ? "timeout"
                  : Number(this.status) === 0
                    ? "network-failure"
                    : "http-failure";
              const detail =
                reason === "http-failure"
                  ? `XHR HTTP ${this.status}`
                  : `XHR ${reason}`;
              if (meta.route) {
                noteHostFailure(meta.route, actualHost, detail);
              }
              reportMediaDegraded(meta, reason, {
                status: this.status,
                bufferAhead: bufferAheadSeconds(meta.routeKey)
              });
            } else {
              void emitObservedProbeReference(
                this,
                meta,
                actualUrl,
                routingGeneration
              );
              reportActualMediaHost(
                actualUrl,
                actualUrl !== meta.requestedUrl,
                meta.route
              );
            }
          },
          { once: true }
        );
      }
      return state.originals.xhrSend.apply(this, arguments);
    };

    prototype.open = state.wrappers.xhrOpen;
    prototype.send = state.wrappers.xhrSend;

    const responseTextDescriptor = state.originals.responseTextDescriptor;
    if (responseTextDescriptor?.get && responseTextDescriptor.configurable) {
      state.wrappers.responseTextGetter = function biliResponseText() {
        const raw = responseTextDescriptor.get.call(this);
        return this.readyState === 4 ? rewrittenXhrText(this, raw) : raw;
      };
      Object.defineProperty(prototype, "responseText", {
        ...responseTextDescriptor,
        get: state.wrappers.responseTextGetter
      });
    }

    const responseDescriptor = state.originals.responseDescriptor;
    if (responseDescriptor?.get && responseDescriptor.configurable) {
      state.wrappers.responseGetter = function biliResponse() {
        const raw = responseDescriptor.get.call(this);
        if (this.readyState !== 4) {
          return raw;
        }
        if (this.responseType === "" || this.responseType === "text") {
          return rewrittenXhrText(this, raw);
        }
        if (this.responseType === "json") {
          const meta = state.xhrMeta.get(this);
          if (
            !meta ||
            !isPlayurl(meta.url) ||
            !playurlRewriteEnabled()
          ) {
            return raw;
          }
          const cached = state.xhrRewriteCache.get(this);
          if (cached) {
            return cached.json;
          }
          try {
            const clone = JSON.parse(JSON.stringify(raw));
            const presentationId = presentationIdForPlayurl(meta.url);
            const result = rewritePlayurl(clone, presentationId);
            emitRouteManifest(result.routes);
            if (
              result.changed &&
              presentationIsActive(presentationId)
            ) {
              emit("MEDIA_REWRITE", {
                presentationId,
                streams: result.streams,
                host: result.host
              });
            }
            state.xhrRewriteCache.set(this, {
              rawText: "",
              text: "",
              json: result.payload
            });
            return result.payload;
          } catch {
            return raw;
          }
        }
        return raw;
      };
      Object.defineProperty(prototype, "response", {
        ...responseDescriptor,
        get: state.wrappers.responseGetter
      });
    }
  }

  function installClipboardHook() {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText || state.wrappers.clipboardWriteText) {
      return;
    }
    state.originals.clipboardOwner = clipboard;
    state.originals.clipboardWriteText = clipboard.writeText;
    state.originals.clipboardWriteTextOwn =
      Object.prototype.hasOwnProperty.call(clipboard, "writeText");
    state.wrappers.clipboardWriteText = function biliWriteText(text) {
      const nextText =
        state.config.settings.globalEnabled &&
        state.config.settings.privacy.urlCleaning
          ? cleanTextUrls(text)
          : text;
      return state.originals.clipboardWriteText.call(this, nextText);
    };
    try {
      clipboard.writeText = state.wrappers.clipboardWriteText;
    } catch {
      state.wrappers.clipboardWriteText = null;
    }
  }

  function installHooks() {
    state.navigationKey ||= playbackNavigationKey(location.href);
    if (state.installed) {
      installClipboardHook();
      installBootstrapPlayinfoHook();
      return;
    }
    state.installed = true;
    state.originals.ownership = {
      fetch: Object.prototype.hasOwnProperty.call(window, "fetch"),
      pushState: Object.prototype.hasOwnProperty.call(history, "pushState"),
      replaceState: Object.prototype.hasOwnProperty.call(
        history,
        "replaceState"
      ),
      open: Object.prototype.hasOwnProperty.call(window, "open"),
      sendBeacon: Object.prototype.hasOwnProperty.call(
        navigator,
        "sendBeacon"
      )
    };
    state.originals.fetch = window.fetch;
    state.originals.pushState = history.pushState;
    state.originals.replaceState = history.replaceState;
    state.originals.open = window.open;
    state.originals.sendBeacon = navigator.sendBeacon;

    state.wrappers.fetch = createFetchWrapper();
    state.wrappers.pushState = function biliPushState(stateValue, title, url) {
      const previousHref = location.href;
      const nextUrl =
        state.config.settings.globalEnabled &&
        state.config.settings.privacy.urlCleaning &&
        url !== undefined
          ? cleanUrl(url)
          : url;
      const result = callHistoryOriginal("pushState", this, [
        stateValue,
        title,
        nextUrl
      ]);
      if (
        state.config.settings.globalEnabled &&
        location.href !== previousHref
      ) {
        emitNavigation(previousHref);
      }
      return result;
    };
    state.wrappers.replaceState = function biliReplaceState(
      stateValue,
      title,
      url
    ) {
      const previousHref = location.href;
      const nextUrl =
        state.config.settings.globalEnabled &&
        state.config.settings.privacy.urlCleaning &&
        url !== undefined
          ? cleanUrl(url)
          : url;
      const result = callHistoryOriginal("replaceState", this, [
        stateValue,
        title,
        nextUrl
      ]);
      if (
        state.config.settings.globalEnabled &&
        location.href !== previousHref
      ) {
        emitNavigation(previousHref);
      }
      return result;
    };
    state.wrappers.open = function biliOpen(url) {
      const args = [...arguments];
      if (
        state.config.settings.globalEnabled &&
        state.config.settings.privacy.urlCleaning &&
        url !== undefined
      ) {
        args[0] = cleanUrl(url);
      }
      return state.originals.open.apply(this, args);
    };
    state.wrappers.sendBeacon = function biliSendBeacon(url) {
      if (
        state.config.settings.globalEnabled &&
        state.config.settings.privacy.telemetryBlocking &&
        isBlockedEndpoint(url)
      ) {
        emit("BEACON_BLOCKED", { url: String(url).slice(0, 500) });
        return true;
      }
      return state.originals.sendBeacon.apply(this, arguments);
    };

    window.fetch = state.wrappers.fetch;
    history.pushState = state.wrappers.pushState;
    history.replaceState = state.wrappers.replaceState;
    window.open = state.wrappers.open;
    navigator.sendBeacon = state.wrappers.sendBeacon;
    installBootstrapPlayinfoHook();
    installXhrHooks();
    installClipboardHook();
    state.wrappers.popstate = () => {
      if (state.config.settings.globalEnabled) {
        emitNavigation();
      }
    };
    window.addEventListener("popstate", state.wrappers.popstate);
  }

  function restoreAssignedProperty(owner, key, ours, original, wasOwn) {
    if (owner[key] !== ours) {
      return;
    }
    if (wasOwn) {
      owner[key] = original;
      return;
    }
    try {
      delete owner[key];
    } catch {
      // Fall back to assignment below.
    }
    if (owner[key] !== original) {
      owner[key] = original;
    }
  }

  function restoreHooks() {
    if (!state.installed) {
      return;
    }
    const prototype = window.XMLHttpRequest?.prototype;
    const responseText = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "responseText")
      : null;
    const response = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "response")
      : null;
    const laterWrapperPresent = [
      [window.fetch, state.wrappers.fetch, state.originals.fetch],
      [history.pushState, state.wrappers.pushState, state.originals.pushState],
      [
        history.replaceState,
        state.wrappers.replaceState,
        state.originals.replaceState
      ],
      [window.open, state.wrappers.open, state.originals.open],
      [
        navigator.sendBeacon,
        state.wrappers.sendBeacon,
        state.originals.sendBeacon
      ],
      [prototype?.open, state.wrappers.xhrOpen, state.originals.xhrOpen],
      [prototype?.send, state.wrappers.xhrSend, state.originals.xhrSend],
      [
        responseText?.get,
        state.wrappers.responseTextGetter,
        state.originals.responseTextDescriptor?.get
      ],
      [
        response?.get,
        state.wrappers.responseGetter,
        state.originals.responseDescriptor?.get
      ]
    ].some(
      ([current, ours, original]) =>
        ours && current !== ours && current !== original
    );
    if (laterWrapperPresent) {
      return;
    }
    restoreAssignedProperty(
      window,
      "fetch",
      state.wrappers.fetch,
      state.originals.fetch,
      state.originals.ownership.fetch
    );
    restoreAssignedProperty(
      history,
      "pushState",
      state.wrappers.pushState,
      state.originals.pushState,
      state.originals.ownership.pushState
    );
    restoreAssignedProperty(
      history,
      "replaceState",
      state.wrappers.replaceState,
      state.originals.replaceState,
      state.originals.ownership.replaceState
    );
    restoreAssignedProperty(
      window,
      "open",
      state.wrappers.open,
      state.originals.open,
      state.originals.ownership.open
    );
    restoreAssignedProperty(
      navigator,
      "sendBeacon",
      state.wrappers.sendBeacon,
      state.originals.sendBeacon,
      state.originals.ownership.sendBeacon
    );
    if (
      state.originals.clipboardOwner &&
      state.originals.clipboardOwner.writeText === state.wrappers.clipboardWriteText
    ) {
      restoreAssignedProperty(
        state.originals.clipboardOwner,
        "writeText",
        state.wrappers.clipboardWriteText,
        state.originals.clipboardWriteText,
        state.originals.clipboardWriteTextOwn
      );
    }
    if (prototype) {
      if (prototype.open === state.wrappers.xhrOpen) {
        prototype.open = state.originals.xhrOpen;
      }
      if (prototype.send === state.wrappers.xhrSend) {
        prototype.send = state.originals.xhrSend;
      }
      if (responseText?.get === state.wrappers.responseTextGetter) {
        Object.defineProperty(
          prototype,
          "responseText",
          state.originals.responseTextDescriptor
        );
      }
      if (response?.get === state.wrappers.responseGetter) {
        Object.defineProperty(
          prototype,
          "response",
          state.originals.responseDescriptor
        );
      }
    }
    if (state.wrappers.popstate) {
      window.removeEventListener("popstate", state.wrappers.popstate);
    }
    restoreBootstrapPlayinfoHook();
    resetPlaybackRouting();
    state.installed = false;
    state.wrappers = {};
  }

  function applyConfig(config) {
    if (!config?.settings) {
      return;
    }
    const wasRoutingEnabled = Boolean(
      state.config.settings.globalEnabled &&
        state.config.settings.acceleration.enabled
    );
    const willRoute = Boolean(
      config.settings.globalEnabled &&
        config.settings.acceleration.enabled
    );
    if (!willRoute || !wasRoutingEnabled) {
      // Disabling and re-enabling are both generation boundaries. Page-local
      // routes and failures must not outlive the service-worker session reset.
      resetPlaybackRouting();
    }
    // Rewrite targets are re-validated here so that no upstream layer — rule
    // file, storage state, or a compromised channel — can steer media requests
    // outside the Bilibili media surface.
    const compatibleRoutes = {};
    for (const [key, values] of Object.entries(
      config.compatibleRoutes && typeof config.compatibleRoutes === "object"
        ? config.compatibleRoutes
        : {}
    ).slice(0, 64)) {
      const separator = key.indexOf("::");
      const configuredRouteKey =
        separator >= 0 ? key.slice(separator + 2) : key;
      const urls = unique(Array.isArray(values) ? values : [])
        .filter(
          (url) =>
            url.length <= 4096 &&
            isMediaUrl(url) &&
            mediaKey(url) === configuredRouteKey
        )
        .slice(0, 8);
      if (urls.length) {
        compatibleRoutes[key] = urls;
      }
    }
    config.compatibleRoutes = compatibleRoutes;
    state.config = config;
    const authoritativeBlockedRoutes = new Map();
    for (const [routeKey, hosts] of Object.entries(
      config.degradedRoutes && typeof config.degradedRoutes === "object"
        ? config.degradedRoutes
        : {}
    ).slice(0, 64)) {
      const blocked = new Set();
      for (const host of Array.isArray(hosts) ? hosts : []) {
        if (isAllowedMediaHostname(host)) {
          blocked.add(host);
        }
      }
      if (blocked.size) {
        authoritativeBlockedRoutes.set(routeKey, blocked);
      }
    }
    state.routeBlockedHosts = authoritativeBlockedRoutes;
    const authoritativeHalfOpenRoutes = new Map();
    for (const [routeKey, hosts] of Object.entries(
      config.halfOpenRoutes && typeof config.halfOpenRoutes === "object"
        ? config.halfOpenRoutes
        : {}
    ).slice(0, 64)) {
      const halfOpen = new Set();
      for (const host of Array.isArray(hosts) ? hosts : []) {
        if (isAllowedMediaHostname(host)) {
          halfOpen.add(host);
        }
      }
      if (halfOpen.size) {
        authoritativeHalfOpenRoutes.set(routeKey, halfOpen);
        const local = state.localRouteBlockedHosts.get(routeKey);
        for (const host of halfOpen) {
          local?.delete(host);
          state.hostFailures.delete(`${routeKey}\u0000${host}`);
        }
        if (local && !local.size) {
          state.localRouteBlockedHosts.delete(routeKey);
        }
      }
    }
    state.halfOpenRoutes = authoritativeHalfOpenRoutes;
    state.blockedRegexes = config.blockedHostPatterns
      .map((source) => {
        try {
          return new RegExp(source, "i");
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (!state.configReady) {
      state.configReady = true;
      resolveInitialConfig();
      emit("CONFIG_READY", {
        elapsedMs: Math.round(performance.now() - DOCUMENT_STARTED_AT)
      });
    }
    refreshBootstrapPlayinfo();
    for (const route of state.mediaRoutes.values()) {
      route.urls = unique([
        ...route.urls,
        ...(config.compatibleRoutes[
          routeIdentity(route.presentationId, route.routeKey)
        ] ?? []),
        ...(config.compatibleRoutes[route.routeKey] ?? [])
      ]);
    }
    triggerSafeXhrHandoffs();
    if (config.settings.globalEnabled) {
      installHooks();
      if (config.settings.privacy.urlCleaning) {
        const cleaned = cleanUrl(location.href);
        if (cleaned !== location.href) {
          state.originals.replaceState.call(history, history.state, "", cleaned);
        }
      }
    } else {
      restoreHooks();
    }
  }

  function acceptPrivateChannel(event) {
    const nonce = String(event.detail ?? "");
    if (
      state.privateInboundEvent ||
      !/^[a-f0-9]{32}$/.test(nonce)
    ) {
      return;
    }
    state.privateInboundEvent = `${CHANNEL}:private:${nonce}:in`;
    state.privateOutboundEvent = `${CHANNEL}:private:${nonce}:out`;
    document.addEventListener(state.privateInboundEvent, (privateEvent) => {
      try {
        const message = JSON.parse(String(privateEvent.detail ?? ""));
        if (message.type === "CONFIG") {
          applyConfig(message.payload);
        } else if (message.type === "LIFECYCLE") {
          state.lifecycleActive = message.payload?.active !== false;
        } else if (message.type === "ROUTE_POLICY_READY") {
          acknowledgePolicyReady(message.payload?.requestId);
        } else if (message.type === "ROUTE_NATIVE_BYPASS") {
          applyNativeRouteBypass(message.payload);
        }
      } catch {
        // Reject malformed private-channel messages.
      }
    });
    document.removeEventListener(INIT_EVENT, acceptPrivateChannel);
    emit("ACK");
  }

  document.addEventListener(INIT_EVENT, acceptPrivateChannel);

  installBootstrapPlayinfoHook();
  installHooks();
  document.dispatchEvent(new CustomEvent(READY_EVENT));
})();
