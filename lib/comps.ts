import type { TickerData, PeerComp } from "./fmp";
import { buildSnapshot } from "./figures";

/** One row of the comps table — the company itself first, then peers. */
export interface CompsRow {
  label: string;
  self: boolean;
  pe: string;
  evEbitda: string;
  pb: string;
  ps: string;
}

function fmtX(v: number | null): string {
  if (v === null || v <= 0 || v > 500) return "—";
  return `${v.toFixed(1)}x`;
}

/**
 * Deterministic peer-comparison table: the context that turns "cheap at
 * 1.6x" into an argument. The self row reads the SAME fresh-price snapshot
 * as every other figure in the note (lib/figures.ts); peers carry FMP's
 * daily-refreshed TTM multiples. Returns [] when the peer set is too thin
 * to be honest (fewer than two peers with any multiple).
 */
export function buildCompsRows(ticker: string, data: TickerData): CompsRow[] {
  const peers = (data.peers ?? []) as PeerComp[];
  const s = buildSnapshot(data);

  const selfRow: CompsRow = {
    label: ticker,
    self: true,
    pe: fmtX(s.pe),
    evEbitda: fmtX(s.evEbitda),
    pb: fmtX(s.pb),
    ps: fmtX(s.ps),
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
