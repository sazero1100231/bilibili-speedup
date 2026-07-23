import assert from "node:assert/strict";
import test from "node:test";
import {
  contentIdentityFromUrl,
  evaluateLiveContentMatrix,
  normalizeLiveTargets
} from "../support/live-stream-matrix.js";

test("live target matrix accepts explicit UGC, PGC, bangumi and legacy scopes", () => {
  const targets = normalizeLiveTargets([
    {
      id: "ugc-public",
      url: "https://www.bilibili.com/video/BV0000000001/",
      kind: "ugc",
      expectedTransport: "dash"
    },
    {
      id: "pgc-member",
      url: "https://www.bilibili.com/video/BV0000000002/",
      kind: "pgc",
      requiresAuthentication: true
    },
    {
      id: "bangumi-episode",
      url: "https://www.bilibili.com/bangumi/play/ep0",
      kind: "bangumi",
      requiresAuthentication: true
    },
    {
      id: "legacy-fixture",
      url: "https://www.bilibili.com/video/BV0000000003/",
      kind: "legacy"
    }
  ]);
  assert.deepEqual(
    targets.map((target) => [
      target.id,
      target.kind,
      target.expectedTransport,
      target.requiresAuthentication
    ]),
    [
      ["ugc-public", "ugc", "dash", false],
      ["pgc-member", "pgc", "any", true],
      ["bangumi-episode", "bangumi", "any", true],
      ["legacy-fixture", "legacy", "legacy", false]
    ]
  );
  assert.equal(
    contentIdentityFromUrl(targets[2].url).bangumiId,
    "ep0"
  );
});

test("live target matrix rejects external, credentialed, fragmented and unknown pages", () => {
  for (const url of [
    "https://example.com/video/BV0000000001/",
    "http://www.bilibili.com/video/BV0000000001/",
    "https://fixture:@www.bilibili.com/video/BV0000000001/",
    "https://www.bilibili.com/video/BV0000000001/#fragment",
    "https://www.bilibili.com/"
  ]) {
    assert.throws(() => normalizeLiveTargets([{ url }]), /target URL/);
  }
});

test("content matrix fails closed when auth or the declared transport is absent", () => {
  const targets = normalizeLiveTargets([
    {
      id: "pgc",
      url: "https://www.bilibili.com/video/BV0000000001/",
      kind: "pgc",
      requiresAuthentication: true,
      expectedTransport: "dash"
    },
    {
      id: "legacy",
      url: "https://www.bilibili.com/video/BV0000000003/",
      kind: "legacy"
    }
  ]);
  const result = evaluateLiveContentMatrix({
    targets,
    visits: [
      { targetId: "pgc", authenticated: false },
      { targetId: "legacy", authenticated: true }
    ],
    samples: [
      {
        targetId: "pgc",
        video: { duration: 60, readyState: 4, currentTime: 5 }
      },
      {
        targetId: "legacy",
        video: { duration: 60, readyState: 4, currentTime: 5 }
      }
    ],
    mediaRequests: [
      {
        targetId: "pgc",
        url: "https://a.bilivideo.com/path/video.m4s"
      },
      {
        targetId: "legacy",
        url: "https://a.bilivideo.com/path/video.m4s"
      }
    ]
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.failedRequiredTargets, ["pgc", "legacy"]);
  assert.deepEqual(result.missingRequiredKinds, ["legacy", "pgc"]);
  assert.equal(
    result.outcomes.find((outcome) => outcome.id === "pgc")
      .authenticationPassed,
    false
  );
  assert.equal(
    result.outcomes.find((outcome) => outcome.id === "legacy")
      .transportPassed,
    false
  );
});

test("content matrix passes only after every required scope is playable and proven", () => {
  const targets = normalizeLiveTargets([
    {
      id: "pgc",
      url: "https://www.bilibili.com/video/BV0000000001/",
      kind: "pgc",
      requiresAuthentication: true,
      expectedTransport: "dash"
    },
    {
      id: "legacy",
      url: "https://www.bilibili.com/video/BV0000000003/",
      kind: "legacy"
    }
  ]);
  const result = evaluateLiveContentMatrix({
    targets,
    visits: [
      { targetId: "pgc", authenticated: true },
      { targetId: "legacy", authenticated: true }
    ],
    samples: targets.map((target) => ({
      targetId: target.id,
      video: { duration: 60, readyState: 4, currentTime: 5 }
    })),
    mediaRequests: [
      {
        targetId: "pgc",
        url: "https://a.bilivideo.com/path/video.m4s"
      },
      {
        targetId: "legacy",
        url: "https://a.bilivideo.com/path/video.mp4"
      }
    ]
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.missingRequiredKinds, []);
  assert.deepEqual(result.failedRequiredTargets, []);
});
