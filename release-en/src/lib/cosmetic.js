// Cosmetic filtering may only ever hide elements. A selector that could close
// the declaration block, open an at-rule, or reference an external URL would
// turn the hiding layer into an arbitrary-CSS injection channel (including
// attribute exfiltration via url()). Selectors are validated at build time and
// re-filtered at every runtime consumer.
// Keep in sync with the inline copy in src/content/bridge.js (non-module world).
const MAX_SELECTOR_LENGTH = 200;
const FORBIDDEN_SELECTOR_PATTERN = /[{}@\\<>;]|\/\*|url\s*\(|[\r\n]/i;

export function isSafeCosmeticSelector(selector) {
  return (
    typeof selector === "string" &&
    selector.trim().length > 0 &&
    selector.length <= MAX_SELECTOR_LENGTH &&
    !FORBIDDEN_SELECTOR_PATTERN.test(selector)
  );
}

export function sanitizeCosmeticSelectors(selectors) {
  return (Array.isArray(selectors) ? selectors : []).filter(
    isSafeCosmeticSelector
  );
}
