import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import { config } from "./config";
import { db } from "./db";

/**
 * Filing facts for comp tables — the numbers that live in company releases,
 * not FMP fields: production guidance, AISC, CET1, backlog, AUM. Researched
 * once per (ticker, metric) with web search, cached in Postgres and shared by
 * every subscriber (John's rule: never re-research the same ticker per user
 * per day). "n/a" is a legitimate, cacheable answer — never a guess.
 */

export interface FilingFact {
  value: string; // display string, e.g. "75-85koz" — or "n/a"
  source: string | null; // short label, e.g. "FY26 guidance (Jan 2026 RNS)"
}

/** stage + product ride along with every lookup, keyed as pseudo-metrics. */
export const STAGE_METRIC = "stage";
export const PRODUCT_METRIC = "product";

const CACHE_TTL_DAYS = 60; // guidance changes on reporting cadence
const NA_TTL_DAYS = 14; // retry not-found sooner — disclosure may appear

export async function getFilingFacts(args: {
  companies: { ticker: string; name: string }[];
  /** Metric keys + display meaning, from the comp-metrics file. */
  metrics: { key: string; label: string; how: string }[];
  /** The group's stage rule, when it has one — stage/product tags wanted. */
  stageRule?: string;
  industry?: string;
}): Promise<Map<string, Map<string, FilingFact>>> {
  const out = new Map<string, Map<string, FilingFact>>();
  for (const c of args.companies) out.set(c.ticker.toUpperCase(), new Map());
  const wantedMetrics = [
    ...args.metrics.map((m) => m.key),
    ...(args.stageRule ? [STAGE_METRIC, PRODUCT_METRIC] : []),
  ];
  if (wantedMetrics.length === 0) return out;

  // 1) Cache first.
  const symbols = args.companies.map((c) => c.ticker.toUpperCase());
  try {
    const { data: cached } = await db()
      .from("filing_facts")
      .select("symbol, metric, value, source, updated_at")
      .in("symbol", symbols)
      .in("metric", wantedMetrics);
    const now = Date.now();
    for (const row of cached ?? []) {
      const ageDays = (now - new Date(row.updated_at).getTime()) / 86_400_000;
      const ttl = row.value === "n/a" ? NA_TTL_DAYS : CACHE_TTL_DAYS;
      if (ageDays > ttl) continue;
      out.get(row.symbol)?.set(row.metric, { value: row.value, source: row.source });
    }
  } catch (e) {
    console.error("Filing-facts cache read failed (researching fresh):", e);
  }

  // 2) Anything missing → one web-search call covering all gaps.
  const gaps: { ticker: string; name: string; metrics: string[] }[] = [];
  for (const c of args.companies) {
    const have = out.get(c.ticker.toUpperCase())!;
    const missing = wantedMetrics.filter((m) => !have.has(m));
    if (missing.length > 0) gaps.push({ ticker: c.ticker, name: c.name, metrics: missing });
  }
  if (gaps.length === 0) return out;

  // Cross-worker research claim (same pattern as the research-brief lock):
  // concurrent workers on the same subject must not both pay the web-search
  // call — and must not race divergent answers into the shared cache. The
  // loser waits for the winner, then re-reads. A lock older than 15 minutes
  // is an orphan (a killed worker) — take it over rather than losing the
  // day's facts to a ghost.
  const lockKey = `filing-facts:${symbols[0]}:${new Date().toISOString().slice(0, 10)}`;
  const { error: lockError } = await db()
    .from("fmp_cache")
    .insert({ cache_key: lockKey, payload: { at: new Date().toISOString() } });
  if (lockError) {
    let stale = false;
    try {
      const { data: lockRow } = await db()
        .from("fmp_cache")
        .select("payload")
        .eq("cache_key", lockKey)
        .maybeSingle();
      const at = (lockRow?.payload as { at?: string } | null)?.at;
      stale = !at || Date.now() - new Date(at).getTime() > 15 * 60_000;
      if (stale) {
        await db()
          .from("fmp_cache")
          .update({ payload: { at: new Date().toISOString() } })
          .eq("cache_key", lockKey);
      }
    } catch {
      /* treat as live lock */
    }
    if (!stale) {
      await new Promise((r) => setTimeout(r, 25_000));
      try {
        const { data: retry } = await db()
          .from("filing_facts")
          .select("symbol, metric, value, source")
          .in("symbol", symbols)
          .in("metric", wantedMetrics);
        for (const row of retry ?? []) {
          out.get(row.symbol)?.set(row.metric, { value: row.value, source: row.source });
        }
      } catch {
        /* fall through with whatever we have */
      }
      return out;
    }
    // stale lock taken over — fall through to research
  }

  try {
    const researched = await researchFacts(gaps, args.metrics, args.stageRule, args.industry);
    const rows: {
      symbol: string;
      metric: string;
      value: string;
      source: string | null;
      updated_at: string;
    }[] = [];
    const now = new Date().toISOString();
    for (const [ticker, facts] of researched) {
      const have = out.get(ticker);
      if (!have) continue;
      for (const [metric, fact] of facts) {
        if (!wantedMetrics.includes(metric)) continue;
        have.set(metric, fact);
        rows.push({ symbol: ticker, metric, value: fact.value, source: fact.source, updated_at: now });
      }
    }
    if (rows.length > 0) {
      const { error } = await db().from("filing_facts").upsert(rows, { onConflict: "symbol,metric" });
      if (error) console.error("filing_facts upsert failed (next note re-researches):", error.message);
    }
  } catch (e) {
    // Fail open: the table ships with "n/a" filing cells rather than blocking.
    console.error("Filing-facts research failed (cells print n/a):", e);
  }
  return out;
}

const FACTS_SYSTEM = `You research OPERATIONAL FILING FACTS for a stock comp table — figures from company releases (guidance statements, RNS/press releases, results presentations, regulatory reporting) that financial-data APIs do not carry. You will get a list of companies and the exact metrics wanted for each.

RULES:
- Current-year GUIDANCE is preferred; label it (e.g. "FY26 guidance"). Latest full-year ACTUAL is the fallback, labeled (e.g. "FY25 actual").
- Value strings stay short and table-ready: "75-85koz", "$1,000-1,200", "14.2%", "£1.1bn". Ranges kept as ranges. No sentences.
- The table does not print "n/a" — work down this ladder before giving up:
  1. The exact metric from the company's own reporting.
  2. The company's CLOSEST PUBLISHED EQUIVALENT, with the basis in the source label (e.g. a Kazakh bank publishes k1, the NBK-basis CET1 equivalent: value "21.0%", source "k1 (NBK basis), 1Q26 — local CET1 equivalent").
  3. A defensible PROXY computed from the company's own filings, labeled as an estimate with its basis (e.g. "Basel III Tier 1 as CET1 proxy — no AT1 instruments outstanding, 1Q26 interims").
  "n/a" only when all three fail — that usually means the metric cannot exist for this company at all, which the caller treats as a wrong row or column.
- NEVER borrow a figure from a different company, NEVER invent one. An estimate must trace to the company's own published numbers, and its source label must say the basis.
- Every non-n/a value carries a short source label: what document/period it came from.
- If asked for stage/product: stage per the given rule (e.g. producer / ramp-up / developer), product = the company's primary commodity or business line in 1-3 words (e.g. "gold", "gold+copper", "tanker shipping").
- Output ONLY a fenced JSON block:
\`\`\`json
{"companies":[{"ticker":"THX.L","stage":"producer","product":"gold","facts":{"prod_koz":{"value":"75-85koz","source":"FY26 guidance (Jan 2026)"},"aisc_oz":{"value":"$1,000-1,200","source":"FY26 guidance"}}}]}
\`\`\``;

async function researchFacts(
  gaps: { ticker: string; name: string; metrics: string[] }[],
  metricSpecs: { key: string; label: string; how: string }[],
  stageRule?: string,
  industry?: string,
): Promise<Map<string, Map<string, FilingFact>>> {
  const cfg = config();
  const specLines = metricSpecs.map((m) => `- ${m.key}: ${m.label} — ${m.how}`).join("\n");
  const askLines = gaps
    .map((g) => `- ${g.name} (${g.ticker}): ${g.metrics.join(", ")}`)
    .join("\n");

  // Hard-capped: this call sits on the delivery critical path. Six searches
  // and two continuations cover a peer set; a 10-minute research spiral does
  // not (observed once — the killed worker orphaned the day lock).
  const baseRequest = {
    model: cfg.FEEDBACK_MODEL,
    max_tokens: 6000,
    output_config: { effort: "low" as const },
    system: FACTS_SYSTEM,
    tools: [
      {
        type: "web_search_20260209" as const,
        name: "web_search" as const,
        max_uses: Math.min(6, gaps.length * 2),
      },
    ],
  };
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Today: ${new Date().toISOString().slice(0, 10)}${industry ? ` · Industry: ${industry}` : ""}\n\n` +
        `Metric definitions:\n${specLines}\n\n` +
        (stageRule ? `Stage rule: ${stageRule}\n\n` : "") +
        `Find these (metric keys per company; also stage+product for each${stageRule ? "" : " if meaningful"}):\n${askLines}`,
    },
  ];

  let response = await anthropic().messages.stream({ ...baseRequest, messages }).finalMessage();
  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < 2) {
    messages.push({ role: "assistant", content: response.content });
    response = await anthropic().messages.stream({ ...baseRequest, messages }).finalMessage();
    continuations++;
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) throw new Error("Filing-facts response had no JSON block.");
  const parsed = JSON.parse(jsonMatch[1]) as {
    companies?: {
      ticker?: string;
      stage?: string;
      product?: string;
      facts?: Record<string, { value?: unknown; source?: unknown }>;
    }[];
  };

  const out = new Map<string, Map<string, FilingFact>>();
  for (const c of parsed.companies ?? []) {
    if (!c.ticker) continue;
    const m = new Map<string, FilingFact>();
    if (c.stage) m.set(STAGE_METRIC, { value: String(c.stage).slice(0, 24), source: null });
    if (c.product) m.set(PRODUCT_METRIC, { value: String(c.product).slice(0, 24), source: null });
    for (const [key, f] of Object.entries(c.facts ?? {})) {
      const value = String(f?.value ?? "n/a").slice(0, 40) || "n/a";
      const source = f?.source ? String(f.source).slice(0, 80) : null;
      m.set(key, { value, source });
    }
    out.set(c.ticker.toUpperCase(), m);
  }
  return out;
}
