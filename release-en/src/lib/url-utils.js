const BILIBILI_MEDIA_HOST_SUFFIXES = [
  ".bilivideo.com",
  ".bilivideo.cn"
];
const ALLOWED_AKAMAI_MEDIA_HOSTS = new Set([
  "upos-hz-mirrorakam.akamaized.net"
]);

export function cleanUrl(rawUrl, blockedParams, baseUrl) {
  if (rawUrl === null || rawUrl === undefined || rawUrl === "") {
    return rawUrl;
  }
  let url;
  try {
    url = new URL(String(rawUrl), baseUrl);
  } catch {
    return rawUrl;
  }
  let changed = false;
  for (const param of blockedParams) {
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param);
      changed = true;
    }
  }
  if (!changed) {
    return rawUrl;
  }
  const input = String(rawUrl);
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

export function replaceHostname(rawUrl, hostname) {
  const url = new URL(rawUrl);
  url.hostname = hostname;
  url.port = "";
  return url.href;
}

export function getHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isAllowedMediaHostname(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  return (
    BILIBILI_MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    ALLOWED_AKAMAI_MEDIA_HOSTS.has(host)
  );
}

export function isAllowedMediaUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      isAllowedMediaHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isMediaResourceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /\.(?:m4s|flv|mp4)$/i.test(url.pathname) && isAllowedMediaUrl(url.href);
  } catch {
    return false;
  }
}

export function mediaResourceKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

// A representation keeps the same path across Bilibili's signed base/backup
// URLs, while each CDN is free to use a different query signature. This key is
// therefore suitable for joining exact route alternatives without treating a
// host-specific signature as a different media representation.
export function mediaRouteKey(rawUrl) {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return "";
  }
}

export function hostnameMatches(hostname, regexSources) {
  return regexSources.some((source) => {
    try {
      return new RegExp(source, "i").test(hostname);
    } catch {
      return false;
    }
  });
}

export function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}
