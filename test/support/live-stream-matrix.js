const TARGET_KINDS = new Set(["ugc", "pgc", "bangumi", "legacy"]);
const EXPECTED_TRANSPORTS = new Set(["any", "dash", "legacy"]);

export function contentIdentityFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const bvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/i)?.[1] ?? "";
    const bangumiId =
      url.pathname.match(/\/bangumi\/play\/((?:ep|ss|md)\d+)/i)?.[1] ?? "";
    return {
      bvid,
      bangumiId,
      contentId: bvid || bangumiId
    };
  } catch {
    return { bvid: "", bangumiId: "", contentId: "" };
  }
}
function normalizedPageUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.bilibili.com" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(`Unsafe Bilibili live target URL: ${rawUrl}`);
  }
  const identity = contentIdentityFromUrl(url.href);
  if (!identity.contentId) {
    throw new Error(`Unsupported Bilibili live target URL: ${rawUrl}`);
  }
  return url.href;
}

function safeTargetId(rawId, fallback) {
  const value = String(rawId ?? fallback).trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(value)) {
    throw new Error(`Invalid live target id: ${value}`);
  }
  return value;
}

export function normalizeLiveTarget(rawTarget, index = 0) {
  const input =
    typeof rawTarget === "string" ? { url: rawTarget } : rawTarget ?? {};
  const url = normalizedPageUrl(input.url);
  const identity = contentIdentityFromUrl(url);
  const kind = String(
    input.kind ?? (identity.bangumiId ? "bangumi" : "ugc")
  ).toLowerCase();
  if (!TARGET_KINDS.has(kind)) {
    throw new Error(`Unsupported live target kind: ${kind}`);
  }
  const expectedTransport = String(
    input.expectedTransport ?? (kind === "legacy" ? "legacy" : "any")
  ).toLowerCase();
  if (!EXPECTED_TRANSPORTS.has(expectedTransport)) {
    throw new Error(
      `Unsupported expected transport for ${input.id ?? url}: ${expectedTransport}`
    );
  }
  return {
    id: safeTargetId(input.id, identity.contentId || `target-${index + 1}`),
    url,
    kind,
    expectedTransport,
    requiresAuthentication: Boolean(input.requiresAuthentication),
    required: input.required !== false,
    ...identity
  };
}

export function normalizeLiveTargets(rawTargets, maximum = 50) {
  if (!Array.isArray(rawTargets)) {
    throw new Error("Live target matrix must be a JSON array.");
  }
  const targets = rawTargets
    .slice(0, maximum)
    .map((target, index) => normalizeLiveTarget(target, index));
  if (!targets.length) {
    throw new Error("Live target matrix is empty.");
  }
  const ids = new Set();
  for (const target of targets) {
    if (ids.has(target.id)) {
      throw new Error(`Duplicate live target id: ${target.id}`);
    }
    ids.add(target.id);
  }
  return targets;
}

function mediaTransport(request) {
  try {
    const pathname = new URL(request.url).pathname;
    if (/\.m4s$/i.test(pathname)) {
      return "dash";
    }
    if (/\.(?:mp4|flv)$/i.test(pathname)) {
      return "legacy";
    }
  } catch {
    // A malformed request cannot prove either transport.
  }
  return "";
}

export function evaluateLiveContentMatrix({
  targets,
  visits,
  samples,
  mediaRequests,
  requiredKinds = []
}) {
  const outcomes = targets.map((target) => {
    const targetVisits = visits.filter((visit) => visit.targetId === target.id);
    const targetSamples = samples.filter(
      (sample) => sample.targetId === target.id
    );
    const targetRequests = mediaRequests.filter(
      (request) => request.targetId === target.id
    );
    const playable = targetSamples.some(
      (sample) =>
        Number(sample.video?.duration) > 0 &&
        (Number(sample.video?.readyState) >= 2 ||
          Number(sample.video?.currentTime) > 0)
    );
    const transports = [
      ...new Set(targetRequests.map(mediaTransport).filter(Boolean))
    ].sort();
    const transportPassed =
      target.expectedTransport === "any" ||
      transports.includes(target.expectedTransport);
    const authenticationObserved = targetVisits.some(
      (visit) => visit.authenticated === true
    );
    const authenticationPassed =
      !target.requiresAuthentication || authenticationObserved;
    return {
      id: target.id,
      kind: target.kind,
      expectedTransport: target.expectedTransport,
      requiresAuthentication: target.requiresAuthentication,
      visits: targetVisits.length,
      playable,
      transports,
      mediaRequests: targetRequests.length,
      authenticationObserved,
      transportPassed,
      authenticationPassed,
      passed: playable && transportPassed && authenticationPassed
    };
  });

  const requiredKindSet = new Set(
    requiredKinds.map((kind) => String(kind).toLowerCase()).filter(Boolean)
  );
  for (const target of targets) {
    if (target.required) {
      requiredKindSet.add(target.kind);
    }
  }
  const requiredKindResults = [...requiredKindSet].sort().map((kind) => {
    const candidates = outcomes.filter((outcome) => outcome.kind === kind);
    return {
      kind,
      targets: candidates.length,
      passedTargets: candidates.filter((outcome) => outcome.passed).length,
      passed: candidates.some((outcome) => outcome.passed)
    };
  });
  const requiredTargetFailures = outcomes.filter(
    (outcome) =>
      targets.find((target) => target.id === outcome.id)?.required &&
      !outcome.passed
  );
  const missingRequiredKinds = requiredKindResults
    .filter((result) => !result.passed)
    .map((result) => result.kind);

  return {
    outcomes,
    requiredKinds: requiredKindResults,
    missingRequiredKinds,
    failedRequiredTargets: requiredTargetFailures.map((outcome) => outcome.id),
    passed:
      missingRequiredKinds.length === 0 && requiredTargetFailures.length === 0
  };
}
