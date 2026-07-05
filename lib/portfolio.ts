import { db } from "./db";
import { fmpGet } from "./fmp";

export interface Holding {
  ticker: string;
  name: string | null;
  note: string | null;
}

/** The subscriber's self-reported holdings — the only source "you hold X" may cite. */
export async function getPortfolio(subscriberId: string): Promise<Holding[]> {
  const { data } = await db()
    .from("portfolio")
    .select("ticker, name, note")
    .eq("subscriber_id", subscriberId)
    .order("added_at", { ascending: true });
  return (data ?? []) as Holding[];
}

export async function addHolding(
  subscriberId: string,
  ticker: string,
  note?: string,
): Promise<Holding> {
  const clean = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(clean)) {
    throw new Error("That doesn't look like a ticker.");
  }
  // Best-effort company name — an unknown ticker is still storable.
  let name: string | null = null;
  try {
    const quote = await fmpGet<{ name?: string }[]>("quote", { symbol: clean });
    name = quote?.[0]?.name ?? null;
  } catch {
    /* name stays null */
  }
  const { error } = await db()
    .from("portfolio")
    .upsert(
      { subscriber_id: subscriberId, ticker: clean, name, note: note?.slice(0, 200) ?? null },
      { onConflict: "subscriber_id,ticker" },
    );
  if (error) throw new Error(error.message);
  return { ticker: clean, name, note: note ?? null };
}

export async function removeHolding(subscriberId: string, ticker: string): Promise<void> {
  await db()
    .from("portfolio")
    .delete()
    .eq("subscriber_id", subscriberId)
    .eq("ticker", ticker.trim().toUpperCase());
}
