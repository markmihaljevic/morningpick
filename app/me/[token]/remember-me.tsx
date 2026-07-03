"use client";

import { useEffect } from "react";

/**
 * Persist the session: an httpOnly cookie (via /api/session) keeps this
 * device signed in — visiting from an email link IS the login.
 */
export function RememberMe({ token }: { token: string }) {
  useEffect(() => {
    fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {
      // cookie refresh is best-effort — the email link always works
    });
  }, [token]);
  return null;
}
