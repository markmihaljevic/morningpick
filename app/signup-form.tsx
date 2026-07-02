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
      <p className="text-lg border border-[#1e222a] px-6 py-4">
        ✉️ {message}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col sm:flex-row gap-3 w-full max-w-md">
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
        className="flex-1 border border-[#1e222a] bg-transparent px-4 py-3 text-base outline-none placeholder:text-[#8a8578] focus:bg-white"
      />
      <button
        type="submit"
        disabled={state === "loading"}
        className="bg-[#1e222a] px-6 py-3 font-sans text-sm tracking-widest text-[#f6f5f1] disabled:opacity-60"
      >
        {state === "loading" ? "…" : "SUBSCRIBE"}
      </button>
      {state === "error" && <p className="text-sm text-red-700">{message}</p>}
    </form>
  );
}
