/**
 * Offline memo-quality iteration. Runs the full profile-aware funnel
 * (derive screens → pool → score → top name) for a test profile
 * and prints the memo, without touching subscribers or sending email.
 *
 *   npx tsx scripts/generate-memo.ts            # full funnel for test profile
 *   npx tsx scripts/generate-memo.ts NVDA       # skip selection, force a ticker
 *   npx tsx scripts/generate-memo.ts --email you@example.com   # use a real subscriber's profile
 *
 * Requires .env.local with ANTHROPIC_API_KEY, FMP_API_KEY, SUPABASE_* set.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { db } from "../lib/db";
import type { Profile } from "../lib/profile";
import { deriveScreens, buildCandidatePool } from "../lib/screens";
import { ensureFactorTable, loadFactorRows } from "../lib/factor-table";
import { scoreCandidates, deriveWeights, deriveValuationMetricWeights } from "../lib/scoring";
import { fetchTickerData } from "../lib/fmp";
import { generateMemo } from "../lib/memo";

const TEST_PROFILE: Profile = {
  structured: {
    regions_prefer: ["Europe", "US"],
    market_cap_pref: "mid and small caps preferred",
    style: "quality at a reasonable price, mildly contrarian",
    sectors_avoid: ["airlines"],
  },
  philosophy:
    "Long-term fundamental investor. Likes businesses with pricing power and clean balance " +
    "sheets trading below intrinsic value due to temporary, solvable problems. Skeptical of " +
    "hype; wants honest bear cases.",
};

async function loadProfile(): Promise<Profile> {
  const emailFlag = process.argv.indexOf("--email");
  if (emailFlag === -1) return TEST_PROFILE;
  const email = process.argv[emailFlag + 1];
  const { data, error } = await db()
    .from("subscribers")
    .select("preference_profiles(structured, philosophy)")
    .eq("email", email)
    .single();
  if (error) throw new Error(`Subscriber ${email} not found: ${error.message}`);
  const row = Array.isArray(data.preference_profiles)
    ? data.preference_profiles[0]
    : data.preference_profiles;
  return {
    structured: (row?.structured as Record<string, unknown>) ?? {},
    philosophy: (row?.philosophy as string) ?? "",
  };
}

async function main() {
  const positional = process.argv[2];
  const forcedTicker =
    positional && !positional.startsWith("--") ? positional.toUpperCase() : undefined;
  const profile = await loadProfile();

  let ticker = forcedTicker;
  let rationale = "Forced via CLI argument.";
  let companyName: string | undefined;

  if (!ticker) {
    console.error("Deriving screens from profile…");
    const screens = await deriveScreens(profile);
    console.error(JSON.stringify(screens, null, 2));

    console.error("Building candidate pool…");
    const { pool, stats } = await buildCandidatePool(screens, profile);
    console.error(
      `Pool: ${pool.length} candidates (${stats.domicileDropped} dropped outside geographies)`,
    );

    console.error("Scoring (pure code, no LLM)…");
    await ensureFactorTable();
    const factorRows = await loadFactorRows(pool.map((c) => c.ticker));
    const weights = deriveWeights(profile);
    const valuationMetrics = deriveValuationMetricWeights(profile);
    const { ranked, quarantined } = scoreCandidates(pool, factorRows, weights, valuationMetrics);
    console.error(
      `Ranked ${ranked.length} (quarantined ${quarantined.length}); weights ${JSON.stringify(weights)}; valuation metrics ${JSON.stringify(valuationMetrics)}`,
    );
    console.error(
      `Top 10: ${ranked.slice(0, 10).map((c) => `${c.ticker}(${Math.round(c.composite)})`).join(", ")}`,
    );

    // One shipping rule: the top-ranked name IS the selection.
    if (ranked.length === 0) throw new Error("Zero rankable survivors.");
    ticker = ranked[0].ticker;
    rationale = `Top of today's ranked list (score ${Math.round(ranked[0].composite)}) of ${ranked.length} survivors.`;
    companyName = pool.find((c) => c.ticker === ticker)?.name;
    console.error(`Selected: ${ticker} — ${rationale}`);
  }

  console.error(`Fetching FMP data for ${ticker}…`);
  const data = await fetchTickerData(ticker);

  console.error("Generating memo (this can take a minute)…");
  const memo = await generateMemo({
    profile,
    ticker,
    companyName,
    data,
    selectionRationale: rationale,
  });

  console.error(`\n===== ${memo.title} (${memo.model}) =====\n`);
  console.log(memo.markdown);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
