/**
 * Pitch-price capture. No tracking product is built on this — the price at
 * pitch time is recorded on each memo so a future track record can reach
 * back to launch day.
 */
export function extractPitchPrice(data: {
  quote: unknown;
  profile: unknown;
}): { price: number | null; currency: string | null } {
  const quote = (Array.isArray(data.quote) ? data.quote[0] : data.quote) as
    | { price?: number }
    | undefined;
  const profile = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
    | { currency?: string }
    | undefined;
  return {
    price: typeof quote?.price === "number" ? quote.price : null,
    currency: profile?.currency ?? null,
  };
}
