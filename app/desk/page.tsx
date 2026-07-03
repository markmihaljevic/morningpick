import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { DESK_COOKIE } from "@/lib/session";
import { SignInForm } from "./signin-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign in — Morningpick",
  robots: { index: false, follow: false },
};

function SunMark({ className = "" }: { className?: string }) {
  return <div className={`h-[10px] w-[20px] rounded-t-full bg-[#B08C3D] ${className}`} />;
}

/**
 * The one door: signed-in visitors bounce straight to their desk via the
 * session cookie; everyone else gets the magic-link form.
 */
export default async function DeskDoor() {
  const store = await cookies();
  const token = store.get(DESK_COOKIE)?.value;
  if (token && /^[0-9a-f-]{36}$/i.test(token)) {
    const { data: subscriber } = await db()
      .from("subscribers")
      .select("id")
      .eq("portal_token", token)
      .maybeSingle();
    if (subscriber) redirect(`/me/${token}`);
  }

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
        <div className="w-full max-w-md py-20">
          <p className="font-mono text-[11px] tracking-[0.25em] text-[#B08C3D]">YOUR RESEARCH DESK</p>
          <h1 className="mt-3 text-[32px] leading-tight font-bold tracking-tight">
            No passwords here.
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-[#8FA0B0]">
            Enter the email your notes arrive at and we'll send you a sign-in link. One click,
            and this device stays signed in until you sign out.
          </p>
          <SignInForm />
          <p className="mt-6 font-mono text-[10px] tracking-wide text-[#5C7183]">
            NOT A SUBSCRIBER YET?{" "}
            <a href="/#subscribe" className="text-[#B08C3D]">
              START FREE →
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
