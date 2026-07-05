import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getPortfolio } from "@/lib/portfolio";
import { PortfolioEditor } from "./portfolio-editor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "What I know about you — Morningpick",
  robots: { index: false, follow: false },
};

/**
 * The analyst's file card on one subscriber — shown to the subscriber.
 * Transparency is the feature: everything the analyst believes about you,
 * plus the one thing only you can maintain: what you actually own.
 * Letter aesthetic, one page, no navigation. Reached only from email.
 */
export default async function ProfilePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(token)) notFound();

  const { data: subscriber } = await db()
    .from("subscribers")
    .select("id, email, created_at, preference_profiles(structured, philosophy, updated_at)")
    .eq("portal_token", token)
    .single();
  if (!subscriber) notFound();

  const profileRow = Array.isArray(subscriber.preference_profiles)
    ? subscriber.preference_profiles[0]
    : subscriber.preference_profiles;
  const structured = (profileRow?.structured ?? {}) as Record<string, unknown>;
  const philosophy = (profileRow?.philosophy as string) ?? "";
  const holdings = await getPortfolio(subscriber.id);

  const listy = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" && v ? [v] : [];

  const prefRows: { label: string; values: string[] }[] = [
    { label: "Style", values: listy(structured.style) },
    { label: "Regions", values: listy(structured.regions_prefer) },
    { label: "Regions to avoid", values: listy(structured.regions_avoid) },
    { label: "Sectors", values: listy(structured.sectors_prefer) },
    { label: "Sectors to avoid", values: listy(structured.sectors_avoid) },
    { label: "Company size", values: listy(structured.market_cap_pref) },
    { label: "Risk appetite", values: listy(structured.risk_appetite) },
    { label: "Never pitch", values: listy(structured.avoid_tickers) },
  ].filter((r) => r.values.length > 0);
  const notes = listy(structured.other_notes);

  const updatedAt = profileRow?.updated_at
    ? new Date(profileRow.updated_at as string).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  return (
    <main className="min-h-screen bg-white text-[#10202F]">
      <div className="mx-auto max-w-[640px] px-5 py-10">
        {/* Letterhead */}
        <div className="border-b border-[#E4E0D5] pb-2.5">
          <div className="flex items-baseline justify-between">
            <a href="https://morningpick.ai" className="font-mono text-[11px] tracking-[3px]">
              MORNING<span className="font-bold">PICK</span>
            </a>
            <span className="font-mono text-[10px] tracking-[1.5px] text-[#5C6670]">
              THE ANALYST&apos;S FILE
            </span>
          </div>
          <p className="pt-1.5 font-mono text-[9px] tracking-[1.5px] text-[#5C6670]">
            PRIVATE — {subscriber.email.toUpperCase()}
          </p>
        </div>

        <div className="pt-7 font-serif text-[16px] leading-[1.7]">
          <p className="mb-4">Good morning,</p>
          <p className="mb-6">
            This is everything I currently know about how you invest — learned from your replies.
            If any of it is wrong, don&apos;t edit a form: just reply to any note and tell me. The
            one thing only you can keep accurate is the list of what you own, at the bottom.
          </p>

          <h3 className="mb-2 mt-7 text-[17px] font-bold">Your philosophy, in my words</h3>
          <p className="mb-2 italic text-[#3D4A56]">
            {philosophy || "I don't know you yet — reply to any note and tell me how you invest."}
          </p>
          {updatedAt && (
            <p className="mb-6 font-mono text-[10px] tracking-wide text-[#9AA3AB]">
              LAST REVISED {updatedAt.toUpperCase()}, FROM YOUR REPLIES
            </p>
          )}

          {prefRows.length > 0 && (
            <>
              <h3 className="mb-3 mt-7 text-[17px] font-bold">The particulars</h3>
              <table className="mb-2 w-full border-collapse">
                <tbody>
                  {prefRows.map((r) => (
                    <tr key={r.label} className="border-t border-[#E4E0D5]">
                      <td className="w-[170px] py-2 pr-4 align-top font-mono text-[10px] tracking-[1px] text-[#5C6670]">
                        {r.label.toUpperCase()}
                      </td>
                      <td className="py-2 text-[14.5px]">{r.values.join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {notes.length > 0 && (
            <>
              <h3 className="mb-2 mt-7 text-[17px] font-bold">Margin notes</h3>
              <ul className="mb-2 list-disc pl-5 text-[14.5px] text-[#3D4A56]">
                {notes.map((n, i) => (
                  <li key={i} className="mb-1.5">
                    {n}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="mb-2 mt-8 text-[17px] font-bold">What you own</h3>
          <p className="mb-4 text-[14.5px] text-[#3D4A56]">
            I will only ever say &quot;you hold this&quot; about names on this list — and I write
            with them in mind. Keep it honest and current; leave it empty if you&apos;d rather I
            not know.
          </p>
          <PortfolioEditor token={token} initial={holdings} />
        </div>

        {/* Fine print */}
        <div className="mt-10 border-t border-[#E4E0D5] pt-3.5">
          <p className="font-sans text-[10.5px] leading-[1.7] text-[#9AA3AB]">
            This page is private to you — anyone with this link can read it. Holdings are used
            only to write your notes; nothing here is investment advice.{" "}
            <a href="https://morningpick.ai" className="text-[#9AA3AB] underline">
              morningpick.ai
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
