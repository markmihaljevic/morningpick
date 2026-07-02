export function UnsubscribeResult({ done }: { done: boolean }) {
  return (
    <main className="min-h-screen bg-[#f6f5f1] text-[#1e222a]">
      <div className="mx-auto max-w-2xl px-6 py-24 font-serif">
        <p className="font-sans text-xs tracking-[0.25em] text-[#8a8578]">MORNINGPICK</p>
        {done ? (
          <>
            <h1 className="mt-6 text-4xl">You&apos;re unsubscribed.</h1>
            <p className="mt-6 text-lg leading-relaxed">
              No more morning memos. If you change your mind,{" "}
              <a href="/" className="underline">you can sign up again</a> any time.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-4xl">Hmm, that didn&apos;t work.</h1>
            <p className="mt-6 text-lg leading-relaxed">
              This unsubscribe link isn&apos;t valid — it may already have been used. If you keep
              receiving emails, reply to any memo with &ldquo;unsubscribe&rdquo; and we&apos;ll
              take care of it.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
