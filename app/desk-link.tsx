"use client";

import { useEffect, useState } from "react";

/**
 * Shows a "YOUR DESK" nav link on the public homepage for returning
 * subscribers — recognized purely client-side via the token their desk
 * page stored in localStorage, so the homepage stays statically cached.
 */
export function DeskLink() {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    try {
      setToken(localStorage.getItem("mp_desk_token"));
    } catch {
      // ignore
    }
  }, []);
  if (!token) return null;
  return (
    <a
      href={`/me/${token}`}
      className="mr-3 px-2 py-1.5 font-mono text-[11px] tracking-[0.15em] text-[#8FA0B0] transition-colors hover:text-[#B08C3D]"
    >
      YOUR DESK →
    </a>
  );
}
