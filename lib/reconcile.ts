import type { FiguresSnapshot } from "./figures";

/**
 * The pre-send reconciliation gate (John's July 18 rule 4): price divided by
 * every printed per-share book figure must equal the printed multiple within
 * rounding, any conviction printed anywhere must equal the desk's one
 * number, and self-corrected contradictions are build failures, not prose
 * (rule 5). Deterministic, scoped TIGHTLY — the double-check proved a naive
 * version flags prompt-MANDATED content (peer multiples, re-rating targets,
 * corrected history), and a false positive here blocks a send.
 */

// A sentence anchored to the past is history the prompts REQUIRE the writer
// to reconcile ("Thursday's note said 1.8x") — never a live claim.
const PAST_MARKER =
  /\b(said|was|were|had|cited|previously|at the time|back (in|then)|last (week|month|year)|on (monday|tuesday|wednesday|thursday|friday)|thursday's|monday's|in (january|february|march|april|may|june|july|august|september|october|november|december)|in (19|20)\d\d)\b/i;

// Peer/relative context — peer multiples come from <peer_comps> and are not
// the subject's; re-rating targets are scenario language the writer prompt
// explicitly allows ("re-rating from 0.71x to 1.0x book").
// NOTE: deliberately does NOT include "trades at" — the subject's own claims
// use that phrasing ("trades at 0.84x tangible book" was the shipped bug).
const RELATIVE_CONTEXT =
  /\b(peer|peers|versus|vs\.?|against|compare[ds]?|sector|median|average|re-?rat(e|ing)|toward|target)\b/i;

// Book-context words for the dollars-per-share check; the exclusion list
// keeps EPS, dividends, price targets, NAV, and cash-flow per-share out.
const BOOK_CONTEXT = /\b(tangible|book|equity|TBV|TCE)\b/i;
const NON_BOOK_PER_SHARE = /\b(EPS|earn|earnings|dividend|payout|target|NAV|FCF|free cash|cash flow|revenue|sales|premium)\b/i;

const roundingTolerance = (printed: number): number => Math.max(0.02, Math.abs(printed) * 0.03);

export interface ReconcileInputs {
  /** Price in REPORTED currency (priceRep basis — the same basis as the
   * snapshot multiples; the listing price on GBp names is in pence and would
   * be off by ~100x). Null → per-share/multiple checks are skipped. */
  priceReported: number | null;
  /** Snapshot per-share values in reported currency (canonical + labeled
   * preferred-in variant where it exists). */
  bookPerShare: number | null;
  tangibleBookPerShare: number | null;
  tangibleBookPerShareInclPref: number | null;
  pb: number | null;
  pTangibleBook: number | null;
  pTangibleBookInclPref: number | null;
  /** The desk's ONE conviction (assessor). Null → conviction check skipped
   * (reviews, followups, forced demos have no assessor number). */
  conviction: number | null;
  /** Multiples quoted in the peer-comps block — whitelisted verbatim. */
  peerCompsText?: string | null;
}

export function snapshotReconcileInputs(
  s: FiguresSnapshot,
  conviction: number | null,
  peerCompsText?: string | null,
): ReconcileInputs {
  // priceRep = per-share × multiple by construction — recover it from the
  // pair rather than re-deriving FX here.
  const priceReported =
    s.tangibleBookPerShare !== null && s.pTangibleBook !== null
      ? s.tangibleBookPerShare * s.pTangibleBook
      : s.bookValuePerShare !== null && s.pb !== null
        ? s.bookValuePerShare * s.pb
        : null;
  return {
    priceReported,
    bookPerShare: s.bookValuePerShare,
    tangibleBookPerShare: s.tangibleBookPerShare,
    tangibleBookPerShareInclPref:
      priceReported !== null && s.pTangibleBookInclPref !== null && s.pTangibleBookInclPref > 0
        ? priceReported / s.pTangibleBookInclPref
        : null,
    pb: s.pb,
    pTangibleBook: s.pTangibleBook,
    pTangibleBookInclPref: s.pTangibleBookInclPref,
    conviction,
    peerCompsText,
  };
}

/**
 * Rule 4: reconciliation issues in a text. Sentence-scoped; every check
 * skips past-anchored and peer/relative-context sentences.
 */
export function reconciliationIssues(text: string, inputs: ReconcileInputs): string[] {
  const issues: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  const knownPerShare = [
    inputs.bookPerShare,
    inputs.tangibleBookPerShare,
    inputs.tangibleBookPerShareInclPref,
  ].filter((v): v is number => v !== null && v > 0);
  const knownMultiples = [inputs.pb, inputs.pTangibleBook, inputs.pTangibleBookInclPref].filter(
    (v): v is number => v !== null && v > 0,
  );
  const peerMultiples = new Set(
    [...(inputs.peerCompsText ?? "").matchAll(/(\d+(?:\.\d+)?)x/gi)].map((m) => m[1]),
  );

  for (const sentence of sentences) {
    if (PAST_MARKER.test(sentence)) continue;

    // (a) dollars-per-share figures in BOOK context must match a snapshot
    // per-share value — the $383.51 class.
    if (BOOK_CONTEXT.test(sentence) && !NON_BOOK_PER_SHARE.test(sentence) && knownPerShare.length > 0) {
      for (const m of sentence.matchAll(/[$£€]\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:\/|a |per )share|\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:\/|a |per )share/gi)) {
        const raw = (m[1] ?? m[2] ?? "").replace(/,/g, "");
        const v = parseFloat(raw);
        if (!Number.isFinite(v) || v <= 0) continue;
        const matches = knownPerShare.some((k) => Math.abs(v - k) <= Math.max(1, k * 0.03));
        if (!matches) {
          issues.push(
            `Per-share book figure "${m[0].trim()}" matches NO computed equity base (book/share ${knownPerShare
              .map((k) => k.toFixed(0))
              .join(", ")}). Recompute from the equity snapshot — do not narrate around it.`,
          );
        }
      }
    }

    // (b) book multiples must equal price / per-share within rounding — the
    // "1.5x tangible book ... $383.51 against $323" class. Peer multiples and
    // re-rating language are exempt; round targets stay exempt via context.
    if (BOOK_CONTEXT.test(sentence) && !RELATIVE_CONTEXT.test(sentence)) {
      for (const m of sentence.matchAll(/(\d+(?:\.\d+)?)x/gi)) {
        const printed = parseFloat(m[1]);
        if (!Number.isFinite(printed) || printed <= 0) continue;
        if (peerMultiples.has(m[1])) continue;
        if (knownMultiples.length === 0) continue;
        const matches = knownMultiples.some((k) => Math.abs(printed - k) <= roundingTolerance(printed));
        if (!matches) {
          issues.push(
            `Book multiple "${m[0]}" does not reconcile to price ÷ any computed equity base (computed: ${knownMultiples
              .map((k) => `${k.toFixed(2)}x`)
              .join(", ")}). Recompute — the multiple and the per-share must come from the same snapshot.`,
          );
        }
      }
    }
  }

  // (c) one conviction, everywhere it prints.
  if (inputs.conviction !== null) {
    for (const m of text.matchAll(/\b(\d{1,2})\s?\/\s?10\b/g)) {
      const v = parseInt(m[1], 10);
      if (v >= 1 && v <= 10 && v !== inputs.conviction) {
        issues.push(
          `Conviction "${m[0]}" contradicts the desk's ${inputs.conviction}/10 — one number rides everywhere (email, memo, report).`,
        );
      }
    }
  }

  return issues;
}

/**
 * Rule 5 — quarantine, not narration: a draft that notices its own
 * contradiction mid-sentence ("that number is actually above the stock, so I
 * mean…") is a build failure. The response is recompute, never rephrase.
 */
export function narrationIssues(text: string): string[] {
  const issues: string[] = [];
  const patterns = [
    /\bis actually (above|below) the (stock|price|share price)\b/i,
    /\bactually (above|below) the (stock|price)\b/i,
    /\bso (I|we) (actually )?mean\b/i,
    /\bwhich is actually\b[^.\n]{0,40}\b(above|below|higher|lower)\b/i,
    /\bthat number is (wrong|off|actually)\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      issues.push(
        `Self-corrected contradiction on the page ("${m[0]}"): a contradiction the writer notices mid-sentence is a build failure — recompute the figure from the equity snapshot instead of narrating around it.`,
      );
    }
  }
  return issues;
}
