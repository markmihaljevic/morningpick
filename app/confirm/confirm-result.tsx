export function ConfirmResult({ result }: { result: "confirmed" | "invalid" }) {
  return (
    <main className="min-h-screen bg-[#FBFAF6] text-[#10202F]">
      <div className="mx-auto max-w-2xl px-6 py-24 font-serif">
        <p className="font-sans text-xs tracking-[0.25em] text-[#5C6670]">MORNINGPICK</p>
        {result === "confirmed" ? (
          <>
            <h1 className="mt-6 text-4xl">You&apos;re in. ☕</h1>
            <p className="mt-6 text-lg leading-relaxed">
              Your first memo arrives tomorrow morning. We just sent you a welcome email —{" "}
              <strong>reply to it</strong> with a few sentences about your investment style and
              your very first memo will already be personalized.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-4xl">That link isn&apos;t valid.</h1>
            <p className="mt-6 text-lg leading-relaxed">
              It may have expired or already been used. You can{" "}
              <a href="/" className="underline">sign up again</a>.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
