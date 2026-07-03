import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { DESK_COOKIE, DESK_COOKIE_MAX_AGE } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Establish (or refresh) the long-lived desk session. Called from the desk
 * page after it renders — possession of a valid desk token IS the login, so
 * this simply persists it as an httpOnly cookie for future visits.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { token } = (await req.json().catch(() => ({}))) as { token?: string };
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const { data: subscriber } = await db()
    .from("subscribers")
    .select("id")
    .eq("portal_token", token)
    .single();
  if (!subscriber) return NextResponse.json({ ok: false }, { status: 404 });

  const store = await cookies();
  store.set(DESK_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: DESK_COOKIE_MAX_AGE,
  });
  return NextResponse.json({ ok: true });
}
