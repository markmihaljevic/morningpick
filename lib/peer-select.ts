import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import { config } from "./config";
import { db } from "./db";
import { fmpGet } from "./fmp";

/**
 * Peer selection is a judgment call, not a screen (John's rule 1). A
 * reasoning model picks 4-6 peers by BUSINESS comparability — same core
 * activities, customer base, regulatory regime, earnings drivers — with
 * listing venue irrelevant: a Georgian bank's peers can trade in London,
 * Almaty, Budapest, or New York. FMP's stock-peers screen put Bridgepoint
 * and two asset managers next to a retail bank; that class of row is why
 * this module exists. Each peer carries a one-line rationale that PRINTS
 * under the table.
 *
 * Groups are cached six months (rule 2); once stale, the model re-runs
 * seeded with the stored set ("verify or update"), then overwrites.
 */

export interface SelectedPeer {
  ticker: string;
  name: string;
  rationale: string;
}

const MAX_AGE_DAYS = 183; // six months

const PEERS_SCHEMA = {
  type: "object",
  properties: {
    peers: {
      type: "array",
      description: "4-6 peers, best comparables first",
      items: {
        type: "object",
        properties: {
          ticker: {
            type: "string",
            description:
              "FMP-resolvable symbol of the most liquid listing, with exchange suffix where applicable (e.g. BGEO.L, OTP.BD, KSPI). GDRs are fine.",
          },
          name: { type: "string", description: "Company name" },
          rationale: {
            type: "string",
            description:
              "ONE sentence on why this peer belongs — franchise/regulator/customer-base comparability. Prints under the table.",
          },
        },
        required: ["ticker", "name", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["peers"],
  additionalProperties: false,
} as const;

const PEERS_SYSTEM = `You pick comparable companies for a valuation table in an investment research note. Peer selection is a JUDGMENT call about business comparability — never a screen.

RULES:
- 4-6 peers. Same core activities, customer base, regulatory regime, and earnings drivers as the subject.
- Listing venue is IRRELEVANT: pick the best business comparables wherever they trade (London, Almaty, Budapest, Nasdaq, GDRs).
- Banks compare ONLY to banks — never asset managers, buyout firms, brokers, or insurers. The same discipline applies per industry: producers to producers, carriers to carriers.
- Prefer liquid, covered names a portfolio manager would accept as comps without argument. Include the closest same-market/duopoly rival when one exists.
- A useful template/aspiration peer (e.g. the super-app a digital arm is copying) is allowed when the rationale says exactly why it anchors value.
- Each peer gets ONE printed sentence of rationale — franchise-level, specific, no filler.
- Use the exact ticker of the most liquid FMP-resolvable listing (exchange suffix where applicable).
- NEVER include the subject itself.`;

/** Validate the model's tickers against FMP (in parallel — this runs while
 * the build lock is held); drop anything unresolvable. */
async function validatePeers(subject: string, peers: SelectedPeer[]): Promise<SelectedPeer[]> {
  const checked = await Promise.all(
    peers.map(async (p) => {
      const ticker = p.ticker.trim().toUpperCase();
      if (!ticker || ticker === subject.toUpperCase()) return null;
      try {
        const quote = await fmpGet<{ price?: number }[]>("quote", { symbol: ticker });
        if (quote?.[0]?.price !== undefined) {
          return { ticker, name: p.name.slice(0, 60), rationale: p.rationale.slice(0, 200) };
        }
        console.warn(`Peer ${ticker} (for ${subject}) not resolvable on FMP — dropped.`);
      } catch {
        console.warn(`Peer ${ticker} (for ${subject}) quote failed — dropped.`);
      }
      return null;
    }),
  );
  return checked.filter((p): p is SelectedPeer => p !== null).slice(0, 6);
}

async function pickPeers(args: {
  ticker: string;
  companyName?: string;
  industry?: string;
  sector?: string;
  description?: string;
  priorSet?: SelectedPeer[];
}): Promise<SelectedPeer[]> {
  const cfg = config();
  const seed = args.priorSet?.length
    ? `\n\nA peer group compiled earlier exists — VERIFY OR UPDATE it (keep what still holds, replace what doesn't, with rationale):\n${args.priorSet
        .map((p) => `- ${p.name} (${p.ticker}): ${p.rationale}`)
        .join("\n")}`
    : "";
  const baseRequest = {
    model: cfg.MEMO_MODEL,
    max_tokens: 8000,
    output_config: { format: { type: "json_schema" as const, schema: PEERS_SCHEMA }, effort: "high" as const },
    system: PEERS_SYSTEM,
    tools: [
      { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 5 },
    ],
  };
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Subject: ${args.companyName ?? args.ticker} (${args.ticker})\n` +
        `Industry: ${args.industry ?? "?"} · Sector: ${args.sector ?? "?"}\n` +
        (args.description ? `Business: ${args.description.slice(0, 600)}\n` : "") +
        `${seed}\n\nPick the peer group.`,
    },
  ];
  let response = await anthropic().messages.stream({ ...baseRequest, messages }).finalMessage();
  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < 4) {
    messages.push({ role: "assistant", content: response.content });
    response = await anthropic().messages.stream({ ...baseRequest, messages }).finalMessage();
    continuations++;
  }
  if (response.stop_reason === "refusal") return [];
  const text = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as {
    peers?: SelectedPeer[];
  };
  return validatePeers(args.ticker, parsed.peers ?? []);
}

/**
 * The cached judgment: read the stored group when younger than six months;
 * otherwise re-run the model (seeded with the stored set when one exists)
 * and overwrite. Day-locked so concurrent workers never duplicate the call.
 * Returns [] on total failure — the comp table then doesn't render, which
 * beats rendering FMP's screen-picked rows.
 */
export async function getPeerGroup(args: {
  ticker: string;
  companyName?: string;
  industry?: string;
  sector?: string;
  description?: string;
}): Promise<SelectedPeer[]> {
  const symbol = args.ticker.toUpperCase();
  let prior: SelectedPeer[] | undefined;
  try {
    const { data: row } = await db()
      .from("peer_groups")
      .select("peers, compiled_at")
      .eq("symbol", symbol)
      .maybeSingle();
    if (row) {
      const ageDays = (Date.now() - new Date(row.compiled_at).getTime()) / 86_400_000;
      const peers = row.peers as SelectedPeer[];
      if (ageDays <= MAX_AGE_DAYS && peers.length >= 2) return peers;
      prior = peers; // stale — seed the re-run with it
    }
  } catch (e) {
    console.error(`peer_groups read failed for ${symbol} (picking fresh):`, e);
  }

  // Build lock: one worker researches; losers POLL for the winner's result
  // (the model + validation realistically runs 1-4 minutes — a single short
  // wait would strand every concurrent subscriber table-less on a ticker's
  // first day). A lock older than 15 minutes is an orphan from a killed
  // worker — take it over rather than poisoning the symbol for the day.
  const lockKey = `peer-group:${symbol}:${new Date().toISOString().slice(0, 10)}`;
  const { error: lockError } = await db()
    .from("fmp_cache")
    .insert({ cache_key: lockKey, payload: { at: new Date().toISOString() } });
  if (lockError) {
    let takeover = false;
    try {
      const { data: lockRow } = await db()
        .from("fmp_cache")
        .select("payload")
        .eq("cache_key", lockKey)
        .maybeSingle();
      const at = (lockRow?.payload as { at?: string } | null)?.at;
      takeover = !at || Date.now() - new Date(at).getTime() > 15 * 60_000;
      if (takeover) {
        await db()
          .from("fmp_cache")
          .update({ payload: { at: new Date().toISOString() } })
          .eq("cache_key", lockKey);
      }
    } catch {
      /* treat as live lock */
    }
    if (!takeover) {
      for (let poll = 0; poll < 12; poll++) {
        await new Promise((r) => setTimeout(r, 20_000));
        const { data: retry } = await db()
          .from("peer_groups")
          .select("peers, compiled_at")
          .eq("symbol", symbol)
          .maybeSingle();
        if (retry) {
          const ageDays = (Date.now() - new Date(retry.compiled_at).getTime()) / 86_400_000;
          if (ageDays <= MAX_AGE_DAYS) return retry.peers as SelectedPeer[];
        }
      }
      return prior ?? []; // stale beats screen-picked; empty beats wrong
    }
    // orphan taken over — fall through to research
  }

  try {
    const peers = await pickPeers({ ...args, priorSet: prior });
    if (peers.length >= 2) {
      const { error } = await db()
        .from("peer_groups")
        .upsert({ symbol, peers, compiled_at: new Date().toISOString() }, { onConflict: "symbol" });
      if (error) console.error(`peer_groups upsert failed for ${symbol}:`, error.message);
      return peers;
    }
    console.warn(`Peer selection for ${symbol} produced ${peers.length} valid peers.`);
    return prior ?? peers;
  } catch (e) {
    console.error(`Peer selection failed for ${symbol}:`, e);
    return prior ?? [];
  }
}
