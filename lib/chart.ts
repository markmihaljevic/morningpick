import { fmpGet } from "./fmp";

interface PriceRow {
  date: string;
  price: number;
}

/**
 * Build a 5-year monthly price chart as a hosted PNG (QuickChart) and return
 * its URL for use in an email <img>. Returns null on any failure — the memo
 * ships without a chart rather than failing the delivery.
 */
export async function buildFiveYearChartUrl(
  ticker: string,
  currency?: string,
): Promise<string | null> {
  try {
    const from = new Date();
    from.setFullYear(from.getFullYear() - 5);
    const rows = await fmpGet<PriceRow[]>("historical-price-eod/light", {
      symbol: ticker,
      from: from.toISOString().slice(0, 10),
    });
    if (!rows || rows.length < 30) return null;

    // Oldest → newest, downsampled to month-end points (~60).
    const asc = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const byMonth = new Map<string, PriceRow>();
    for (const r of asc) byMonth.set(r.date.slice(0, 7), r); // last row of each month wins
    const monthly = [...byMonth.values()];

    const labels = monthly.map((r) => r.date.slice(0, 7));
    const prices = monthly.map((r) => r.price);

    const res = await fetch("https://quickchart.io/chart/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        backgroundColor: "#f6f5f1",
        width: 600,
        height: 280,
        format: "png",
        chart: {
          type: "line",
          data: {
            labels,
            datasets: [
              {
                label: ticker,
                data: prices,
                fill: false,
                borderColor: "#1e222a",
                borderWidth: 2,
                pointRadius: 0,
              },
            ],
          },
          options: {
            legend: { display: false },
            title: {
              display: true,
              text: `${ticker} — 5 years${currency ? ` (${currency})` : ""}`,
              fontFamily: "Georgia",
              fontColor: "#1e222a",
            },
            scales: {
              xAxes: [
                {
                  ticks: { maxTicksLimit: 6, fontColor: "#8a8578" },
                  gridLines: { display: false },
                },
              ],
              yAxes: [
                {
                  ticks: { maxTicksLimit: 6, fontColor: "#8a8578" },
                  gridLines: { color: "#ddd8cc" },
                },
              ],
            },
          },
        },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: boolean; url?: string };
    return body.success && body.url ? body.url : null;
  } catch (e) {
    console.error(`Chart build failed for ${ticker}:`, e);
    return null;
  }
}
