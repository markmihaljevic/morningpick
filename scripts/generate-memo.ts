/**
 * Offline memo-quality iteration. Generates one memo to stdout for a fake
 * profile without touching subscribers or sending email.
 *
 *   npx tsx scripts/generate-memo.ts            # auto-pick from today's universe
 *   npx tsx scripts/generate-memo.ts NVDA       # force a ticker
 *
 * Requires .env.local with ANTHROPIC_API_KEY, FMP_API_KEY, SUPABASE_* set.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { ensureDailyUniverse, selectTicker, type Profile } from "../lib/candidates";
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

async function main() {
  const forcedTicker = process.argv[2]?.toUpperCase();
  const today = new Date().toISOString().slice(0, 10);

  console.error("Building/loading today's universe…");
  const universe = await ensureDailyUniverse(today);
  console.error(`Universe: ${universe.length} candidates`);

  let ticker = forcedTicker;
  let rationale = "Forced via CLI argument.";
  if (!ticker) {
    console.error("Selecting ticker for test profile…");
    const selection = await selectTicker(TEST_PROFILE, universe, [], []);
    ticker = selection.ticker;
    rationale = selection.rationale;
    console.error(`Selected: ${ticker} — ${rationale}`);
  }

  console.error(`Fetching FMP data for ${ticker}…`);
  const data = await fetchTickerData(ticker);

  console.error("Generating memo (this can take a minute)…");
  const memo = await generateMemo({
    profile: TEST_PROFILE,
    ticker,
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
