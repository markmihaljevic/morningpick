import { db } from "@/lib/db";
import {
  summarize,
  fmtReturn,
  fmtPrice,
  returnColor,
  type PickRow,
} from "@/lib/performance-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Track record — Morningpick",
  description:
    "Every stock idea Morningpick has ever sent, marked to market nightly. Full accountability, nothing hidden.",
};

export default async function TrackRecordPage() {
  // Anonymized: all sent picks across subscribers, no subscriber data selected.
  const { data: picks } = await db()
    .from("memos")
    .select(
      "delivery_date, ticker, company_name, title, pitch_price, pitch_currency, last_price, last_price_at, return_pct",
    )
    .not("sent_at", "is", null)
    .order("delivery_date", { ascending: false })
    .limit(500);

  const rows = (picks ?? []) as PickRow[];
  const summary = summarize(rows);
  const lastMarked = rows.find((r) => r.last_price_at)?.last_price_at;

  return (
    <main className="min-h-screen bg-[#f6f5f1] text-[#1e222a]">
      <div className="mx-auto max-w-3xl px-6 py-16 font-serif">
        <p className="font-sans text-xs tracking-[0.25em] text-[#8a8578]">
          <a href="/">MORNINGPICK</a>
        </p>
        <h1 className="mt-4 text-3xl">Track record</h1>
        <p className="mt-3 text-lg leading-relaxed">
          Every idea we&apos;ve ever sent, marked to market nightly. No cherry-picking, no memory
          hole — losers stay on the board.
        </p>

        {summary.marked > 0 && (
          <div className="mt-8 grid grid-cols-3 gap-4 font-sans">
            <div className="border border-[#ddd8cc] bg-white/50 p-4">
              <p className="text-xs tracking-wider text-[#8a8578]">AVG RETURN / PICK</p>
              <p className="mt-1 text-2xl" style={{ color: returnColor(summary.avgReturn) }}>
                {fmtReturn(summary.avgReturn)}
              </p>
            </div>
            <div className="border border-[#ddd8cc] bg-white/50 p-4">
              <p className="text-xs tracking-wider text-[#8a8578]">WIN RATE</p>
              <p className="mt-1 text-2xl">{summary.winRate?.toFixed(0)}%</p>
            </div>
            <div className="border border-[#ddd8cc] bg-white/50 p-4">
              <p className="text-xs tracking-wider text-[#8a8578]">IDEAS SENT</p>
              <p className="mt-1 text-2xl">{summary.total}</p>
            </div>
          </div>
        )}

        <div className="mt-8 overflow-x-auto">
          <table className="w-full border-collapse font-sans text-sm">
            <thead>
              <tr className="border-b border-[#1e222a] text-left text-xs tracking-wider text-[#8a8578]">
                <th className="py-2 pr-4">DATE</th>
                <th className="py-2 pr-4">PICK</th>
                <th className="py-2 pr-4 text-right">AT PITCH</th>
                <th className="py-2 pr-4 text-right">NOW</th>
                <th className="py-2 text-right">RETURN</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={i} className="border-b border-[#ddd8cc]">
                  <td className="py-3 pr-4 whitespace-nowrap text-[#8a8578]">{p.delivery_date}</td>
                  <td className="py-3 pr-4">
                    <span className="font-semibold">{p.ticker}</span>
                    {p.company_name && <span className="text-[#8a8578]"> · {p.company_name}</span>}
                  </td>
                  <td className="py-3 pr-4 text-right whitespace-nowrap">
                    {fmtPrice(p.pitch_price, p.pitch_currency)}
                  </td>
                  <td className="py-3 pr-4 text-right whitespace-nowrap">
                    {fmtPrice(p.last_price, p.pitch_currency)}
                  </td>
                  <td
                    className="py-3 text-right font-semibold whitespace-nowrap"
                    style={{ color: returnColor(p.return_pct === null ? null : Number(p.return_pct)) }}
                  >
                    {fmtReturn(p.return_pct === null ? null : Number(p.return_pct))}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-[#8a8578]">
                    The record starts with tomorrow&apos;s picks.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-6 font-sans text-xs text-[#8a8578]">
          {lastMarked && <>Last marked: {new Date(lastMarked).toISOString().slice(0, 10)}. </>}
          Returns are simple price returns in each stock&apos;s listing currency since the morning
          the idea was sent. Ideas are personalized per subscriber; the same day can contain
          multiple picks.
        </p>

        <div className="mt-10">
          <a
            href="/"
            className="inline-block bg-[#1e222a] px-6 py-3 font-sans text-sm tracking-widest text-[#f6f5f1]"
          >
            GET TOMORROW&apos;S PICK →
          </a>
        </div>

        <p className="mt-12 border-t border-[#ddd8cc] pt-4 font-sans text-xs leading-relaxed text-[#8a8578]">
          Not investment advice. Memos are AI-generated, for informational and entertainment
          purposes only, and may contain errors. Past performance does not predict future results.
        </p>
      </div>
    </main>
  );
}
