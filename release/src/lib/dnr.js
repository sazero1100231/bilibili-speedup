import {
  getHostname,
  hostnameMatches,
  isAllowedMediaHostname,
  isMediaResourceUrl,
  mediaRouteKey,
  uniqueStrings
} from "./url-utils.js";

const URL_CLEAN_RULE_IDS = [1001, 1002];
const MAX_DYNAMIC_RULES = 20;
const MAX_SESSION_MEDIA_RULES = 16;
const MAX_GLOBAL_SESSION_MEDIA_RULES = 96;
// Block and redirect rules must never touch traffic that other sites initiate;
// the extension's scope is Bilibili browsing only.
const BLOCK_INITIATOR_DOMAINS = ["bilibili.com", "b23.tv"];
const MEDIA_INITIATOR_DOMAINS = ["bilibili.com"];

function selectedEndpointRules(settings, endpoints) {
  if (!settings.privacy.telemetryBlocking) {
    return [];
  }
  return endpoints
    .filter((endpoint) => settings.privacy.endpointToggles[endpoint.id])
    .map((endpoint) => ({
      id: endpoint.dnr_id,
      priority: 2,
      action: { type: "block" },
      condition: {
        regexFilter: endpoint.regex_filter,
        initiatorDomains: BLOCK_INITIATOR_DOMAINS,
        resourceTypes: [
          "xmlhttprequest",
          "ping",
          "other",
          "image",
          "script",
          "media",
          "sub_frame"
        ]
      }
    }));
}

function trackingRules(settings, trackingParams) {
  if (!settings.privacy.urlCleaning || trackingParams.length === 0) {
    return [];
  }
  const queryTransform = { removeParams: trackingParams };
  return [
    {
      id: URL_CLEAN_RULE_IDS[0],
      priority: 1,
      action: { type: "redirect", redirect: { transform: { queryTransform } } },
      condition: {
        requestDomains: ["bilibili.com"],
        excludedRequestDomains: ["passport.bilibili.com"],
        resourceTypes: ["main_frame"]
      }
    },
    {
      id: URL_CLEAN_RULE_IDS[1],
      priority: 1,
      action: { type: "redirect", redirect: { transform: { queryTransform } } },
      condition: {
        requestDomains: ["b23.tv"],
        resourceTypes: ["main_frame"]
      }
    }
  ];
}

export function compileDynamicRules({
  settings,
  trackingParams,
  endpoints
}) {
  if (!settings.globalEnabled) {
    return [];
  }
  const rules = [
    ...trackingRules(settings, trackingParams),
    ...selectedEndpointRules(settings, endpoints)
  ];
  const ids = new Set(rules.map((rule) => rule.id));
  if (ids.size !== rules.length) {
    throw new Error("DNR rule IDs must be unique");
  }
  if (rules.length > MAX_DYNAMIC_RULES) {
    throw new Error(`DNR rule count ${rules.length} exceeds ${MAX_DYNAMIC_RULES}`);
  }
  return rules;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedRoute(route) {
  const urls = uniqueStrings(Array.isArray(route?.urls) ? route.urls : [])
    .filter((url) => url.length <= 4096 && isMediaResourceUrl(url));
  if (!urls.length) {
    return null;
  }
  const routeKey = mediaRouteKey(urls[0]);
  const sameRepresentation = urls.filter(
    (url) => mediaRouteKey(url) === routeKey
  );
  return sameRepresentation.length > 1
    ? {
        routeKey,
        stateKey: String(route?.stateKey ?? routeKey).slice(0, 1200),
        presentationId: String(route?.presentationId ?? "unassigned").slice(
          0,
          160
        ),
        urls: sameRepresentation
      }
    : null;
}

// Session rules are deliberately route-specific and tab-scoped. Redirecting
// to an exact target URL preserves the CDN's own signature; no query string is
// transplanted between unrelated signing schemes.
export function compileSessionMediaRules({
  tabId,
  routes,
  degradedRoutes,
  blockedHostPatterns = [],
  startId
}) {
  if (
    !Number.isInteger(tabId) ||
    tabId < 0 ||
    !Number.isInteger(startId) ||
    startId <= 0
  ) {
    throw new Error("Invalid tab-scoped DNR rule input");
  }
  const blockedByRoute = new Map();
  for (const [routeKey, hosts] of Object.entries(
    degradedRoutes && typeof degradedRoutes === "object"
      ? degradedRoutes
      : {}
  ).slice(0, 64)) {
    const blocked = new Set(
      uniqueStrings(Array.isArray(hosts) ? hosts : []).filter(
        isAllowedMediaHostname
      )
    );
    if (routeKey && blocked.size) {
      blockedByRoute.set(routeKey, blocked);
    }
  }
  const rules = [];
  const sourceKeys = new Set();
  for (const input of Array.isArray(routes) ? routes : []) {
    const route = normalizedRoute(input);
    if (!route) {
      continue;
    }
    const blocked =
      blockedByRoute.get(route.stateKey) ??
      blockedByRoute.get(route.routeKey);
    if (!blocked?.size) {
      continue;
    }
    const targetUrl = route.urls.find(
      (url) => {
        const host = getHostname(url);
        return (
          !blocked.has(host) &&
          !hostnameMatches(host, blockedHostPatterns)
        );
      }
    );
    if (!targetUrl) {
      continue;
    }
    for (const sourceUrl of route.urls) {
      const parsed = new URL(sourceUrl);
      if (!blocked.has(parsed.hostname) || sourceUrl === targetUrl) {
        continue;
      }
      const sourceKey = `${route.stateKey}\u0000${sourceUrl}`;
      if (sourceKeys.has(sourceKey)) {
        continue;
      }
      sourceKeys.add(sourceKey);
      rules.push({
        id: startId + rules.length,
        priority: 4,
        action: { type: "redirect", redirect: { url: targetUrl } },
        condition: {
          // Match the exact signed source URL. A path-wide rule could catch a
          // concurrent presentation that happens to reuse the same CDN path
          // with a different signature.
          regexFilter: `^${escapeRegex(sourceUrl)}$`,
          tabIds: [tabId],
          initiatorDomains: MEDIA_INITIATOR_DOMAINS,
          resourceTypes: ["media", "xmlhttprequest", "other"]
        }
      });
      if (rules.length >= MAX_SESSION_MEDIA_RULES) {
        return rules;
      }
    }
  }
  return rules;
}

export {
  MAX_DYNAMIC_RULES,
  MAX_GLOBAL_SESSION_MEDIA_RULES,
  MAX_SESSION_MEDIA_RULES
};
