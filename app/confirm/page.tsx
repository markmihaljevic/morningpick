import { db, logEvent } from "@/lib/db";
import { sendEmail, replyAddress } from "@/lib/resend";
import { renderWelcomeEmail } from "@/lib/emails/welcome-email";

export const dynamic = "force-dynamic";

export const metadata = { title: "Confirm — Morningpick" };

async function confirmSubscriber(token: string): Promise<"confirmed" | "invalid"> {
  const { data: subscriber } = await db()
    .from("subscribers")
    .select("id, email, status, unsubscribe_token")
    .eq("confirm_token", token)
    .maybeSingle();
  if (!subscriber) return "invalid";
  if (subscriber.status === "active") return "confirmed"; // idempotent re-click

  // Activate and rotate the confirm token so the link is single-use.
  const { error } = await db()
    .from("subscribers")
    .update({
      status: "active",
      confirmed_at: new Date().toISOString(),
      confirm_token: crypto.randomUUID(),
    })
    .eq("id", subscriber.id);
  if (error) return "invalid";

  await logEvent("confirmed", { subscriberId: subscriber.id });

  try {
    await sendEmail({
      to: subscriber.email,
      subject: "Welcome — your first memo arrives tomorrow morning",
      html: renderWelcomeEmail(subscriber.unsubscribe_token),
      replyTo: replyAddress(`welcome-${subscriber.id}`),
      unsubscribeToken: subscriber.unsubscribe_token,
    });
  } catch (e) {
    console.error("Welcome email failed:", e);
  }
  return "confirmed";
}

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const result = token ? await confirmSubscriber(token) : "invalid";

  return (
    <main className="min-h-screen bg-[#f6f5f1] text-[#1e222a]">
      <div className="mx-auto max-w-2xl px-6 py-24 font-serif">
        <p className="font-sans text-xs tracking-[0.25em] text-[#8a8578]">MORNINGPICK</p>
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
