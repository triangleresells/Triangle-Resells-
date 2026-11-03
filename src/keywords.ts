import type { KeywordRule } from "./config.js";

/**
 * Finds a keyword rule in a comment or DM. Matches the keyword as a whole word,
 * case-insensitive, so "PRICE?" and "price pls" match but "priceless" doesn't.
 */
export function matchKeyword(text: string, rules: KeywordRule[]): KeywordRule | undefined {
  const normalized = text.toUpperCase();
  return rules.find((r) => {
    const kw = r.keyword.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Z0-9])${kw}([^A-Z0-9]|$)`).test(normalized);
  });
}

/** True when a DM is basically just the keyword (e.g. "PRICE" or "price!"), not a full question. */
export function isBareKeyword(text: string, rule: KeywordRule): boolean {
  return text.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") === rule.keyword.toUpperCase();
}
