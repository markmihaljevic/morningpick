import { fmpGet, fetchLatestBalanceSheet, type TickerData } from "./fmp";
import { getPeerGroup, dedupePeersByIdentity, looksScaffolded, type SelectedPeer } from "./peer-select";
import { logEvent } from "./db";
import {
  buildSnapshot,
  snapshotFromParts,
  type FiguresSnapshot,
} from "./figures";
import { getFilingFacts, STAGE_METRIC, PRODUCT_METRIC, type FilingFact } from "./filing-facts";
import { finishSentence } from "./text";

/**
 * The sector-aware "Valuation vs Peers" table, driven by John's
 * comp-metrics-by-industry file — the one-time sector reasoning the engine
 * LOOKS UP instead of re-deriving per idea. Rows carry company names and
 * stage tags; columns come from the subject's industry group; computed cells
 * use the SAME snapshot math and the SAME day's close for subject and peers;
 * filing facts come from company releases via the cached researcher, and
 * cells print n/a (not found) or n/m (not meaningful), never a guess.
 */

// Group machinery lives in lib/metric-groups.ts (figures.ts needs it too and
// must never import this module — cycle). Re-exported for existing callers.
import { METRICS, GROUPS, resolveMetricGroup, type GroupDef } from "./metric-groups";
export { resolveMetricGroup, type GroupResolution } from "./metric-groups";

export interface CompTableRow {
  name: string;
  ticker: string;
  /** Stage/product tag under the name — "producer · gold". */
  tag: string | null;
  /** Footnote marker, printed INLINE after the ticker — "(TBCG.L) †". */
  marker: string | null;
  self: boolean;
  cleanAnchor: boolean;
  cells: string[]; // aligned with CompTable.columns
}

export interface CompTable {
  groupKey: string;
  groupLabel: string;
  columns: { key: string; label: string }[];
  rows: CompTableRow[];
  /** Anchor summary for the writer — "AltynGold (ALTN.L) P/E 5.5x" lines. */
  cleanAnchorNote: string | null;
  /** Why each peer belongs — one judgment line per peer, printed under the table. */
  rationales: string[];
  /** Source labels for filing facts, rendered as table footnotes. */
  footnotes: string[];
  /** The block the writer and verifier both receive. */
  textForPrompt: string;
}

// Two different kinds of missing (John's rules): n/a = not found/disclosed,
// n/m = present but not meaningful (negative earnings, non-earner stage).
// Formatters return null for absent data; each cell decides which to print.
const N_A = "n/a";
const N_M = "n/m";

const fmtX = (v: number | null): string | null =>
  v !== null && v > 0 && v <= 500 ? `${v.toFixed(1)}x` : null;
const fmtPct = (v: number | null): string | null =>
  v !== null ? `${(v * 100).toFixed(1)}%` : null;
const fmtMoney = (v: number | null, cur: string): string | null => {
  if (v === null) return null;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}${cur}${(a / 1e9).toFixed(1)}B`;
  return `${sign}${cur}${(a / 1e6).toFixed(0)}M`;
};

/** Extra absolutes the table needs beyond the shared snapshot. */
interface RowData {
  ticker: string;
  name: string;
  self: boolean;
  s: FiguresSnapshot;
  ebit: number | null;
  revenue: number | null;
  netIncome: number | null;
  da: number | null;
  shares: number | null;
  rationale: string | null;
  facts: Map<string, FilingFact>;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Earnings-flavoured multiples that stage rules force to n/m for non-producers. */
const EARNINGS_MULTIPLES = new Set(["pe", "ev_ebitda", "ev_ebit", "p_ffo", "p_s", "ev_s"]);

function computedCell(key: string, r: RowData, nonEarner: boolean): string {
  if (nonEarner && EARNINGS_MULTIPLES.has(key)) return N_M;
  const s = r.s;
  switch (key) {
    case "pe":
      // n/m only when earnings are PRESENT and non-positive; absent → n/a.
      if (s.epsTTM !== null && s.epsTTM <= 0) return N_M;
      return fmtX(s.pe) ?? N_A;
    case "ev_ebitda":
      // EV present but multiple invalid → negative EBITDA (n/m); no EV → n/a.
      if (s.evEbitda !== null) return fmtX(s.evEbitda) ?? N_M;
      return s.enterpriseValue !== null ? N_M : N_A;
    case "ev_ebit":
      if (s.enterpriseValue === null || r.ebit === null) return N_A;
      return r.ebit > 0 ? (fmtX(s.enterpriseValue / r.ebit) ?? N_M) : N_M;
    case "p_tbv": {
      // Rule: 'neg' when tangible equity is negative — a real signal, not a gap.
      // Balance-sheet tangible book is the canonical test when present.
      if (s.tangibleBookAbs !== null && s.tangibleBookAbs <= 0) return "neg";
      if (s.tangibleBookAbs === null && s.tangibleBookPerShare !== null && s.tangibleBookPerShare <= 0)
        return "neg";
      // Rule: P/TBV can never be below P/B — if it is, the book data is bad.
      if (s.pTangibleBook !== null && s.pb !== null && s.pTangibleBook < s.pb * 0.95) return N_A;
      return fmtX(s.pTangibleBook) ?? N_A;
    }
    case "p_b":
      return fmtX(s.pb) ?? N_A;
    case "p_s":
      // De-minimis revenue → n/m per the metric rule; missing → n/a.
      if (s.revenuePerShareTTM !== null && s.revenuePerShareTTM <= 0) return N_M;
      return fmtX(s.ps) ?? N_A;
    case "ev_s":
      if (s.enterpriseValue === null || r.revenue === null) return N_A;
      return r.revenue > 0 ? (fmtX(s.enterpriseValue / r.revenue) ?? N_M) : N_M;
    case "fcf_yield": {
      if (s.fcfYield === null) return N_A;
      // Rule: FCF above EBITDA is almost always a data error. SAME-period
      // inputs only (TTM FCF vs TTM EBITDA) — mixing TTM cash flow with
      // annual revenue false-positives on fast growers (MMY doubled sales).
      if (
        s.fcfPerShare !== null &&
        r.shares !== null &&
        r.shares > 0 &&
        s.ebitdaTTM !== null &&
        s.ebitdaTTM > 0 &&
        s.fcfPerShare * r.shares > s.ebitdaTTM * 1.2
      ) {
        return N_A; // fails the FCF-vs-EBITDA sanity check — bad row data
      }
      return fmtPct(s.fcfYield) ?? N_A;
    }
    case "div_yield":
      // Absent dividend data is n/a — never a fabricated 0.0%. Negative is a
      // data error (n/m). TTM totals may include specials; footnoted globally.
      if (s.divYield === null) return N_A;
      if (s.divYield < 0) return N_M;
      return fmtPct(s.divYield) ?? N_A;
    case "rev_growth_3y":
      if (s.revenueCagr3y !== null) return fmtPct(s.revenueCagr3y) ?? N_A;
      return s.revenueGrowth !== null ? `${fmtPct(s.revenueGrowth)} (YoY)` : N_A;
    case "roe":
      return fmtPct(s.roe) ?? N_A;
    case "rote":
      return s.roe !== null &&
        s.bookValuePerShare !== null &&
        s.tangibleBookPerShare !== null &&
        s.tangibleBookPerShare > 0
        ? (fmtPct(s.roe * (s.bookValuePerShare / s.tangibleBookPerShare)) ?? N_A)
        : N_A;
    case "nd_ebitda":
      // "net cash" ONLY when net debt itself is provably negative; a negative
      // RATIO can also mean negative EBITDA on a levered name (n/m).
      if (s.netDebt !== null && s.netDebt < 0) return "net cash";
      if (s.netDebtToEbitda === null) return N_A;
      if (s.netDebtToEbitda < 0) return s.netDebt === null ? N_M : "net cash";
      return `${s.netDebtToEbitda.toFixed(1)}x`;
    case "net_cash":
      return s.netDebt !== null ? (fmtMoney(-s.netDebt, s.repCur) ?? N_A) : N_A;
    case "p_ffo": {
      const mcapRep = s.marketCapReported;
      if (mcapRep !== null && r.netIncome !== null && r.da !== null && r.netIncome + r.da > 0) {
        const v = fmtX(mcapRep / (r.netIncome + r.da));
        return v ? `${v}*` : N_M; // * = approx, footnoted
      }
      return N_A;
    }
    case "ltv":
      return N_A; // needs balance-sheet gross assets — filings territory, v1 prints n/a
    default:
      return N_A;
  }
}

/** Fetch a peer's snapshot parts (all day-cached, shared across subscribers). */
async function peerRowData(peer: SelectedPeer): Promise<RowData | null> {
  try {
    const symbol = { symbol: peer.ticker };
    const [profile, quote, rt, kt, bs, inc] = await Promise.all([
      fmpGet<Record<string, unknown>[]>("profile", symbol),
      fmpGet<Record<string, unknown>[]>("quote", symbol),
      fmpGet<Record<string, unknown>[]>("ratios-ttm", symbol),
      fmpGet<Record<string, unknown>[]>("key-metrics-ttm", symbol),
      fetchLatestBalanceSheet(peer.ticker),
      fmpGet<Record<string, unknown>[]>("income-statement", { ...symbol, limit: 4 }),
    ]);
    const incRows = (inc ?? []) as Record<string, unknown>[];
    const s = await snapshotFromParts({
      profile: profile?.[0] ?? {},
      quote: quote?.[0] ?? {},
      ratiosTTM: rt?.[0] ?? {},
      keyMetricsTTM: kt?.[0] ?? {},
      balanceSheet: bs as Record<string, unknown> | null,
      incomeStatements: incRows,
    });
    const name = String(profile?.[0]?.companyName ?? peer.name ?? peer.ticker);
    return {
      ticker: peer.ticker,
      name,
      self: false,
      s,
      ebit: num(incRows[0]?.ebit),
      revenue: num(incRows[0]?.revenue),
      netIncome: num(incRows[0]?.netIncome),
      da: num(incRows[0]?.depreciationAndAmortization),
      shares: num(incRows[0]?.weightedAverageShsOutDil) ?? num(incRows[0]?.weightedAverageShsOut),
      rationale: peer.rationale,
      facts: new Map(),
    };
  } catch (e) {
    console.error(`Peer row failed for ${peer.ticker} (dropped from table):`, e);
    return null;
  }
}

function stageOf(r: RowData): string | null {
  return r.facts.get(STAGE_METRIC)?.value ?? null;
}
function productOf(r: RowData): string | null {
  return r.facts.get(PRODUCT_METRIC)?.value ?? null;
}
function isNonEarner(r: RowData, hasStageRule: boolean): boolean {
  if (!hasStageRule) return false;
  const stage = (stageOf(r) ?? "").toLowerCase();
  return stage.includes("ramp") || stage.includes("develop") || stage.includes("pre-");
}

/**
 * Clean anchors, applied STRUCTURALLY only where the group gives us structure
 * (a stage rule): an anchor shares the subject's producing stage AND primary
 * product. Groups without a stage dimension get NO structural marks — their
 * clean_comp_rule is prose (match geography/model/route/...) that the writer
 * applies via the rule text passed alongside the table. Marking everything
 * clean would bless exactly the mis-anchors the rule exists to prevent.
 */
function isCleanAnchor(r: RowData, subject: RowData, group: GroupDef): boolean {
  if (r.self) return false;
  if (!group.stage_rule) return false;
  const stage = (stageOf(r) ?? "").toLowerCase();
  if (!stage.includes("produc")) return false;
  const p1 = (productOf(r) ?? "").toLowerCase();
  const p2 = (productOf(subject) ?? "").toLowerCase();
  if (p1 && p2 && p1 !== p2) {
    // "gold" vs "gold+copper" → not an anchor; single-token containment OK.
    const t1 = p1.split(/[+/,\s]+/).filter(Boolean).sort().join("+");
    const t2 = p2.split(/[+/,\s]+/).filter(Boolean).sort().join("+");
    if (t1 !== t2) return false;
  }
  return true;
}

export async function buildCompTable(args: {
  ticker: string;
  companyName?: string;
  data: TickerData;
  /** Detected investment holdco (July 17): the table leads with price to
   * PUBLISHED NAV per peer — industry mapping is too coarse to catch these. */
  holdco?: boolean;
}): Promise<CompTable | null> {
  try {
    const profile = (Array.isArray(args.data.profile) ? args.data.profile[0] : args.data.profile) as
      | { industry?: string; sector?: string; companyName?: string }
      | undefined;
    const resolution = args.holdco
      ? { key: "investment_holdco", group: GROUPS["investment_holdco"], via: "holdco-detection" as const }
      : resolveMetricGroup(profile?.industry, profile?.sector);
    if (resolution.via !== "industry" && resolution.via !== "holdco-detection" && profile?.industry) {
      // Per the file: log ANY unmapped industry (sector fallback included) so
      // the mapping can be extended, instead of silently defaulting.
      await logEvent("comp_group_unmapped", {
        payload: { ticker: args.ticker, industry: profile.industry, sector: profile?.sector, resolvedVia: resolution.via },
      });
    }
    const group = resolution.group;

    // Subject row from the note's own snapshot — one price epoch everywhere.
    const s = await buildSnapshot(args.data);
    const incRows = (Array.isArray(args.data.incomeStatement)
      ? args.data.incomeStatement
      : []) as Record<string, unknown>[];
    const subject: RowData = {
      ticker: args.ticker,
      name: args.companyName ?? profile?.companyName ?? args.ticker,
      self: true,
      s,
      ebit: num(incRows[0]?.ebit),
      revenue: num(incRows[0]?.revenue),
      netIncome: num(incRows[0]?.netIncome),
      da: num(incRows[0]?.depreciationAndAmortization),
      shares: num(incRows[0]?.weightedAverageShsOutDil) ?? num(incRows[0]?.weightedAverageShsOut),
      rationale: null,
      facts: new Map(),
    };

    // Peers are a JUDGMENT call (reasoning model, cached six months) — never
    // FMP's stock-peers screen, which benchmarked a Georgian retail bank
    // against a buyout firm and two asset managers. Fewer than two usable
    // peers → no table at all; correct-or-nothing.
    const fullProfile = profile as
      | { industry?: string; sector?: string; companyName?: string; description?: string }
      | undefined;
    const rawPeerGroup = await getPeerGroup({
      ticker: args.ticker,
      companyName: args.companyName ?? fullProfile?.companyName,
      industry: fullProfile?.industry,
      sector: fullProfile?.sector,
      description: fullProfile?.description,
    });
    // Print-side hygiene (July 18 P.S.): cached peer_groups rows live 183
    // days and predate the pick-time filters — a cached RNR set carried the
    // literal word "placeholder" and Everest twice (EG + legacy RE). Never
    // render scaffolding; one row per company identity.
    const peerGroup = await dedupePeersByIdentity(
      args.ticker,
      rawPeerGroup.filter((p) => {
        if (looksScaffolded(p)) {
          console.warn(`Cached peer ${p.ticker} (for ${args.ticker}) is scaffolding — not rendered.`);
          return false;
        }
        return true;
      }),
    );
    if (peerGroup.length < 2) {
      console.warn(`No usable peer group for ${args.ticker} — comp table skipped.`);
      return null;
    }
    const peerRows = (await Promise.all(peerGroup.slice(0, 6).map(peerRowData))).filter(
      (r): r is RowData => r !== null,
    );

    // Candidate columns: the group's list PLUS optional sourced-only extras
    // (P/NAV, EV/oz) — the latter render only when every row has a source.
    const candidateColumns = [
      ...group.columns,
      ...(group.optional_if_sourced ?? []).filter((c) => !group.columns.includes(c)),
    ];

    // Filing facts + stage/product tags for every row, cached and shared.
    const filingMetricKeys = candidateColumns.filter((c) => {
      const kind = METRICS[c]?.kind;
      return kind === "filing" || kind === "sourced_only";
    });
    const facts = await getFilingFacts({
      companies: [subject, ...peerRows].map((r) => ({ ticker: r.ticker, name: r.name })),
      metrics: filingMetricKeys.map((k) => ({
        key: k,
        label: METRICS[k].label,
        how: METRICS[k].how,
      })),
      stageRule: group.stage_rule,
      industry: profile?.industry,
    });
    for (const r of [subject, ...peerRows]) {
      r.facts = facts.get(r.ticker.toUpperCase()) ?? new Map();
    }

    // Rule 4 (July 17): a holdco table LEADS with P/Published NAV for every
    // peer. When the SUBJECT has a sourced NAV but a peer doesn't, the peer
    // is the wrong row — drop it (while ≥2 remain) BEFORE the every-row
    // sourced rule below can kill the mandated lead column instead.
    let workingPeers = peerRows;
    if (args.holdco) {
      const hasNav = (r: RowData) => {
        const f = r.facts.get("p_nav");
        return Boolean(f && f.value !== N_A && f.source);
      };
      if (hasNav(subject)) {
        const withNav = peerRows.filter(hasNav);
        if (withNav.length >= 2) workingPeers = withNav;
      }
    }

    // Column selection: candidates; sourced_only columns need a source on
    // EVERY row; then drop any column that would be n/a in every row (an
    // all-empty column is noise, whatever its kind); then the group's
    // tightness order caps the table at 6 metric columns (the file's "aim
    // for 4-6" — six renders fine at this layout's widths).
    const allRows = [subject, ...workingPeers];
    let columns = candidateColumns.filter((key) => METRICS[key]);
    columns = columns.filter((key) => {
      const def = METRICS[key];
      if (def.kind === "sourced_only") {
        return allRows.every((r) => {
          const f = r.facts.get(key);
          return f && f.value !== N_A && f.source;
        });
      }
      if (def.kind === "filing") {
        return allRows.some((r) => (r.facts.get(key)?.value ?? N_A) !== N_A);
      }
      return true;
    });
    // Pre-render pass to drop computed columns that are n/a in every row.
    const probeNonEarner = new Map(allRows.map((r) => [r.ticker, isNonEarner(r, Boolean(group.stage_rule))]));
    columns = columns.filter((key) => {
      const def = METRICS[key];
      if (def.kind === "filing" || def.kind === "sourced_only") return true;
      return allRows.some((r) => computedCell(key, r, probeNonEarner.get(r.ticker) ?? false) !== N_A);
    });
    const dropOrder = group.drop_first_if_tight ?? [];
    let di = 0;
    while (columns.length > 6 && di < dropOrder.length) {
      columns = columns.filter((c) => c !== dropOrder[di]);
      di++;
    }

    // Cells for one row against a given column set.
    const cellsFor = (r: RowData, cols: string[]): string[] => {
      const nonEarner = isNonEarner(r, Boolean(group.stage_rule));
      return cols.map((key) => {
        const def = METRICS[key];
        if (def.kind === "filing" || def.kind === "sourced_only") {
          return r.facts.get(key)?.value ?? N_A;
        }
        return computedCell(key, r, nonEarner);
      });
    };

    // NO n/a IN THE TABLE, EVER (John's rule 3): with real peers every column
    // applies to every row. A column the SUBJECT can't fill is the wrong
    // column — drop it. A peer that can't fill the remaining columns is the
    // wrong row — drop it, unless that leaves fewer than two peers, in which
    // case the offending columns go instead. Correct-or-nothing at the end.
    columns = columns.filter((key) => !cellsFor(subject, [key]).includes(N_A));
    let keptPeers = workingPeers.filter((r) => !cellsFor(r, columns).includes(N_A));
    if (keptPeers.length < 2) {
      const badCols = new Set<string>();
      for (const r of workingPeers) {
        columns.forEach((key) => {
          if (cellsFor(r, [key]).includes(N_A)) badCols.add(key);
        });
      }
      const reduced = columns.filter((key) => !badCols.has(key));
      if (reduced.length >= 2) {
        columns = reduced;
        keptPeers = workingPeers;
      }
    }
    // Rule 4 (July 17): a column that reads n/m for MULTIPLE rows carries no
    // comparison — drop it (two of five P/Es were n/m on the CGEO holdco
    // table). The lead column stays; it defines the group's frame.
    columns = columns.filter((key, idx) => {
      if (idx === 0) return true;
      const nmRows = [subject, ...keptPeers].filter((r) => cellsFor(r, [key])[0] === N_M).length;
      return nmRows < 2;
    });
    // Re-admission: a peer dropped ONLY for an n/a in a column the n/m rule
    // just removed is a fine row against the FINAL column set — re-select
    // from the full peer list so column drops never orphan good peers.
    keptPeers = workingPeers.filter((r) => !cellsFor(r, columns).includes(N_A));
    if (columns.length < 2 || keptPeers.length < 2) {
      console.warn(`Comp table for ${args.ticker}: no n/a-free shape found — skipped.`);
      return null;
    }

    // Inline footnote markers (rule 4): sit right after the ticker on the
    // company's own line — never on a line of their own. One marker per row
    // that carries footnoted filing facts (sources/estimates with basis).
    const MARKERS = ["†", "‡", "§", "¶", "#", "††", "‡‡"]; // ≥ max rows (subject + 6 peers) — no reuse
    const footnoteLines: string[] = [];
    const buildRow = (r: RowData): CompTableRow => {
      const rowNotes: string[] = [];
      for (const key of columns) {
        const def = METRICS[key];
        if (def.kind !== "filing" && def.kind !== "sourced_only") continue;
        const fact = r.facts.get(key);
        if (fact && fact.value !== N_A && fact.source) {
          rowNotes.push(`${def.label} ${fact.value}: ${fact.source}`);
        }
      }
      let marker: string | null = null;
      if (rowNotes.length > 0) {
        marker = MARKERS[Math.min(footnoteLines.length, MARKERS.length - 1)];
        footnoteLines.push(`${marker} ${r.name} (${r.ticker}) — ${rowNotes.join("; ")}`);
      }
      const stage = stageOf(r);
      const product = productOf(r);
      const tag = [stage, product].filter(Boolean).join(" · ") || null;
      return {
        name: r.name,
        ticker: r.ticker,
        tag,
        marker,
        self: r.self,
        cleanAnchor: isCleanAnchor(r, subject, group),
        cells: cellsFor(r, columns),
      };
    };
    const rows = [subject, ...keptPeers].map(buildRow);
    if (rows.length < 3) return null; // subject + <2 peers → too thin to be honest

    // Why each belongs — the judgment lines that print under the table.
    // Labels drop legal-form prefixes ("Joint Stock Company Kaspi.kz" → "Kaspi.kz").
    const rationaleLabel = (name: string) =>
      name
        .replace(/^(Joint\s+Stock\s+Company|Public\s+Joint\s+Stock\s+Company|JSC|PJSC|OJSC|AO|PT|AB)\s+/i, "")
        .split(/\s+/)
        .slice(0, 3)
        .join(" ")
        .replace(/[,.]$/, "");
    // finishSentence repairs rationales the old hard slice cached mid-word
    // ("nurture-and-") — peer_groups rows live 183 days, so print-time is the
    // only place that reliably covers the backlog.
    const rationales = keptPeers
      .filter((r): r is typeof r & { rationale: string } => Boolean(r.rationale))
      .map((r) => `${rationaleLabel(r.name)}: ${finishSentence(r.rationale)}`);

    // Anchor note for the writer: the multiples it may cite for re-rating.
    // Structural anchors exist only for stage-rule groups; everywhere else the
    // group's prose clean_comp_rule travels with the table for the writer to apply.
    const anchorRows = rows.filter((r) => r.cleanAnchor);
    const primaryMultipleKey = columns.find((k) => EARNINGS_MULTIPLES.has(k) || k === "p_tbv");
    let cleanAnchorNote: string | null = null;
    if (anchorRows.length > 0 && primaryMultipleKey) {
      const ci = columns.indexOf(primaryMultipleKey);
      const label = METRICS[primaryMultipleKey].label;
      const parts = anchorRows
        .map((r) => `${r.name} (${r.ticker}) ${label} ${r.cells[ci]}`)
        .filter((p) => !p.endsWith(N_M) && !p.endsWith(N_A));
      if (parts.length > 0) cleanAnchorNote = parts.join(", ");
    }

    const columnDefs = columns.map((key) => ({ key, label: METRICS[key].label }));
    const footnotes = [...footnoteLines].slice(0, 8);
    if (columns.includes("div_yield")) {
      footnotes.push("Div Yield is trailing-twelve-month and may include special dividends.");
    }
    if (columns.includes("p_ffo")) {
      footnotes.push("*P/FFO approximated as NI + D&A where the company does not report FFO.");
    }

    // The block writer AND verifier receive — same table, same epoch.
    const header = ["Company", ...columnDefs.map((c) => c.label)].join(" | ");
    const lines = rows.map((r) =>
      [
        `${r.name} (${r.ticker})${r.marker ? ` ${r.marker}` : ""}${r.self ? " [SUBJECT]" : ""}${r.tag ? ` [${r.tag}]` : ""}${r.cleanAnchor ? " [clean comp]" : ""}`,
        ...r.cells,
      ].join(" | "),
    );
    const anchorGuidance = group.stage_rule
      ? cleanAnchorNote
        ? `\nCLEAN RE-RATING ANCHORS: ${cleanAnchorNote}. When citing a peer multiple or range for the re-rating case, use ONLY these clean comps — never ramp-ups, developers, or different-product names, whose multiples say nothing about the subject's re-rating.`
        : `\nNO CLEAN RE-RATING ANCHORS in this peer set (no producing same-product peer with meaningful multiples) — do NOT cite a peer multiple range for the re-rating case.`
      : group.clean_comp_rule
        ? `\nCLEAN-COMP RULE for this sector: ${group.clean_comp_rule} Apply it before citing any peer multiple for the re-rating case; when a peer fails it, say so or leave that peer out of the range.`
        : "";
    const rationaleBlock =
      rationales.length > 0 ? `\nWHY EACH PEER BELONGS (judgment-picked and vetted; the rationales print under the table): NEVER argue in prose that a listed peer is not a real comparable — the table and the note must agree (a fact-checker flags the contradiction). Lean on the strongest comps and simply de-emphasize weaker ones.\n${rationales.map((r) => `- ${r}`).join("\n")}` : "";
    const textForPrompt = `<peer_comps note="Comp table (${group.label}) with JUDGMENT-PICKED peers, computed at TODAY's close from the same snapshot as every other figure — quote these verbatim. 'n/m' = not meaningful (negative/non-earner).">
${header}
${lines.join("\n")}${rationaleBlock}${anchorGuidance}
${footnoteLines.length > 0 ? footnoteLines.join("\n") : ""}
</peer_comps>`;

    return {
      groupKey: resolution.key,
      groupLabel: group.label,
      columns: columnDefs,
      rows,
      cleanAnchorNote,
      rationales,
      footnotes,
      textForPrompt,
    };
  } catch (e) {
    console.error(`Comp table failed for ${args.ticker} (one-pager ships without it):`, e);
    return null;
  }
}
