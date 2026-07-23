import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanUrl,
  hostnameMatches,
  isMediaResourceUrl,
  isAllowedMediaUrl,
  mediaResourceKey,
  mediaRouteKey,
  replaceHostname
} from "../../src/lib/url-utils.js";

const blocked = ["spm_id_from", "vd_source", "from"];

test("cleanUrl removes only blacklisted parameters", () => {
  const cleaned = cleanUrl(
    "https://www.bilibili.com/video/BV1?p=2&t=31&vd_source=secret&spm_id_from=333",
    blocked
  );
  const url = new URL(cleaned);
  assert.equal(url.searchParams.get("p"), "2");
  assert.equal(url.searchParams.get("t"), "31");
  assert.equal(url.searchParams.has("vd_source"), false);
  assert.equal(url.searchParams.has("spm_id_from"), false);
});

test("cleanUrl preserves query-relative navigation", () => {
  const cleaned = cleanUrl(
    "?p=3&vd_source=secret",
    blocked,
    "https://www.bilibili.com/video/BV1"
  );
  assert.equal(cleaned, "?p=3");
});

test("replaceHostname changes authority only", () => {
  const original =
    "https://upos-sz-mirrorcosov.bilivideo.com:8443/upgcxcode/a/b/video.m4s?deadline=9&gen=playurlv3";
  const rewritten = replaceHostname(
    original,
    "upos-sz-mirrorcos.bilivideo.com"
  );
  const before = new URL(original);
  const after = new URL(rewritten);
  assert.equal(after.hostname, "upos-sz-mirrorcos.bilivideo.com");
  assert.equal(after.port, "");
  assert.equal(after.protocol, before.protocol);
  assert.equal(after.pathname, before.pathname);
  assert.equal(after.search, before.search);
});

test("mediaResourceKey ignores host while retaining signed query", () => {
  assert.equal(
    mediaResourceKey(
      "https://a.bilivideo.com/path/video.m4s?deadline=1&uipk=2"
    ),
    "/path/video.m4s?deadline=1&uipk=2"
  );
});

test("route identity joins host-specific signatures and accepts legacy MP4", () => {
  assert.equal(
    mediaRouteKey(
      "https://a.bilivideo.com/path/video.m4s?upsig=one"
    ),
    mediaRouteKey(
      "https://b.akamaized.net/path/video.m4s?hdnts=two"
    )
  );
  assert.equal(
    isMediaResourceUrl(
      "https://a.bilivideo.com/path/legacy.mp4?deadline=1"
    ),
    true
  );
});

test("media URL policy is HTTPS-only and Akamai is allowlisted exactly", () => {
  assert.equal(
    isAllowedMediaUrl(
      "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?token=x"
    ),
    true
  );
  for (const rejected of [
    "http://a.bilivideo.com/path/video.m4s",
    "https://fixture:@a.bilivideo.com/path/video.m4s",
    "https://a.bilivideo.com/path/video.m4s#fragment",
    "https://bilivideo.com/path/video.m4s",
    "https://tenant.akamaized.net/path/video.m4s",
    "https://evil.example/path/video.m4s"
  ]) {
    assert.equal(isAllowedMediaUrl(rejected), false, rejected);
  }
});

test("hostnameMatches accepts the blocked host catalog syntax", () => {
  assert.equal(
    hostnameMatches("upos-sz-mirrorcosov.bilivideo.com", [
      "^upos-.*ov\\.bilivideo\\.com$"
    ]),
    true
  );
  assert.equal(
    hostnameMatches("upos-sz-mirrorcos.bilivideo.com", [
      "^upos-.*ov\\.bilivideo\\.com$"
    ]),
    false
  );
});
