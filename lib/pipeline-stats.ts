import { db } from "./db";

export interface PipelineStats {
  companiesScreened: number | null;
  notesDelivered: number | null;
  lastRunAt: string | null; // "06:31 CET" style
}

/**
 * Real numbers from the live pipeline for the landing page. Companies
 * screened = distinct symbols across the most recent day's screener responses
 * (shared FMP cache). Fails soft — the page renders without the strip.
 */
export async function getPipelineStats(): Promise<PipelineStats> {
  try {
    const [{ data: screens }, { count: delivered }, { data: lastMemo }] = await Promise.all([
      db()
        .from("fmp_cache")
        .select("cache_key, payload")
        .like("cache_key", "company-screener%")
        .order("fetched_at", { ascending: false })
        .limit(30),
      db().from("memos").select("id", { count: "exact", head: true }).not("sent_at", "is", null),
      db()
        .from("memos")
        .select("sent_at")
        .not("sent_at", "is", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    // Dedupe symbols across the latest day's screens only.
    const latestDay = screens?.[0]?.cache_key.match(/:(\d{4}-\d{2}-\d{2})$/)?.[1];
    const symbols = new Set<string>();
    for (const row of screens ?? []) {
      if (latestDay && !row.cache_key.endsWith(`:${latestDay}`)) continue;
      const payload = row.payload as { symbol?: string }[] | null;
      if (!Array.isArray(payload)) continue;
      for (const r of payload) if (r?.symbol) symbols.add(r.symbol);
    }

    const lastRunAt = lastMemo?.sent_at
      ? new Date(lastMemo.sent_at).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Zurich",
        }) + " CET"
      : null;

    return {
      companiesScreened: symbols.size > 0 ? symbols.size : null,
      notesDelivered: delivered ?? null,
      lastRunAt,
    };
  } catch (e) {
    console.error("Pipeline stats failed:", e);
    return { companiesScreened: null, notesDelivered: null, lastRunAt: null };
  }
}
