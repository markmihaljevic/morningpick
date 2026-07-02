/**
 * Offline memo-quality iteration. Runs the full profile-aware funnel
 * (derive screens → pool → shortlist → enrich → pick) for a test profile
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
import { shortlistCandidates, enrichShortlist, finalSelect } from "../lib/selection";
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
    const pool = await buildCandidatePool(screens);
    console.error(`Pool: ${pool.length} candidates`);

    console.error("Shortlisting…");
    const shortlist = await shortlistCandidates(profile, pool, [], []);
    console.error(`Shortlist: ${shortlist.map((c) => c.ticker).join(", ")}`);

    console.error("Enriching shortlist with valuation data…");
    const enriched = await enrichShortlist(shortlist);

    console.error("Final selection…");
    const selection = await finalSelect(profile, enriched, []);
    ticker = selection.ticker;
    rationale = selection.rationale;
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
