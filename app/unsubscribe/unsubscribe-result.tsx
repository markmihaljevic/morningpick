export function UnsubscribeResult({ done }: { done: boolean }) {
  return (
    <main className="min-h-screen bg-[#FBFAF6] text-[#10202F]">
      <div className="mx-auto max-w-2xl px-6 py-24 font-serif">
        <p className="font-sans text-xs tracking-[0.25em] text-[#5C6670]">MORNINGPICK</p>
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
