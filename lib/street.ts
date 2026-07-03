import type { TickerData } from "./fmp";

export interface StreetItem {
  label: string;
  value: string;
}

function first<T>(v: unknown): T | undefined {
  return (Array.isArray(v) ? v[0] : v) as T | undefined;
}

/**
 * Deterministic "what the Street thinks" line for the email/PDF header area:
 * rating consensus, average target vs price, next earnings date, recent
 * beat/miss record. Omitted entirely when coverage is missing (non-US names).
 */
export function buildStreetItems(data: TickerData): StreetItem[] {
  const items: StreetItem[] = [];
  const quote = first<{ price?: number }>(data.quote);
  const price = typeof quote?.price === "number" ? quote.price : null;

  const ratings = first<{
    strongBuy?: number;
    buy?: number;
    hold?: number;
    sell?: number;
    strongSell?: number;
    consensus?: string;
  }>(data.street?.ratings);
  if (ratings?.consensus) {
    const buys = (ratings.strongBuy ?? 0) + (ratings.buy ?? 0);
    const holds = ratings.hold ?? 0;
    const sells = (ratings.sell ?? 0) + (ratings.strongSell ?? 0);
    const total = buys + holds + sells;
    if (total > 0) {
      items.push({
        label: "Street rating",
        value: `${ratings.consensus} (${buys}B/${holds}H/${sells}S)`,
      });
    }
  }

  const targets = first<{ targetConsensus?: number }>(data.street?.priceTargets);
  if (typeof targets?.targetConsensus === "number" && targets.targetConsensus > 0 && price) {
    const upside = ((targets.targetConsensus - price) / price) * 100;
    items.push({
      label: "Avg target",
      value: `${targets.targetConsensus >= 100 ? targets.targetConsensus.toFixed(0) : targets.targetConsensus.toFixed(1)} (${upside >= 0 ? "+" : ""}${upside.toFixed(0)}%)`,
    });
  }

  const earnings = Array.isArray(data.street?.earnings)
    ? (data.street.earnings as { date?: string; epsActual?: number | null; epsEstimated?: number | null }[])
    : [];
  const today = new Date().toISOString().slice(0, 10);
  const next = earnings
    .filter((e) => e.date && e.date >= today && e.epsActual == null)
    .sort((a, b) => (a.date! < b.date! ? -1 : 1))[0];
  if (next?.date) {
    const d = new Date(next.date + "T00:00:00Z");
    items.push({
      label: "Next earnings",
      value: d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }),
    });
  }

  const past = earnings
    .filter((e) => e.epsActual != null && e.epsEstimated != null)
    .sort((a, b) => (a.date! > b.date! ? -1 : 1))
    .slice(0, 4);
  if (past.length >= 2) {
    const marks = past
      .reverse()
      .map((e) => (Number(e.epsActual) >= Number(e.epsEstimated) ? "✓" : "✗"))
      .join(" ");
    items.push({ label: `EPS last ${past.length}q`, value: marks });
  }

  return items;
}
