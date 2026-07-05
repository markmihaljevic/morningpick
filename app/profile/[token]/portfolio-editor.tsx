"use client";

import { useState } from "react";

interface Holding {
  ticker: string;
  name: string | null;
  note: string | null;
}

/** The one editable thing on the file: what the subscriber actually owns. */
export function PortfolioEditor({ token, initial }: { token: string; initial: Holding[] }) {
  const [holdings, setHoldings] = useState<Holding[]>(initial);
  const [ticker, setTicker] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticker.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/profile/${token}/portfolio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, note: note.trim() || undefined }),
      });
      const body = (await res.json()) as { ok?: boolean; holding?: Holding; error?: string };
      if (!res.ok || !body.holding) {
        setError(body.error ?? "Couldn't add that one.");
      } else {
        setHoldings((h) => [...h.filter((x) => x.ticker !== body.holding!.ticker), body.holding!]);
        setTicker("");
        setNote("");
      }
    } catch {
      setError("Couldn't reach the desk — try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: string) => {
    setHoldings((h) => h.filter((x) => x.ticker !== t));
    await fetch(`/api/profile/${token}/portfolio`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker: t }),
    }).catch(() => {});
  };

  return (
    <div>
      {holdings.length > 0 ? (
        <table className="mb-4 w-full border-collapse">
          <tbody>
            {holdings.map((h) => (
              <tr key={h.ticker} className="border-t border-[#E4E0D5]">
                <td className="w-[110px] py-2 pr-3 font-mono text-[12px] font-bold">{h.ticker}</td>
                <td className="py-2 pr-3 text-[13.5px] text-[#3D4A56]">
                  {h.name ?? ""}
                  {h.note ? (
                    <span className="text-[#9AA3AB]">
                      {h.name ? " — " : ""}
                      {h.note}
                    </span>
                  ) : null}
                </td>
                <td className="w-[70px] py-2 text-right">
                  <button
                    onClick={() => remove(h.ticker)}
                    className="font-mono text-[10px] tracking-[1px] text-[#9AA3AB] hover:text-[#9B3D3D]"
                  >
                    REMOVE
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mb-4 text-[14px] italic text-[#9AA3AB]">Nothing here yet.</p>
      )}

      <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row">
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          placeholder="Ticker (e.g. GENL.L)"
          className="w-full border border-[#E4E0D5] px-3 py-2 font-mono text-[13px] outline-none focus:border-[#10202F] sm:w-[160px]"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (e.g. core position since 2024)"
          className="flex-1 border border-[#E4E0D5] px-3 py-2 font-sans text-[13px] outline-none focus:border-[#10202F]"
        />
        <button
          type="submit"
          disabled={busy}
          className="border border-[#10202F] px-4 py-2 font-mono text-[11px] tracking-[1.5px] hover:bg-[#10202F] hover:text-white disabled:opacity-50"
        >
          {busy ? "…" : "ADD"}
        </button>
      </form>
      {error && <p className="mt-2 font-mono text-[11px] text-[#9B3D3D]">{error}</p>}
    </div>
  );
}
