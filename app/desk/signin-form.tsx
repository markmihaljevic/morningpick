"use client";

import { useState } from "react";

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "unknown" | "error">("idle");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || state === "sending") return;
    setState("sending");
    try {
      const res = await fetch("/api/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) setState("sent");
      else if (res.status === 404) setState("unknown");
      else setState("error");
    } catch {
      setState("error");
    }
  };

  if (state === "sent") {
    return (
      <div className="mt-8 border border-[#B08C3D]/40 bg-[#10202F] p-6">
        <p className="font-mono text-[11px] tracking-[0.2em] text-[#B08C3D]">CHECK YOUR INBOX</p>
        <p className="mt-2 text-[14px] leading-relaxed text-[#8FA0B0]">
          Your sign-in link is on its way to <span className="text-[#FBFAF6]">{email}</span>.
          Click it and your desk opens.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-8">
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="flex-1 border border-white/20 bg-transparent px-4 py-2.5 font-mono text-[13px] text-[#FBFAF6] placeholder-[#5C7183] outline-none focus:border-[#B08C3D]"
        />
        <button
          type="submit"
          disabled={state === "sending"}
          className="border border-[#B08C3D] bg-[#B08C3D] px-5 py-2.5 font-mono text-[11px] tracking-[0.15em] text-[#0B1622] transition-colors hover:bg-transparent hover:text-[#B08C3D] disabled:opacity-60"
        >
          {state === "sending" ? "SENDING…" : "EMAIL ME A SIGN-IN LINK"}
        </button>
      </div>
      {state === "unknown" && (
        <p className="mt-3 font-mono text-[11px] tracking-wide text-[#B08C3D]">
          No subscription found for that address —{" "}
          <a href="/#subscribe" className="underline underline-offset-4">
            start free instead →
          </a>
        </p>
      )}
      {state === "error" && (
        <p className="mt-3 font-mono text-[11px] tracking-wide text-[#B08C3D]">
          Something went wrong — try again in a minute.
        </p>
      )}
    </form>
  );
}
