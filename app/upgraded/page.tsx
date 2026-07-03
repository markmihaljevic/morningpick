export const metadata = {
  title: "Welcome to The Desk — Morningpick",
  robots: { index: false, follow: false },
};

function SunMark({ className = "" }: { className?: string }) {
  return <div className={`h-[10px] w-[20px] rounded-t-full bg-[#B08C3D] ${className}`} />;
}

/** Stripe checkout success landing — one message, back to the inbox. */
export default function UpgradedPage() {
  return (
    <main className="flex min-h-screen flex-col bg-[#0B1622] font-sans text-[#FBFAF6]">
      <nav className="border-b border-white/10">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <a href="/" className="flex items-end gap-2.5">
            <SunMark className="mb-[3px]" />
            <span className="text-[15px] tracking-[0.3em]">
              MORNING<span className="font-bold">PICK</span>
            </span>
          </a>
        </div>
      </nav>
      <div className="mx-auto flex w-full max-w-6xl flex-1 items-center px-6">
        <div className="max-w-xl py-20">
          <p className="font-mono text-[11px] tracking-[0.25em] text-[#B08C3D]">THE DESK</p>
          <h1 className="mt-3 text-[36px] leading-tight font-bold tracking-tight">
            You're on the daily desk.
          </h1>
          <p className="mt-4 text-[16px] leading-relaxed text-[#8FA0B0]">
            Your next research note arrives tomorrow morning — and every weekday morning after
            that. Reply to any note with questions and your analyst researches the answer in
            thread. A billing link lives in the footer of every email.
          </p>
          <p className="mt-6 font-mono text-[11px] tracking-[0.2em] text-[#5C7183]">
            NOTHING ELSE TO SET UP. SEE YOU IN THE INBOX.
          </p>
        </div>
      </div>
    </main>
  );
}
