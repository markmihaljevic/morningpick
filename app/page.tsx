import { SignupForm } from "./signup-form";
import { getPipelineStats } from "@/lib/pipeline-stats";

export const revalidate = 3600;

export const metadata = {
  title: "Morningpick — your AI research analyst",
  description:
    "One institutional-grade investment research note every morning — screened across global exchanges, fact-checked against live data, personalized to your philosophy.",
};

function SunMark({ className = "" }: { className?: string }) {
  return <div className={`h-[10px] w-[20px] rounded-t-full bg-[#B08C3D] ${className}`} />;
}

/** The product artifact: a real research note (Genel Energy, 3 July 2026). */
function MemoArtifact() {
  const stats = [
    ["PRICE", "55.90 GBp"],
    ["MKT CAP", "$155M"],
    ["P/E", "3.5x"],
    ["P/B", "0.4x"],
    ["EV/EBITDA", "0.9x"],
    ["FCF YIELD", "23.9%"],
  ];
  return (
    <div className="relative">
      {/* PDF sheet peeking behind */}
      <div className="absolute -right-3 top-4 hidden h-full w-full rotate-2 rounded-sm bg-[#e8e4d8] shadow-xl lg:block" />
      <div className="relative rounded-sm bg-[#FBFAF6] text-[#10202F] shadow-2xl">
        <div className="flex items-center justify-between rounded-t-sm border-b-2 border-[#B08C3D] bg-[#10202F] px-5 py-3">
          <span className="font-sans text-[11px] tracking-[0.3em] text-[#FBFAF6]">
            MORNING<span className="font-bold">PICK</span>
          </span>
          <span className="font-mono text-[9px] tracking-widest text-[#8FA0B0]">3 JULY 2026</span>
        </div>
        <div className="px-5 py-4">
          <p className="font-mono text-[8px] tracking-[0.2em] text-[#5C6670]">
            PRIVATE RESEARCH NOTE · PREPARED FOR YOU
          </p>
          <h3 className="mt-2 font-serif text-[19px] leading-snug font-bold">
            GENL.L — An Iraqi-Kurdistan cash machine the market prices as a going-concern risk
          </h3>
          <div className="mt-3 grid grid-cols-3 gap-px border border-[#E4E0D5] bg-[#E4E0D5]">
            {stats.map(([label, value]) => (
              <div key={label} className="bg-white px-2.5 py-1.5">
                <p className="font-mono text-[7px] tracking-wider text-[#5C6670]">{label}</p>
                <p className="font-sans text-[12px] font-bold">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-3.5 font-serif text-[13px] leading-relaxed">
            <strong>The idea</strong> — Genel trades below net cash with Kurdistan exports
            restarting, a 23.9% free-cash-flow yield, and a balance sheet the market refuses to
            believe. The bear case is priced as permanent; the upside needs only normalcy…
          </p>
          <p className="mt-2.5 font-serif text-[13px] leading-relaxed text-[#5C6670]">
            <strong className="text-[#10202F]">Why now</strong> — Pipeline flows resumed in June
            and the first payment cycle confirmed
          </p>
        </div>
        <div className="rounded-b-sm bg-gradient-to-b from-transparent to-[#FBFAF6] px-5 pb-4">
          <div className="flex items-center justify-between border-t border-[#E4E0D5] pt-3">
            <span className="font-mono text-[8px] tracking-widest text-[#5C6670]">
              FACT-CHECKED ✓ · 5Y CHART · SOURCES · PDF
            </span>
            <span className="font-mono text-[8px] tracking-widest text-[#B08C3D]">
              REPLY TO REFINE →
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default async function Home() {
  const stats = await getPipelineStats();
  const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"));

  return (
    <main className="min-h-screen bg-[#0B1622] font-sans text-[#FBFAF6]">
      {/* Nav */}
      <nav className="border-b border-white/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-end gap-2.5">
            <SunMark className="mb-[3px]" />
            <span className="text-[15px] tracking-[0.3em]">
              MORNING<span className="font-bold">PICK</span>
            </span>
          </div>
          <a
            href="#subscribe"
            className="border border-[#B08C3D] px-4 py-1.5 font-mono text-[11px] tracking-[0.15em] text-[#B08C3D] transition-colors hover:bg-[#B08C3D] hover:text-[#0B1622]"
          >
            GET THE NOTE
          </a>
        </div>
      </nav>

      {/* Hero */}
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 pt-16 pb-12 lg:grid-cols-[1.05fr_0.95fr] lg:pt-24">
        <div>
          <p className="font-mono text-[11px] tracking-[0.25em] text-[#B08C3D]">
            YOUR AI RESEARCH ANALYST
          </p>
          <h1 className="mt-4 text-[42px] leading-[1.05] font-bold tracking-tight sm:text-[56px]">
            One institutional-grade stock idea.
            <br />
            <span className="text-[#8FA0B0]">In your inbox, every morning.</span>
          </h1>
          <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-[#c9cfd6]">
            Morningpick screens thousands of companies across global exchanges overnight, selects
            the one that fits <em className="not-italic font-semibold text-[#FBFAF6]">your</em>{" "}
            investment philosophy, writes the research note, and fact-checks every figure — before
            you&apos;ve had coffee.
          </p>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-[#8FA0B0]">
            Don&apos;t like the pick? Reply to the email in plain English. Tomorrow&apos;s analyst
            remembers.
          </p>

          <div id="subscribe" className="mt-8">
            <SignupForm />
          </div>

          {/* Live pipeline strip */}
          <div className="mt-10 border-t border-white/10 pt-5">
            <p className="font-mono text-[10px] tracking-[0.2em] text-[#5C6670]">
              LIVE FROM THIS MORNING&apos;S RUN
            </p>
            <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3 font-mono text-[12px] tracking-wider">
              <span>
                <span className="text-[18px] font-semibold text-[#B08C3D] tabular-nums">
                  {fmt(stats.companiesScreened)}
                </span>{" "}
                <span className="text-[#8FA0B0]">COMPANIES SCREENED</span>
              </span>
              <span>
                <span className="text-[18px] font-semibold text-[#B08C3D] tabular-nums">25</span>{" "}
                <span className="text-[#8FA0B0]">SHORTLISTED / READER</span>
              </span>
              <span>
                <span className="text-[18px] font-semibold text-[#B08C3D] tabular-nums">1</span>{" "}
                <span className="text-[#8FA0B0]">SELECTED</span>
              </span>
              {stats.lastRunAt && (
                <span className="text-[#5C6670]">LAST RUN {stats.lastRunAt}</span>
              )}
            </div>
          </div>
        </div>

        <MemoArtifact />
      </div>

      {/* Pipeline strip */}
      <div className="border-t border-white/10 bg-[#10202F]">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["01 / SCREEN", "Profile-derived screens sweep the US, Europe, UK, Canada, Australia and Asia — down to micro caps."],
            ["02 / SELECT", "Thousands of candidates, one shortlist, one pick — argued on real valuation data, not vibes."],
            ["03 / VERIFY", "A second model audits every figure in the note against the source data before it can send."],
            ["04 / LEARN", "Your replies update a persistent profile. The analyst never forgets what you told it."],
          ].map(([label, body]) => (
            <div key={label}>
              <p className="font-mono text-[11px] tracking-[0.2em] text-[#B08C3D]">{label}</p>
              <p className="mt-2.5 text-[14px] leading-relaxed text-[#8FA0B0]">{body}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Pricing */}
      <div id="pricing" className="mx-auto max-w-6xl px-6 py-20">
        <p className="font-mono text-[11px] tracking-[0.25em] text-[#B08C3D]">PLANS</p>
        <h2 className="mt-3 text-[30px] font-bold tracking-tight sm:text-[38px]">
          Start with Monday. Upgrade to every morning.
        </h2>
        <div className="mt-10 grid max-w-4xl gap-6 sm:grid-cols-2">
          <div className="border border-white/15 p-8">
            <p className="font-mono text-[11px] tracking-[0.2em] text-[#8FA0B0]">THE MONDAY NOTE</p>
            <p className="mt-4 text-[34px] font-bold">
              Free<span className="ml-2 text-[14px] font-normal text-[#8FA0B0]">forever</span>
            </p>
            <ul className="mt-6 space-y-2.5 text-[14px] leading-relaxed text-[#8FA0B0]">
              <li>One research note every Monday</li>
              <li>Personalized to your philosophy</li>
              <li>Fact-checked, chart, sources, PDF</li>
              <li>Replies still teach your analyst</li>
            </ul>
            <a
              href="#subscribe"
              className="mt-8 inline-block border border-white/25 px-5 py-2 font-mono text-[11px] tracking-[0.15em] text-[#FBFAF6] transition-colors hover:border-[#B08C3D] hover:text-[#B08C3D]"
            >
              START FREE
            </a>
          </div>
          <div className="border border-[#B08C3D] bg-[#10202F] p-8">
            <p className="font-mono text-[11px] tracking-[0.2em] text-[#B08C3D]">THE DESK</p>
            <p className="mt-4 text-[34px] font-bold">
              $99<span className="ml-2 text-[14px] font-normal text-[#8FA0B0]">/ month</span>
            </p>
            <ul className="mt-6 space-y-2.5 text-[14px] leading-relaxed text-[#8FA0B0]">
              <li>
                <span className="text-[#FBFAF6]">A fresh note every weekday morning</span>
              </li>
              <li>Reply with questions — researched answers, in thread</li>
              <li>Follow-ups when a covered name moves or reports</li>
              <li>The analyst reads filings and announcements in full</li>
            </ul>
            <a
              href="#subscribe"
              className="mt-8 inline-block border border-[#B08C3D] bg-[#B08C3D] px-5 py-2 font-mono text-[11px] tracking-[0.15em] text-[#0B1622] transition-colors hover:bg-transparent hover:text-[#B08C3D]"
            >
              SUBSCRIBE, THEN UPGRADE
            </a>
            <p className="mt-4 font-mono text-[10px] tracking-wide text-[#5C7183]">
              Subscribe free first — the upgrade link arrives with your note. MOI Global members:
              use your member email and the $49/mo partner rate applies automatically.
            </p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <p className="max-w-3xl font-mono text-[10px] leading-relaxed tracking-wide text-[#5C6670]">
            NOT INVESTMENT ADVICE. NOTES ARE AI-GENERATED, FOR INFORMATIONAL AND ENTERTAINMENT
            PURPOSES ONLY, AND MAY CONTAIN ERRORS. DO YOUR OWN RESEARCH. UNSUBSCRIBE WITH ONE
            CLICK, ANY TIME.
          </p>
        </div>
      </footer>
    </main>
  );
}
