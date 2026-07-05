import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { addHolding, removeHolding } from "@/lib/portfolio";

export const runtime = "nodejs";

async function subscriberIdFor(token: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
  const { data } = await db()
    .from("subscribers")
    .select("id")
    .eq("portal_token", token)
    .maybeSingle();
  return data?.id ?? null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const subscriberId = await subscriberIdFor(token);
  if (!subscriberId) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { ticker, note } = (await req.json().catch(() => ({}))) as {
    ticker?: string;
    note?: string;
  };
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  try {
    const holding = await addHolding(subscriberId, ticker, note);
    return NextResponse.json({ ok: true, holding });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not add" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const subscriberId = await subscriberIdFor(token);
  if (!subscriberId) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { ticker } = (await req.json().catch(() => ({}))) as { ticker?: string };
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  await removeHolding(subscriberId, ticker);
  return NextResponse.json({ ok: true });
}
