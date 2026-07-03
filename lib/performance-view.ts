export interface PickRow {
  delivery_date: string;
  ticker: string;
  company_name: string | null;
  title: string | null;
  pitch_price: number | null;
  pitch_currency: string | null;
  last_price: number | null;
  last_price_at: string | null;
  return_pct: number | null;
}

export interface PerformanceSummary {
  total: number;
  marked: number;
  avgReturn: number | null;
  winRate: number | null;
  best: PickRow | null;
  worst: PickRow | null;
}

export function summarize(picks: PickRow[]): PerformanceSummary {
  const marked = picks.filter((p) => p.return_pct !== null);
  if (marked.length === 0) {
    return { total: picks.length, marked: 0, avgReturn: null, winRate: null, best: null, worst: null };
  }
  const returns = marked.map((p) => Number(p.return_pct));
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const winners = returns.filter((r) => r > 0).length;
  const sorted = [...marked].sort((a, b) => Number(b.return_pct) - Number(a.return_pct));
  return {
    total: picks.length,
    marked: marked.length,
    avgReturn,
    winRate: (winners / marked.length) * 100,
    best: sorted[0],
    worst: sorted[sorted.length - 1],
  };
}

export function fmtReturn(pct: number | null): string {
  if (pct === null) return "—";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function fmtPrice(price: number | null, currency: string | null): string {
  if (price === null) return "—";
  const p = Number(price);
  const formatted = p >= 100 ? p.toFixed(0) : p.toFixed(2);
  return currency ? `${formatted} ${currency}` : formatted;
}

export function returnColor(pct: number | null): string {
  if (pct === null) return "#8a8578";
  return pct >= 0 ? "#2e7d4f" : "#b0532a";
}
