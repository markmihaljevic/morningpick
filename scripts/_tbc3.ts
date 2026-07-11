import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
import { fetchTickerData } from "../lib/fmp";
import { buildStatStrip } from "../lib/stats";
import { buildCompTable } from "../lib/comp-table";
(async () => {
  const d = await fetchTickerData("TBCG.L");
  const strip = await buildStatStrip(d);
  console.log("STRIP:", strip.map((x) => `${x.label} ${x.value}`).join(" | "));
  const t0 = Date.now();
  const t = await buildCompTable({ ticker: "TBCG.L", companyName: "TBC Bank Group PLC", data: d });
  console.log(`table in ${((Date.now()-t0)/1000).toFixed(0)}s`);
  if (!t) { console.log("NO TABLE"); return; }
  console.log(`columns: ${t.columns.map((c) => c.label).join(" | ")}`);
  for (const r of t.rows) console.log(`${r.self ? "> " : "  "}${r.name} (${r.ticker})${r.marker ? " " + r.marker : ""}: ${r.cells.join(" | ")}`);
  console.log("Why:"); for (const x of t.rationales) console.log(" -", x.slice(0, 110));
  console.log("Footnotes:"); for (const f of t.footnotes) console.log(" ", f.slice(0, 160));
})().catch(e=>{console.error("FAILED:",e);process.exit(1);});
