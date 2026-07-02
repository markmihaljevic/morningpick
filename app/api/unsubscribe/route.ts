import { NextRequest, NextResponse } from "next/server";
import { db, logEvent } from "@/lib/db";

export const runtime = "nodejs";

async function unsubscribe(token: string | null): Promise<boolean> {
  if (!token) return false;
  const { data } = await db()
    .from("subscribers")
    .update({ status: "unsubscribed" })
    .eq("unsubscribe_token", token)
    .select("id")
    .maybeSingle();
  if (data) await logEvent("unsubscribed", { subscriberId: data.id });
  return Boolean(data);
}

// RFC 8058 One-Click unsubscribe target (List-Unsubscribe-Post header).
export async function POST(req: NextRequest): Promise<NextResponse> {
  await unsubscribe(req.nextUrl.searchParams.get("token"));
  return new NextResponse(null, { status: 204 });
}

// Direct link fallback → redirect to the confirmation page.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token");
  await unsubscribe(token);
  return NextResponse.redirect(new URL(`/unsubscribe?token=${token ?? ""}`, req.nextUrl.origin));
}
