"use client";

import { useEffect } from "react";

/** Remember the desk token locally so the public homepage can offer a way back. */
export function RememberMe({ token }: { token: string }) {
  useEffect(() => {
    try {
      localStorage.setItem("mp_desk_token", token);
    } catch {
      // private mode etc. — the email link always works
    }
  }, [token]);
  return null;
}
