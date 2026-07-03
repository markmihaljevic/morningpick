import { fmpGet } from "./fmp";
import { BRAND } from "./brand";

interface PriceRow {
  date: string;
  price: number;
}

/**
 * 5-year monthly price chart as a hosted PNG (QuickChart, Chart.js v4):
 * thin ink line over a soft gold area fill, hairline horizontal grid only,
 * sparse year ticks, right-side axis, retina. Returns null on any failure —
 * the memo ships without a chart rather than failing the delivery.
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

    const asc = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const byMonth = new Map<string, PriceRow>();
    for (const r of asc) byMonth.set(r.date.slice(0, 7), r); // last row of each month wins
    const monthly = [...byMonth.values()];

    // Year labels only at January (or the first point) — sparse, editorial.
    const labels = monthly.map((r, i) => {
      const [year, month] = r.date.split("-");
      return month === "01" || i === 0 ? year : "";
    });
    const prices = monthly.map((r) => r.price);
    const last = prices[prices.length - 1];
    const lastFmt = last >= 100 ? last.toFixed(0) : last.toFixed(2);

    const res = await fetch("https://quickchart.io/chart/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        version: "4",
        backgroundColor: BRAND.paper,
        width: 640,
        height: 280,
        devicePixelRatio: 2,
        format: "png",
        chart: {
          type: "line",
          data: {
            labels,
            datasets: [
              {
                data: prices,
                borderColor: BRAND.ink,
                borderWidth: 1.75,
                pointRadius: 0,
                fill: true,
                backgroundColor: "rgba(176, 140, 61, 0.12)",
                tension: 0,
              },
            ],
          },
          options: {
            layout: { padding: { top: 8, right: 4, left: 10, bottom: 4 } },
            plugins: {
              legend: { display: false },
              title: {
                display: true,
                align: "start",
                text: `${ticker}  ·  5 YEARS${currency ? `  (${currency})` : ""}`,
                color: BRAND.slate,
                font: { family: "Helvetica", size: 11, weight: "bold" },
                padding: { bottom: 2 },
              },
              subtitle: {
                display: true,
                align: "start",
                text: `Last ${lastFmt}${currency ? ` ${currency}` : ""}`,
                color: BRAND.gold,
                font: { family: "Helvetica", size: 11, weight: "bold" },
                padding: { bottom: 12 },
              },
            },
            scales: {
              x: {
                grid: { display: false },
                border: { color: BRAND.rule },
                ticks: {
                  autoSkip: false,
                  maxRotation: 0,
                  color: BRAND.slate,
                  font: { family: "Helvetica", size: 10 },
                },
              },
              y: {
                position: "right",
                border: { display: false },
                grid: { color: "rgba(16, 32, 47, 0.08)", drawTicks: false },
                ticks: {
                  maxTicksLimit: 5,
                  color: BRAND.slate,
                  font: { family: "Helvetica", size: 10 },
                  padding: 6,
                },
              },
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
