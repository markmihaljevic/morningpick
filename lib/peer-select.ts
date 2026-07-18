import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import { config } from "./config";
import { db } from "./db";
import { fmpGet } from "./fmp";
import { trimAtBoundary } from "./text";

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
- 4-6 peers. Same core activities, customer base, regulatory regime, and earnings drivers as the subject. A large-cap subject deserves the FULL set — a $14B reinsurer has Everest, Arch, Axis, and Lancashire sitting right there.
- Listing venue is IRRELEVANT: pick the best business comparables wherever they trade (London, Almaty, Budapest, Nasdaq, GDRs).
- Banks compare ONLY to banks — never asset managers, buyout firms, brokers, or insurers. The same discipline applies per industry: producers to producers, carriers to carriers.
- Prefer liquid, covered names a portfolio manager would accept as comps without argument. Include the closest same-market/duopoly rival when one exists.
- A useful template/aspiration peer (e.g. the super-app a digital arm is copying) is allowed when the rationale says exactly why it anchors value.
- Each peer gets ONE printed sentence of rationale — franchise-level, specific, no filler. NEVER emit scaffolding text ("placeholder", "TBD") in any field: every rationale you cannot write is a peer you have not picked.
- ONE ROW PER COMPANY: never include two listings or a renamed legacy ticker of the same company (Everest Group EG and legacy Everest Re RE are ONE company). Use the exact ticker of the most liquid CURRENT FMP-resolvable listing (exchange suffix where applicable).
- NEVER include the subject itself.`;

// Scaffolding the schema can't catch (strings are strings): a peer whose
// name or rationale is filler is a peer the model didn't actually pick —
// the RNR table printed the literal word "placeholder" for two of three
// rows and mashed "Everest Re Group (legacy)/Arch-style peer - Argo".
export const SCAFFOLDING = /^(placeholder|tbd|n\/?a|todo|unknown|-+)$/i;
export const looksScaffolded = (p: SelectedPeer): boolean =>
  SCAFFOLDING.test(p.name.trim()) ||
  SCAFFOLDING.test(p.rationale.trim()) ||
  p.rationale.trim().length < 20 ||
  /\(legacy\)|\/.*peer|placeholder/i.test(p.name);

/** Validate the model's tickers against FMP (in parallel — this runs while
 * the build lock is held); drop anything unresolvable or scaffolded, then
 * dedupe on COMPANY identity — the same identity the no-repeat rule uses
 * (ISIN, name-key), plus a token-subset name check for renames the keys
 * miss ("Everest Group" ⊂ "Everest Re Group"). */
async function validatePeers(subject: string, peers: SelectedPeer[]): Promise<SelectedPeer[]> {
  const checked = await Promise.all(
    peers.map(async (p) => {
      const ticker = p.ticker.trim().toUpperCase();
      if (!ticker || ticker === subject.toUpperCase()) return null;
      if (looksScaffolded(p)) {
        console.warn(`Peer ${ticker} (for ${subject}) rejected as scaffolding: "${p.name}" / "${p.rationale.slice(0, 40)}"`);
        return null;
      }
      try {
        const quote = await fmpGet<{ price?: number }[]>("quote", { symbol: ticker });
        if (quote?.[0]?.price !== undefined) {
          return { ticker, name: p.name.slice(0, 60), rationale: trimAtBoundary(p.rationale, 300) };
        }
        console.warn(`Peer ${ticker} (for ${subject}) not resolvable on FMP — dropped.`);
      } catch {
        console.warn(`Peer ${ticker} (for ${subject}) quote failed — dropped.`);
      }
      return null;
    }),
  );
  const valid = checked.filter((p): p is SelectedPeer => p !== null);
  const deduped = await dedupePeersByIdentity(subject, valid);
  return deduped.slice(0, 6);
}

/** One row per company: identity keys first (ISIN via profile — the rename
 * problem: EG and legacy RE are one company), token-subset names second. */
export async function dedupePeersByIdentity(
  subject: string,
  peers: SelectedPeer[],
): Promise<SelectedPeer[]> {
  const { identityForTicker } = await import("./company-key");
  const seen = new Map<string, SelectedPeer>();
  const kept: SelectedPeer[] = [];
  for (const p of peers) {
    let keys: string[] = [];
    try {
      const id = await identityForTicker(p.ticker);
      keys = [id.key, id.nameKey].filter((k): k is string => Boolean(k));
    } catch {
      keys = [];
    }
    // Token-subset name fallback: "everest" ⊂ "everest re" is the same shop.
    const nameTokens = p.name.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
    const dupOfKey = keys.find((k) => seen.has(k));
    const dupOfName = kept.find((k) => {
      const kt = k.name.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
      const shorter = nameTokens.length <= kt.length ? nameTokens : kt;
      const longer = nameTokens.length <= kt.length ? kt : nameTokens;
      return shorter.length > 0 && shorter[0].length >= 5 && shorter.every((t) => longer.includes(t));
    });
    if (dupOfKey || dupOfName) {
      console.warn(`Peer ${p.ticker} (for ${subject}) is the same company as an earlier row — deduped.`);
      continue;
    }
    for (const k of keys) seen.set(k, p);
    kept.push(p);
  }
  return kept;
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
  let peers = await validatePeers(args.ticker, parsed.peers ?? []);
  // A $14B name with 2 surviving peers is a failed pick, not a thin market —
  // one re-ask naming what was rejected (scaffolding, dupes, dead tickers).
  if (peers.length < 4) {
    console.warn(`Peer pick for ${args.ticker} kept only ${peers.length} — re-asking once.`);
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content:
        `Only ${peers.length} of those peers survived validation (${peers.map((p) => p.ticker).join(", ") || "none"}). ` +
        `The rest were unresolvable tickers, duplicates of the same company, or had scaffolding/filler text. ` +
        `Give the FULL corrected set of 4-6 real peers with real one-sentence rationales — every field written out, no filler.`,
    });
    const retry = await anthropic().messages.stream({ ...baseRequest, messages }).finalMessage();
    const retryText = retry.content.find((b) => b.type === "text");
    const retryParsed = JSON.parse(retryText && "text" in retryText ? retryText.text : "{}") as {
      peers?: SelectedPeer[];
    };
    const retryPeers = await validatePeers(args.ticker, retryParsed.peers ?? []);
    if (retryPeers.length > peers.length) peers = retryPeers;
  }
  return peers;
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
