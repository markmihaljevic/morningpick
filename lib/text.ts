/** Tiny text hygiene helpers shared by storage and print layers. */

/**
 * Truncate at a word boundary (preferring a sentence end) instead of an
 * arbitrary character slice — a hard slice(0, 200) once cached a peer
 * rationale ending "nurture-and-" into a 183-day cache.
 */
export function trimAtBoundary(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentenceEnd > max * 0.5) return cut.slice(0, sentenceEnd + 1).trim();
  const wordEnd = cut.lastIndexOf(" ");
  return (wordEnd > 0 ? cut.slice(0, wordEnd) : cut).trim() + "…";
}

/**
 * Print-time repair for text the old hard slice(0, 200) cached mid-word.
 * ONLY text that carries the truncation signature — ends with a hyphen, or
 * sits at/near the old 200-char cap without terminal punctuation — is
 * repaired; a short rationale that simply lacks a full stop is left alone
 * (amputating its last word would damage good text to fix bad).
 */
export function finishSentence(s: string): string {
  const t = s.trim();
  if (/[.!?…]$/.test(t)) return t;
  const looksTruncated = /-$/.test(t) || t.length >= 195;
  if (!looksTruncated) return t;
  const sentenceEnd = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("? "));
  if (sentenceEnd > t.length * 0.4) return t.slice(0, sentenceEnd + 1).trim();
  return t.replace(/[\s-]+[^\s]*$/, "").trim() + "…";
}
