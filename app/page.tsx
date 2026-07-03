import { SignupForm } from "./signup-form";

export const metadata = {
  title: "Morningpick — one investment idea, every morning",
  description:
    "A daily AI-generated investment memo, personalized to your investment philosophy. Reply to teach it what you like.",
};

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f6f5f1] text-[#1e222a]">
      <div className="mx-auto max-w-2xl px-6 py-20 font-serif">
        <p className="font-sans text-xs tracking-[0.25em] text-[#8a8578]">MORNINGPICK</p>
        <h1 className="mt-6 text-4xl leading-tight sm:text-5xl">
          One investment idea.
          <br />
          Every morning.
          <br />
          <em className="text-[#b0532a]">Written for you.</em>
        </h1>
        <p className="mt-8 text-lg leading-relaxed">
          Each morning you get a single stock pitch — thesis, valuation, risks, catalysts —
          researched with live market data and written by AI for <em>your</em> investment style.
        </p>
        <p className="mt-4 text-lg leading-relaxed">
          Don&apos;t like the pick? <strong>Just reply to the email.</strong>{" "}&ldquo;More European
          small caps.&rdquo; &ldquo;Less tech.&rdquo; &ldquo;I&apos;m a deep value contrarian.&rdquo;
          Tomorrow&apos;s memo listens.
        </p>
        <div className="mt-10">
          <SignupForm />
        </div>
        <div className="mt-16 border-t border-[#ddd8cc] pt-6 font-sans text-xs leading-relaxed text-[#8a8578]">
          <p>
            Not investment advice. Memos are AI-generated, for informational and entertainment
            purposes only, and may contain errors. Do your own research. Free — unsubscribe with
            one click, any time.
          </p>
        </div>
      </div>
    </main>
  );
}
