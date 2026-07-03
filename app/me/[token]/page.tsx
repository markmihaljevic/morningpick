import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { MemoDeck, type DeckMemo } from "./memo-deck";
import { RememberMe } from "./remember-me";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your research desk — Morningpick",
  robots: { index: false, follow: false },
};

function SunMark({ className = "" }: { className?: string }) {
  return <div className={`h-[10px] w-[20px] rounded-t-full bg-[#B08C3D] ${className}`} />;
}

interface MemoRow {
  id: string;
  ticker: string;
  company_name: string | null;
  title: string;
  delivery_date: string;
  kind: string | null;
  sent_at: string | null;
  extras: {
    meta?: { one_liner?: string; conviction?: number; horizon?: string; style_tags?: string[] };
    stats?: { label: string; value: string }[];
    dateLine?: string;
  } | null;
}

export default async function DeskPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(token)) notFound();

  const { data: subscriber } = await db()
    .from("subscribers")
    .select("id, email, status, created_at")
    .eq("portal_token", token)
    .single();
  if (!subscriber) notFound();

  const { data: memoRows } = await db()
    .from("memos")
    .select("id, ticker, company_name, title, delivery_date, kind, sent_at, extras")
    .eq("subscriber_id", subscriber.id)
    .not("sent_at", "is", null)
    .order("delivery_date", { ascending: false })
    .limit(60);

  const memos: DeckMemo[] = ((memoRows ?? []) as MemoRow[]).map((m) => ({
    id: m.id,
    ticker: m.ticker,
    companyName: m.company_name,
    title: m.title,
    dateLine:
      m.extras?.dateLine ??
      new Date(m.delivery_date + "T00:00:00Z").toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }),
    kind: m.kind === "followup" ? "FOLLOW-UP" : "RESEARCH NOTE",
    oneLiner: m.extras?.meta?.one_liner ?? null,
    conviction: m.extras?.meta?.conviction ?? null,
    horizon: m.extras?.meta?.horizon ?? null,
    styleTags: m.extras?.meta?.style_tags ?? [],
    stats: (m.extras?.stats ?? []).slice(0, 6),
    pdfUrl: `/api/memo/${m.id}/pdf`,
  }));

  const name = subscriber.email.split("@")[0];
  const since = new Date(subscriber.created_at).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });

  return (
    <main className="min-h-screen bg-[#0B1622] font-sans text-[#FBFAF6]">
      <RememberMe token={token} />

      {/* Nav */}
      <nav className="border-b border-white/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <a href="/" className="flex items-end gap-2.5">
            <SunMark className="mb-[3px]" />
            <span className="text-[15px] tracking-[0.3em]">
              MORNING<span className="font-bold">PICK</span>
            </span>
          </a>
          <span className="font-mono text-[10px] tracking-[0.2em] text-[#5C7183]">
            PRIVATE DESK · {subscriber.email.toUpperCase()}
          </span>
        </div>
      </nav>

      {/* Header */}
      <div className="mx-auto max-w-6xl px-6 pt-14 pb-10">
        <p className="font-mono text-[11px] tracking-[0.25em] text-[#B08C3D]">
          YOUR RESEARCH DESK
        </p>
        <h1 className="mt-3 text-[34px] leading-tight font-bold tracking-tight sm:text-[44px]">
          Good morning, {name}.
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-[#8FA0B0]">
          Every note your analyst has written for you since {since} — flip through them below.
          Reply to any morning email to refine what lands here next.
        </p>
      </div>

      {/* Deck */}
      <div className="mx-auto max-w-6xl px-6 pb-24">
        {memos.length > 0 ? (
          <MemoDeck memos={memos} />
        ) : (
          <div className="max-w-md border border-white/10 p-8">
            <p className="font-mono text-[11px] tracking-[0.2em] text-[#B08C3D]">
              NO NOTES YET
            </p>
            <p className="mt-3 text-[14px] leading-relaxed text-[#8FA0B0]">
              Your first research note arrives with the next morning run. It will appear here the
              moment it is sent.
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6">
          <span className="font-mono text-[10px] tracking-[0.15em] text-[#5C7183]">
            NOT INVESTMENT ADVICE · AI-GENERATED RESEARCH · DO YOUR OWN WORK
          </span>
          <span className="font-mono text-[10px] tracking-[0.15em] text-[#5C7183]">
            THIS LINK IS PRIVATE TO YOU
          </span>
        </div>
      </footer>
    </main>
  );
}
