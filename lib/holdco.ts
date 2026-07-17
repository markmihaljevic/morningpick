import { anthropic } from "./anthropic";
import { config } from "./config";
import { db } from "./db";
import { fmpGet, type TickerData } from "./fmp";
import { getFxRate, listingMajor } from "./fx";

/**
 * Investment-holding-company valuation frame (John's July 17 rules).
 *
 * Rule 1 — detect holdcos BEFORE writing: fair-value accounts where profit is
 * mostly revaluation gains, a published NAV per share, a portfolio of stakes
 * rather than one operating business. For these the frame is NAV and the
 * discount to it — consolidated P/E of revaluation earnings never leads.
 *
 * Rule 2 — when any stake is listed, compute LIVE look-through NAV in code:
 * listed stakes at the latest close, unlisted at their last reported marks
 * converted at today's cross, share count from the latest disclosure, every
 * layer dated. "I can't verify a live discount" is not available when the
 * inputs are on the page. (CGEO shipped a 4% "optical" gap while 47% of the
 * book was BGEO.L, listed on the same exchange — the live discount was ~14%.)
 *
 * Rule 3 — adjectives bind to thresholds in config so "wide" can never print
 * above a computed 4%.
 */

export interface HoldcoListedStake {
  name: string;
  ticker: string; // FMP-resolvable listing, e.g. "BGEO.L"
  valueAtMark: number; // in `currency`, at the company's last reported mark
  currency: string;
  asOf: string; // mark date, YYYY-MM-DD
  /** Company-disclosed value in the SUBJECT's listing currency at the mark
   * (e.g. CGEO discloses the GBP equivalent at its own cross). */
  valueListingCcyAtMark?: number | null;
  /** The company's own cross at the mark (units of `currency` per one unit of
   * listing currency), when disclosed. */
  crossAtMark?: number | null;
}

export interface HoldcoFacts {
  isHoldco: boolean;
  why: string;
  /** Set when research failed transiently (timeout, unparseable output) —
   * NEVER cached, so the next run retries instead of wearing a 14-day
   * false-negative. */
  unverified?: boolean;
  publishedNav?: {
    total: number; // in `currency`
    currency: string;
    perShare?: number | null;
    /** The currency perShare is quoted in — companies publish either the NAV
     * currency or a listing-ccy equivalent; assuming either silently mixed
     * units (GEL 154.7 vs £48.3 fails a 0.4-2.5x band at ratio 0.31). */
    perShareCurrency?: string | null;
    asOf: string;
    source: string;
  } | null;
  shareCount?: { value: number; asOf: string; source: string } | null;
  listedStakes?: HoldcoListedStake[];
}

export interface NavLayer {
  label: string;
  valueListingCcy: number; // millions, listing MAJOR currency
  asOf: string;
  method: string;
}

export interface LiveNav {
  totalListingCcy: number; // listing MAJOR units (not millions)
  perShare: number;
  listingCurrency: string;
  pricePerShare: number;
  pToNav: number; // price / live NAV per share
  discountPct: number; // positive = discount, negative = premium
  discountClass: DiscountClass;
  layers: NavLayer[];
  publishedPerShare?: number | null; // for the optical-vs-live contrast
  publishedAsOf?: string | null;
}

export interface HoldcoContext {
  facts: HoldcoFacts;
  /** Null when live marking failed (e.g. a stake quote unavailable) — the
   * note then frames on the PUBLISHED NAV, dated, never a fabricated number. */
  liveNav: LiveNav | null;
  /** The published NAV in listing-currency terms for the strip when the live
   * frame is unavailable — the strip must NEVER fall back to P/E (rule 1). */
  publishedListing?: { perShare: number; pToNav: number; asOf: string } | null;
}

export type DiscountClass = "wide" | "modest" | "near" | "premium";

/** Rule 3: adjectives bind to thresholds — config, not vibes. */
export function discountClass(discountPct: number): DiscountClass {
  const cfg = config();
  if (discountPct >= cfg.HOLDCO_WIDE_MIN) return "wide";
  if (discountPct >= cfg.HOLDCO_MODEST_MIN) return "modest";
  if (discountPct > -cfg.HOLDCO_MODEST_MIN) return "near";
  return "premium";
}

export const DISCOUNT_CLASS_PHRASE: Record<DiscountClass, string> = {
  wide: "a wide discount",
  modest: "a modest discount",
  near: "roughly at NAV",
  premium: "a premium to NAV",
};

/**
 * Cheap deterministic prefilter — generous on purpose; the researched verdict
 * (John's three functional signals) decides strictly. Only a prefilter hit
 * spends research tokens.
 */
export function holdcoPrefilter(data: TickerData): boolean {
  const p = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
    | { industry?: string; description?: string; companyName?: string }
    | undefined;
  const hay = `${p?.industry ?? ""} | ${p?.companyName ?? ""} | ${(p?.description ?? "").slice(0, 1200)}`;
  return /hold(ing|co)|investment (company|trust|group|firm)|conglomerate|closed[- ]end|portfolio (of|comprising)|net asset value|\bNAV\b/i.test(
    hay,
  );
}

const FACTS_TTL_DAYS = 14;

const RESEARCH_SYSTEM = `You classify whether a company is an INVESTMENT HOLDING COMPANY and extract its NAV inputs from primary disclosures (company website, results releases, NAV statements, RNS).

A company qualifies ONLY if it shows the functional signals: fair-value accounting where reported profit is mostly revaluation gains; a published NAV (total or per share); a portfolio of stakes rather than one consolidated operating business. An operating bank, insurer, or industrial that merely has "Holdings"/"Group" in its name does NOT qualify.

Return ONLY a fenced json block:
\`\`\`json
{
  "is_investment_holdco": true|false,
  "why": "one sentence",
  "published_nav": {"total": number, "currency": "GEL", "per_share": number|null, "per_share_currency": "GEL"|"GBP"|null, "as_of": "YYYY-MM-DD", "source": "url or doc name"} | null,
  "share_count": {"value": number, "as_of": "YYYY-MM-DD", "source": "..."} | null,
  "listed_stakes": [
    {"name": "...", "ticker": "FMP-style listing e.g. BGEO.L", "value_at_mark": number, "currency": "GEL", "as_of": "YYYY-MM-DD",
     "value_listing_ccy_at_mark": number|null, "cross_at_mark": number|null}
  ]
}
\`\`\`
Rules:
- published_nav.total and stake values in MILLIONS of the stated currency; share_count in ABSOLUTE shares.
- per_share_currency states EXACTLY which currency per_share is quoted in (a company may publish GEL 154.7 or the GBP equivalent — say which one you are returning).
- cross_at_mark DIRECTION: units of the stake's value currency per ONE unit of the SUBJECT's listing currency (e.g. GEL per GBP = 3.573). Never the inverse.
- listed_stakes: ONLY stakes with a real public listing; include the company-disclosed value in the subject's listing currency (value_listing_ccy_at_mark, millions) or the company's own cross rate at the mark when the disclosure states one.
- Use the LATEST disclosed figures; if a later share-count change (buyback, trim) is disclosed, use the disclosed count and cite it.
- Numbers only from disclosures you actually found — null over guess, always.
- Work FAST: prefer search-result snippets, NAV announcements, and results press releases over fetching large documents; fetch at most the one or two pages that state the NAV and the stakes.`;

/** Fenced-JSON extraction (tools + json_schema don't mix). */
function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[1] ?? m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function researchHoldcoFacts(ticker: string, companyName: string | undefined, data: TickerData): Promise<HoldcoFacts> {
  const cfg = config();
  const p = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
    | { description?: string; industry?: string }
    | undefined;
  const baseRequest = {
    model: cfg.MEMO_MODEL,
    max_tokens: 4000,
    thinking: { type: "disabled" as const },
    system: RESEARCH_SYSTEM,
    tools: [
      { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 4 },
      // Fetches are the latency killer (a fetched annual report can run to
      // hundreds of pages) — two, content-capped, summaries preferred.
      { type: "web_fetch_20260209" as const, name: "web_fetch" as const, max_uses: 2, max_content_tokens: 30_000 },
    ],
  };
  const messages: { role: "user" | "assistant"; content: string | unknown[] }[] = [
    {
      role: "user",
      content:
        `Company: ${companyName ?? ticker} (${ticker})\nIndustry per data vendor: ${p?.industry ?? "?"}\n` +
        `Vendor description: ${(p?.description ?? "").slice(0, 800)}\n\n` +
        `Classify per the rules and extract the NAV inputs.`,
    },
  ];
  let response = await anthropic().messages.create({ ...baseRequest, messages } as never);
  // Accumulate text across ALL turn segments — a pause_turn continuation can
  // leave the fenced JSON in an earlier segment, and reading only the final
  // response would discard it (and cache a false negative).
  const collectText = (content: { type: string }[]): string =>
    content
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? (b as { text: string }).text : ""))
      .join("\n");
  let text = collectText(response.content);
  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < 2) {
    messages.push({ role: "assistant", content: response.content });
    response = await anthropic().messages.create({ ...baseRequest, messages } as never);
    text += "\n" + collectText(response.content);
    continuations++;
  }
  const parsed = extractJson(text);
  if (!parsed) {
    console.warn(`Holdco research for ${ticker}: no parseable verdict (stop: ${response.stop_reason}; text head: ${text.slice(0, 200)})`);
    return { isHoldco: false, why: "research returned no parseable verdict (fail-open to normal frame)", unverified: true };
  }

  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const nav = parsed.published_nav as Record<string, unknown> | null;
  const sc = parsed.share_count as Record<string, unknown> | null;
  const stakes = Array.isArray(parsed.listed_stakes) ? (parsed.listed_stakes as Record<string, unknown>[]) : [];
  return {
    isHoldco: parsed.is_investment_holdco === true,
    why: str(parsed.why) ?? "",
    publishedNav:
      nav && num(nav.total) !== null && str(nav.currency) && str(nav.as_of)
        ? {
            total: num(nav.total)!,
            currency: str(nav.currency)!,
            perShare: num(nav.per_share),
            perShareCurrency: str(nav.per_share_currency),
            asOf: str(nav.as_of)!,
            source: str(nav.source) ?? "company disclosure",
          }
        : null,
    shareCount:
      sc && num(sc.value) !== null && str(sc.as_of)
        ? { value: num(sc.value)!, asOf: str(sc.as_of)!, source: str(sc.source) ?? "company disclosure" }
        : null,
    listedStakes: stakes
      .map((s) => ({
        name: str(s.name) ?? "",
        ticker: (str(s.ticker) ?? "").toUpperCase(),
        valueAtMark: num(s.value_at_mark) ?? 0,
        currency: str(s.currency) ?? "",
        asOf: str(s.as_of) ?? "",
        valueListingCcyAtMark: num(s.value_listing_ccy_at_mark),
        crossAtMark: num(s.cross_at_mark),
      }))
      .filter((s) => s.ticker && s.valueAtMark > 0 && s.currency && s.asOf),
  };
}

/**
 * Resolve a researched stake ticker to one FMP actually quotes. Renames are
 * the DR-problem again — the researcher returns the CURRENT name's ticker
 * (LION.L for Lion Finance) while the vendor still quotes the old line
 * (BGEO.L). Fallback: search by company name, take the first hit that quotes.
 */
async function resolveStakeSymbol(ticker: string, name: string): Promise<{ symbol: string; price: number } | null> {
  try {
    const direct = await fmpGet<{ price?: number }[]>("quote", { symbol: ticker });
    if (direct?.[0]?.price && direct[0].price > 0) return { symbol: ticker, price: direct[0].price };
  } catch {
    /* fall through to search */
  }
  if (!name) return null;
  try {
    // Researched names often carry parentheticals ("Lion Finance Group PLC
    // (Bank of Georgia parent)") that kill the search — strip them.
    const query = name.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
    const hits = await fmpGet<{ symbol?: string }[]>("search-name", { query, limit: 5 });
    for (const h of hits ?? []) {
      if (!h.symbol || h.symbol.toUpperCase() === ticker.toUpperCase()) continue;
      try {
        const q = await fmpGet<{ price?: number }[]>("quote", { symbol: h.symbol });
        if (q?.[0]?.price && q[0].price > 0) {
          console.log(`Holdco stake resolved by name: ${ticker} → ${h.symbol} (${name})`);
          return { symbol: h.symbol, price: q[0].price };
        }
      } catch {
        /* try next hit */
      }
    }
  } catch {
    /* unresolvable */
  }
  return null;
}

/** Close on or nearest BEFORE the date (marks land on non-trading days). */
async function closeOnOrBefore(ticker: string, date: string): Promise<number | null> {
  try {
    const from = new Date(new Date(date + "T00:00:00Z").getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
    const rows = await fmpGet<{ date?: string; price?: number; close?: number }[]>("historical-price-eod/light", {
      symbol: ticker,
      from,
      to: date,
    });
    const usable = (rows ?? [])
      .filter((r) => r.date && (r.close ?? r.price) !== undefined)
      .sort((a, b) => (a.date! < b.date! ? 1 : -1));
    const v = usable[0] ? (usable[0].close ?? usable[0].price) : null;
    return typeof v === "number" && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** The pure arithmetic of John's method — testable against his worked example
 * to the decimal. All stake/residual values in MILLIONS of listing ccy. */
export function liveNavArithmetic(inputs: {
  stakes: { valueListingCcyAtMarkM: number; markClose: number; todayClose: number }[];
  residualListingCcyM: number;
  shareCount: number;
  pricePerShare: number;
}): { totalListingCcy: number; perShare: number; pToNav: number; discountPct: number } {
  const listedLiveM = inputs.stakes.reduce(
    (sum, s) => sum + s.valueListingCcyAtMarkM * (s.todayClose / s.markClose),
    0,
  );
  const totalListingCcy = (listedLiveM + inputs.residualListingCcyM) * 1_000_000;
  const perShare = totalListingCcy / inputs.shareCount;
  const pToNav = inputs.pricePerShare / perShare;
  return { totalListingCcy, perShare, pToNav, discountPct: (1 - pToNav) * 100 };
}

/**
 * John's method, generalized (his CGEO worked example is the unit test):
 * each listed stake = mark-date value in listing ccy × (close today / close
 * at mark); the residual (published total NAV − listed marks) converts at
 * TODAY's cross; per-share on the latest disclosed count.
 */
export async function computeLiveNav(facts: HoldcoFacts, data: TickerData): Promise<LiveNav | null> {
  const quote = (Array.isArray(data.quote) ? data.quote[0] : data.quote) as
    | { price?: number; symbol?: string }
    | undefined;
  const profile = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
    | { currency?: string }
    | undefined;
  if (!facts.publishedNav || !facts.shareCount || !quote?.price || quote.price <= 0) return null;
  // GBp-quoted names: work in MAJOR units (4,145p → £41.45).
  const lm = listingMajor(profile?.currency ?? "USD");
  const price = quote.price / lm.penceFactor;
  const listingCcy = lm.major || (profile?.currency ?? "USD");
  const navCcy = facts.publishedNav.currency;
  const today = new Date().toISOString().slice(0, 10);

  const crossToday = navCcy.toUpperCase() === listingCcy.toUpperCase() ? 1 : await getFxRate(navCcy, listingCcy);
  if (!crossToday) return null;

  const layers: NavLayer[] = [];
  const stakeInputs: { valueListingCcyAtMarkM: number; markClose: number; todayClose: number }[] = [];
  let listedMarkTotalNavCcyM = 0; // millions, NAV ccy

  for (const stake of facts.listedStakes ?? []) {
    // Stake marks in a different currency than the published NAV convert at
    // today's cross before the residual subtraction — never mixed raw.
    const stakeCcy = stake.currency.toUpperCase();
    let markInNavCcy = stake.valueAtMark;
    if (stakeCcy !== navCcy.toUpperCase()) {
      const toNav = await getFxRate(stakeCcy, navCcy);
      if (!toNav) return null;
      markInNavCcy = stake.valueAtMark * toNav;
    }
    listedMarkTotalNavCcyM += markInNavCcy;

    // Mark-date value in listing ccy: company-disclosed equivalent first,
    // then the company's own cross (direction-checked against today's — a
    // researched inverse would inflate the stake ~13x), then today's cross.
    let valueListingM: number | null = stake.valueListingCcyAtMark ?? null;
    let fxMethod = "company-disclosed listing-ccy value at mark";
    if (valueListingM === null && stake.crossAtMark && stake.crossAtMark > 0) {
      const expected = 1 / ((await getFxRate(stakeCcy, listingCcy)) ?? NaN); // stake ccy per listing ccy, today
      const plausible = Number.isFinite(expected) && stake.crossAtMark > expected / 1.8 && stake.crossAtMark < expected * 1.8;
      if (plausible) {
        valueListingM = stake.valueAtMark / stake.crossAtMark;
        fxMethod = `company cross at mark (${stake.crossAtMark} ${stakeCcy}/${listingCcy})`;
      } else {
        console.warn(
          `Holdco stake ${stake.ticker}: researched cross ${stake.crossAtMark} implausible vs today's ~${expected.toFixed(2)} — ignoring it.`,
        );
      }
    }
    if (valueListingM === null) {
      const cross = await getFxRate(stakeCcy, listingCcy);
      if (!cross) return null; // no honest way to mark this stake
      valueListingM = stake.valueAtMark * cross;
      fxMethod = "today's cross (mark-date cross unavailable — approximation)";
    }
    let markClose: number | null = null;
    let resolved: { symbol: string; price: number } | null = null;
    try {
      resolved = await resolveStakeSymbol(stake.ticker, stake.name);
      if (resolved) markClose = await closeOnOrBefore(resolved.symbol, stake.asOf);
    } catch (e) {
      console.warn(`Holdco stake ${stake.ticker}: quote/history fetch failed — published-NAV frame.`, e);
      return null; // liveNav degrades; the FACTS survive in the caller
    }
    if (!resolved || !markClose) {
      console.warn(`Holdco stake ${stake.ticker} (${stake.name}): unmarkable (resolved: ${resolved?.symbol ?? "no"}, mark close: ${markClose ?? "none"}) — published-NAV frame.`);
      return null; // stake unmarkable → published frame
    }
    const todayClose = resolved.price;
    stakeInputs.push({ valueListingCcyAtMarkM: valueListingM, markClose, todayClose });
    layers.push({
      label: `${stake.name || stake.ticker} (${resolved.symbol}) marked ${stake.asOf} → ${today}`,
      valueListingCcy: valueListingM * (todayClose / markClose),
      asOf: today,
      // The close ratio holds the stake's own FX at the mark — honest label;
      // a full FX adjustment would need the mark-date cross series.
      method: `${fxMethod}; close ${markClose} → ${todayClose}${stakeCcy !== listingCcy.toUpperCase() ? "; stake FX held at mark" : ""}`,
    });
  }

  // Residual: everything not separately marked, at today's cross (rule 2).
  // A NEGATIVE residual is legitimate for a levered holdco (published NAV is
  // net of debt, listed marks are gross) — only a residual so negative it
  // dwarfs the published total reads as bad data.
  const residualNavCcyM = facts.publishedNav.total - listedMarkTotalNavCcyM;
  if (residualNavCcyM < -Math.abs(facts.publishedNav.total) * 0.5) return null;
  const residualListingM = residualNavCcyM * crossToday;
  layers.push({
    label: `${residualNavCcyM < 0 ? "Net holdco liabilities beyond listed marks" : "Unlisted portfolio + other net assets"} at ${facts.publishedNav.asOf} marks`,
    valueListingCcy: residualListingM,
    asOf: today,
    method: `today's ${navCcy}/${listingCcy} cross (${(1 / crossToday).toFixed(3)} ${navCcy} per ${listingCcy})`,
  });

  const calc = liveNavArithmetic({
    stakes: stakeInputs,
    residualListingCcyM: residualListingM,
    shareCount: facts.shareCount.value,
    pricePerShare: price,
  });
  if (!Number.isFinite(calc.perShare) || calc.perShare <= 0) return null;
  // Sanity: a live NAV wildly off the published one is a data error, not
  // news. Compare in ONE currency — the published per-share may be quoted in
  // the NAV currency (GEL 154.7) or the listing currency (£43.34); assuming
  // either silently nulled the flagship case at ratio 0.31.
  let publishedPerShareListing: number | null = null;
  if (facts.publishedNav.perShare && facts.publishedNav.perShare > 0) {
    const psCcy = (facts.publishedNav.perShareCurrency ?? navCcy).toUpperCase();
    if (psCcy === listingCcy.toUpperCase()) {
      publishedPerShareListing = facts.publishedNav.perShare;
    } else if (psCcy === navCcy.toUpperCase()) {
      publishedPerShareListing = facts.publishedNav.perShare * crossToday;
    } // any other currency: skip the band rather than guess
    if (publishedPerShareListing !== null) {
      const ratio = calc.perShare / publishedPerShareListing;
      if (ratio < 0.4 || ratio > 2.5) return null;
    }
  }
  return {
    totalListingCcy: calc.totalListingCcy,
    perShare: calc.perShare,
    listingCurrency: listingCcy,
    pricePerShare: price,
    pToNav: calc.pToNav,
    discountPct: calc.discountPct,
    discountClass: discountClass(calc.discountPct),
    layers,
    publishedPerShare: publishedPerShareListing,
    publishedAsOf: facts.publishedNav.asOf,
  };
}

/**
 * The cached entry point: prefilter (free) → researched verdict + inputs
 * (cached FACTS_TTL_DAYS, negatives too) → live NAV recomputed from TODAY's
 * quotes on every call (prices are never cached into the frame).
 */
export async function getHoldcoContext(args: {
  ticker: string;
  companyName?: string;
  data: TickerData;
}): Promise<HoldcoContext | null> {
  try {
    if (!holdcoPrefilter(args.data)) return null;
    const symbol = args.ticker.toUpperCase();
    let facts: HoldcoFacts | null = null;
    const { data: cached } = await db()
      .from("filing_facts")
      .select("value, updated_at")
      .eq("symbol", symbol)
      .eq("metric", "holdco_nav")
      .maybeSingle();
    if (cached?.value && cached.updated_at && Date.now() - new Date(cached.updated_at as string).getTime() < FACTS_TTL_DAYS * 86_400_000) {
      try {
        facts = JSON.parse(cached.value as string) as HoldcoFacts;
      } catch {
        facts = null;
      }
    }
    if (!facts) {
      // Hard time-box: this runs inline in the delivery worker (800s budget)
      // and a hung web-search turn must degrade to the normal frame, not eat
      // the morning. Timeouts are transient — never cached.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        facts = await Promise.race([
          researchHoldcoFacts(args.ticker, args.companyName, args.data),
          new Promise<HoldcoFacts>((resolve) => {
            timer = setTimeout(() => {
              console.warn(`Holdco research for ${args.ticker}: timed out at 360s (fail-open to normal frame, not cached).`);
              resolve({ isHoldco: false, why: "holdco research timed out (fail-open to normal frame)", unverified: true });
            }, 360_000);
          }),
        ]);
      } finally {
        clearTimeout(timer); // a won race must not leave a live timer (spurious warns, held-open scripts)
      }
      if (!facts.unverified) {
        await db()
          .from("filing_facts")
          .upsert(
            [{ symbol, metric: "holdco_nav", value: JSON.stringify(facts), source: "holdco research", updated_at: new Date().toISOString() }],
            { onConflict: "symbol,metric" },
          );
      }
    }
    if (!facts.isHoldco) return null;
    // The FACTS survive any live-marking failure: a thrown quote fetch or FX
    // error degrades to the published-NAV frame, never back to the P/E frame
    // rule 1 forbids.
    let liveNav: LiveNav | null = null;
    try {
      liveNav = await computeLiveNav(facts, args.data);
    } catch (e) {
      console.error(`Live NAV computation failed for ${args.ticker} (published-NAV frame):`, e);
    }
    // Published NAV in listing terms for the strip's fallback frame — the
    // strip must never revert to P/E just because live marking failed.
    let publishedListing: HoldcoContext["publishedListing"] = null;
    if (!liveNav && facts.publishedNav?.perShare && facts.publishedNav.perShare > 0) {
      try {
        const quote = (Array.isArray(args.data.quote) ? args.data.quote[0] : args.data.quote) as { price?: number } | undefined;
        const profile = (Array.isArray(args.data.profile) ? args.data.profile[0] : args.data.profile) as { currency?: string } | undefined;
        if (quote?.price && quote.price > 0) {
          const lm = listingMajor(profile?.currency ?? "USD");
          const price = quote.price / lm.penceFactor;
          const listingCcy = lm.major || (profile?.currency ?? "USD");
          const psCcy = (facts.publishedNav.perShareCurrency ?? facts.publishedNav.currency).toUpperCase();
          const cross = psCcy === listingCcy.toUpperCase() ? 1 : await getFxRate(psCcy, listingCcy);
          if (cross) {
            const perShare = facts.publishedNav.perShare * cross;
            publishedListing = { perShare, pToNav: price / perShare, asOf: facts.publishedNav.asOf };
          }
        }
      } catch {
        publishedListing = null;
      }
    }
    return { facts, liveNav, publishedListing };
  } catch (e) {
    console.error(`Holdco context failed for ${args.ticker} (fail-open to normal frame):`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rule 5: words trace to numbers. Deterministic adjective↔class gate, applied
// to the memo (inside the verify loop), the meta one-liner, and the cover.
// ---------------------------------------------------------------------------

const ADJECTIVE_CLASSES: { rx: RegExp; cls: DiscountClass }[] = [
  { rx: /\b(wide|deep|steep|huge|massive|enormous|yawning|gaping)\b[^.\n]{0,40}\b(discount|gap to nav|below nav)/i, cls: "wide" },
  { rx: /\b(discount|gap)\b[^.\n]{0,30}\b(wide|deep|steep|huge|massive|enormous)\b/i, cls: "wide" },
  { rx: /\b(modest|moderate|meaningful|mid-teens)\b[^.\n]{0,40}\bdiscount/i, cls: "modest" },
  { rx: /\b(slight|small|negligible|thin|optical|barely any)\b[^.\n]{0,40}\b(discount|gap)/i, cls: "near" },
  { rx: /\b(at|near|around|close to)\s+(its\s+)?NAV\b/i, cls: "near" },
  { rx: /\bpremium to\s+(its\s+)?NAV\b/i, cls: "premium" },
];

/**
 * Flag valuation adjectives that contradict the computed discount class.
 * Conservative by design: only known adjectives in a discount/NAV context are
 * checked, sentence by sentence — prose the map doesn't recognize is the LLM
 * verifier's job. A sentence explicitly anchored to the PAST is a dated
 * reference, not a claim about today's discount — "management cited a 32%
 * discount in October" is history, and blocking it would churn regens.
 */
const PAST_MARKER =
  /\b(cited|was|were|had|used to|at the time|back (in|then)|previous(ly)?|historic(al)?(ly)?|last (year|autumn|spring|summer|winter|month)|in (january|february|march|april|may|june|july|august|september|october|november|december)|in (19|20)\d\d)\b/i;

export function holdcoAdjectiveIssues(text: string, cls: DiscountClass, discountPct: number): string[] {
  const issues: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    if (PAST_MARKER.test(sentence)) continue;
    for (const a of ADJECTIVE_CLASSES) {
      const m = sentence.match(a.rx);
      if (m && a.cls !== cls) {
        issues.push(
          `"${m[0].trim().slice(0, 60)}" contradicts the computed live discount of ${discountPct.toFixed(0)}% ` +
            `(class: ${cls} — say "${DISCOUNT_CLASS_PHRASE[cls]}"). Every valuation adjective must trace to the computed figure; a historical figure needs its date in the same sentence.`,
        );
      }
    }
  }
  return issues;
}

/** The writer/verifier NAV-bridge block — computed figures, dated layers. */
export function holdcoPromptBlock(ctx: HoldcoContext): string {
  const f = ctx.facts;
  const lines: string[] = [
    `This company IS an investment holding company (${f.why}). The valuation frame is NAV and the discount to it — consolidated P/E or EV/EBITDA of fair-value earnings NEVER leads the subject, thesis, or stat strip; if mentioned at all, label it "revaluation-driven", once.`,
  ];
  if (ctx.liveNav) {
    const n = ctx.liveNav;
    lines.push(
      `LIVE LOOK-THROUGH NAV (computed by the desk from today's closes — use these figures verbatim):`,
      ...n.layers.map((l) => `- ${l.label}: ${l.valueListingCcy.toFixed(0)}m ${n.listingCurrency} (${l.method})`),
      `- Live NAV: ${(n.totalListingCcy / 1e9).toFixed(2)}bn ${n.listingCurrency} = ${n.perShare.toFixed(2)} ${n.listingCurrency}/share on ${f.shareCount?.value.toLocaleString()} shares (count as of ${f.shareCount?.asOf})`,
      `- At today's ${n.pricePerShare.toFixed(2)} ${n.listingCurrency}: ${n.pToNav.toFixed(2)}x live NAV — a ${n.discountPct.toFixed(0)}% ${n.discountPct >= 0 ? "discount" : "premium"} (published NAV${n.publishedPerShare ? ` ${n.publishedPerShare.toFixed(2)}` : ""} as of ${n.publishedAsOf} is the OPTICAL basis; the live number is the headline).`,
      `THE HEADLINE VALUATION IS THE LIVE DISCOUNT: subject, thesis, stat strip, and scenarios all read from ${n.discountPct.toFixed(0)}% (${n.pToNav.toFixed(2)}x). The REQUIRED adjective class is "${n.discountClass}" — phrase it as ${DISCOUNT_CLASS_PHRASE[n.discountClass]}. Never a hedged "can't verify a live discount": the computation is above, dated.`,
    );
  } else if (f.publishedNav) {
    lines.push(
      `No live marking was possible today (a stake quote or cross was unavailable). Frame on the PUBLISHED NAV of ${f.publishedNav.total.toFixed(0)}m ${f.publishedNav.currency}${
        f.publishedNav.perShare
          ? ` (${f.publishedNav.perShare.toFixed(2)} ${f.publishedNav.perShareCurrency ?? f.publishedNav.currency}/share)`
          : ""
      } as of ${f.publishedNav.asOf} — state the date plainly.`,
    );
  }
  return lines.join("\n");
}
