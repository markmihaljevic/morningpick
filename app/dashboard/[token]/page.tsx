import { db } from "@/lib/db";
import {
  summarize,
  fmtReturn,
  fmtPrice,
  returnColor,
  type PickRow,
} from "@/lib/performance-view";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your picks — Morningpick",
  robots: { index: false, follow: false },
};

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const { data: subscriber } = await db()
    .from("subscribers")
    .select("id, email, status, preference_profiles(philosophy)")
    .eq("portal_token", token)
    .maybeSingle();

  if (!subscriber) {
    return (
      <main className="min-h-screen bg-[#f6f5f1] text-[#1e222a]">
        <div className="mx-auto max-w-2xl px-6 py-24 font-serif">
          <p className="font-sans text-xs tracking-[0.25em] text-[#8a8578]">MORNINGPICK</p>
          <h1 className="mt-6 text-4xl">That link isn&apos;t valid.</h1>
          <p className="mt-6 text-lg">
            Use the &ldquo;View your picks&rdquo; link from any Morningpick email.
          </p>
        </div>
      </main>
    );
  }

  const { data: picks } = await db()
    .from("memos")
    .select(
      "delivery_date, ticker, company_name, title, pitch_price, pitch_currency, last_price, last_price_at, return_pct",
    )
    .eq("subscriber_id", subscriber.id)
    .not("sent_at", "is", null)
    .order("delivery_date", { ascending: false });

  const rows = (picks ?? []) as PickRow[];
  const summary = summarize(rows);
  const profileRow = Array.isArray(subscriber.preference_profiles)
    ? subscriber.preference_profiles[0]
    : subscriber.preference_profiles;
  const philosophy = (profileRow?.philosophy as string) ?? "";

  return (
    <main className="min-h-screen bg-[#f6f5f1] text-[#1e222a]">
      <div className="mx-auto max-w-3xl px-6 py-16 font-serif">
        <p className="font-sans text-xs tracking-[0.25em] text-[#8a8578]">MORNINGPICK</p>
        <h1 className="mt-4 text-3xl">Your picks</h1>
        <p className="mt-2 font-sans text-sm text-[#8a8578]">{subscriber.email}</p>

        {summary.marked > 0 && (
          <div className="mt-8 grid grid-cols-2 gap-4 font-sans sm:grid-cols-4">
            <div className="border border-[#ddd8cc] bg-white/50 p-4">
              <p className="text-xs tracking-wider text-[#8a8578]">AVG RETURN</p>
              <p className="mt-1 text-2xl" style={{ color: returnColor(summary.avgReturn) }}>
                {fmtReturn(summary.avgReturn)}
              </p>
            </div>
            <div className="border border-[#ddd8cc] bg-white/50 p-4">
              <p className="text-xs tracking-wider text-[#8a8578]">WIN RATE</p>
              <p className="mt-1 text-2xl">{summary.winRate?.toFixed(0)}%</p>
            </div>
            <div className="border border-[#ddd8cc] bg-white/50 p-4">
              <p className="text-xs tracking-wider text-[#8a8578]">BEST</p>
              <p className="mt-1 text-2xl text-[#2e7d4f]">
                {summary.best ? `${summary.best.ticker}` : "—"}
              </p>
              <p className="text-xs text-[#8a8578]">{fmtReturn(summary.best?.return_pct ?? null)}</p>
            </div>
            <div className="border border-[#ddd8cc] bg-white/50 p-4">
              <p className="text-xs tracking-wider text-[#8a8578]">PICKS</p>
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
              {rows.map((p) => (
                <tr key={`${p.ticker}-${p.delivery_date}`} className="border-b border-[#ddd8cc]">
                  <td className="py-3 pr-4 whitespace-nowrap text-[#8a8578]">{p.delivery_date}</td>
                  <td className="py-3 pr-4">
                    <span className="font-semibold">{p.ticker}</span>
                    {p.company_name && (
                      <span className="text-[#8a8578]"> · {p.company_name}</span>
                    )}
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
                    Your first pick arrives tomorrow morning.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {philosophy && (
          <div className="mt-12">
            <p className="font-sans text-xs tracking-[0.2em] text-[#8a8578]">
              WHAT MORNINGPICK KNOWS ABOUT YOUR STYLE
            </p>
            <p className="mt-3 text-lg leading-relaxed italic">{philosophy}</p>
            <p className="mt-3 font-sans text-sm text-[#8a8578]">
              To refine this, just reply to any memo email.
            </p>
          </div>
        )}

        <p className="mt-12 border-t border-[#ddd8cc] pt-4 font-sans text-xs leading-relaxed text-[#8a8578]">
          Returns are simple price returns in each stock&apos;s listing currency since the morning
          the idea was sent, marked nightly. Not investment advice — memos are AI-generated and
          for informational purposes only.
        </p>
      </div>
    </main>
  );
}
