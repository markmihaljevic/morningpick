import { SignupForm } from "./signup-form";

export const metadata = {
  title: "Morningpick — one investment idea, every morning",
  description:
    "A daily AI-generated investment research note, personalized to your investment philosophy. Reply to teach it what you like.",
};

function Wordmark() {
  return (
    <div>
      <div className="mb-1.5 h-[11px] w-[22px] rounded-t-full bg-[#B08C3D]" />
      <p className="font-sans text-lg tracking-[0.25em] text-[#FBFAF6]">
        MORNING<span className="font-bold">PICK</span>
      </p>
    </div>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen bg-[#FBFAF6] text-[#10202F]">
      {/* Masthead */}
      <div className="border-b-[3px] border-[#B08C3D] bg-[#10202F]">
        <div className="mx-auto flex max-w-2xl items-end justify-between px-6 py-5">
          <Wordmark />
          <p className="hidden font-sans text-[11px] tracking-[0.2em] text-[#8FA0B0] sm:block">
            ONE IDEA. EVERY MORNING.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-6 py-16 font-serif">
        <h1 className="text-4xl leading-tight sm:text-5xl">
          Your own research desk.
          <br />
          One idea, every morning.
        </h1>
        <p className="mt-8 text-lg leading-relaxed">
          Each morning you receive a single institutional-grade research note — thesis, valuation,
          risks, insider activity, catalysts — researched against live market data across global
          exchanges and written for <em>your</em> investment style.
        </p>
        <p className="mt-4 text-lg leading-relaxed">
          Don&apos;t like the pick? <strong>Just reply to the email.</strong>{" "}&ldquo;More European
          small caps.&rdquo; &ldquo;Less tech.&rdquo; &ldquo;I&apos;m a deep value
          contrarian.&rdquo; Tomorrow&apos;s note listens.
        </p>

        <div className="mt-10">
          <SignupForm />
        </div>

        <div className="mt-14 grid gap-6 border-t border-[#E4E0D5] pt-8 font-sans text-sm sm:grid-cols-3">
          <div>
            <p className="text-[11px] tracking-[0.2em] text-[#B08C3D]">GROUNDED</p>
            <p className="mt-2 leading-relaxed text-[#5C6670]">
              Every figure fact-checked against live market data before it reaches you.
            </p>
          </div>
          <div>
            <p className="text-[11px] tracking-[0.2em] text-[#B08C3D]">GLOBAL</p>
            <p className="mt-2 leading-relaxed text-[#5C6670]">
              Screens thousands of companies across the US, Europe, UK, Canada, Australia and Asia.
            </p>
          </div>
          <div>
            <p className="text-[11px] tracking-[0.2em] text-[#B08C3D]">YOURS</p>
            <p className="mt-2 leading-relaxed text-[#5C6670]">
              A preference profile that learns from every reply — like an analyst who never forgets.
            </p>
          </div>
        </div>

        <div className="mt-14 border-t border-[#E4E0D5] pt-6 font-sans text-xs leading-relaxed text-[#5C6670]">
          <p>
            Not investment advice. Notes are AI-generated, for informational and entertainment
            purposes only, and may contain errors. Do your own research. Free — unsubscribe with
            one click, any time.
          </p>
        </div>
      </div>
    </main>
  );
}
