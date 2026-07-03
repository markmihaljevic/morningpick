import type { TickerData, PeerComp } from "./fmp";

/** One row of the comps table — the company itself first, then peers. */
export interface CompsRow {
  label: string;
  self: boolean;
  pe: string;
  evEbitda: string;
  pb: string;
  ps: string;
}

function first<T>(v: unknown): T | undefined {
  return (Array.isArray(v) ? v[0] : v) as T | undefined;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtX(v: number | null): string {
  if (v === null || v <= 0 || v > 500) return "—";
  return `${v.toFixed(1)}x`;
}

/**
 * Deterministic peer-comparison table: the context that turns "cheap at
 * 1.6x" into an argument. Returns [] when the peer set is too thin to be
 * honest (fewer than two peers with any multiple).
 */
export function buildCompsRows(ticker: string, data: TickerData): CompsRow[] {
  const peers = (data.peers ?? []) as PeerComp[];
  const quote = first<Record<string, unknown>>(data.quote) ?? {};
  const ratios = first<Record<string, unknown>>(data.ratios) ?? {};

  const selfRow: CompsRow = {
    label: ticker,
    self: true,
    pe: fmtX(num(ratios.priceToEarningsRatio) ?? num(quote.pe)),
    evEbitda: fmtX(num(ratios.enterpriseValueMultiple)),
    pb: fmtX(num(ratios.priceToBookRatio)),
    ps: fmtX(num(ratios.priceToSalesRatio)),
  };

  const peerRows = peers
    .map((p) => ({
      label: p.symbol,
      self: false,
      pe: fmtX(p.pe),
      evEbitda: fmtX(p.evEbitda),
      pb: fmtX(p.pb),
      ps: fmtX(p.ps),
    }))
    .filter((r) => r.pe !== "—" || r.evEbitda !== "—" || r.pb !== "—");

  if (peerRows.length < 2) return [];
  return [selfRow, ...peerRows];
}
