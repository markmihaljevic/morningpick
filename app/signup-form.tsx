"use client";

import { useState } from "react";

export function SignupForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("loading");
    const honeypot = (e.currentTarget.elements.namedItem("website") as HTMLInputElement)?.value;
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website: honeypot }),
      });
      const body = await res.json();
      setMessage(body.message ?? "Check your email to confirm.");
      setState(res.ok ? "done" : "error");
    } catch {
      setMessage("Something went wrong. Please try again.");
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <p className="inline-block border border-[#B08C3D] px-5 py-3.5 font-mono text-[13px] tracking-wide text-[#B08C3D]">
        ✓ {message.toUpperCase()}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-3 sm:flex-row">
      {/* Honeypot — hidden from real users */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        className="absolute left-[-9999px] h-0 w-0 opacity-0"
        aria-hidden="true"
      />
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="flex-1 border border-white/25 bg-white/5 px-4 py-3 font-mono text-[14px] text-[#FBFAF6] outline-none placeholder:text-[#5C6670] focus:border-[#B08C3D]"
      />
      <button
        type="submit"
        disabled={state === "loading"}
        className="border-b-2 border-[#B08C3D] bg-[#FBFAF6] px-6 py-3 font-mono text-[12px] font-semibold tracking-[0.2em] text-[#0B1622] transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {state === "loading" ? "…" : "SUBSCRIBE — FREE"}
      </button>
      {state === "error" && (
        <p className="font-mono text-[12px] text-red-400 sm:self-center">{message}</p>
      )}
    </form>
  );
}
