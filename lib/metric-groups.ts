import compMetrics from "./comp-metrics-v1.json";

/**
 * Sector metric-group resolution, extracted from lib/comp-table.ts so the
 * figures layer can consult it without an import cycle (comp-table imports
 * figures; figures must never import comp-table). Driven by John's
 * comp-metrics-by-industry file: industry (exact) → sector → default.
 */

export interface MetricDef {
  label: string;
  kind: "computed" | "filing" | "hybrid" | "sourced_only";
  how: string;
  rule: string;
}
export interface GroupDef {
  label: string;
  columns: string[];
  drop_first_if_tight?: string[];
  optional_if_sourced?: string[];
  stage_rule?: string;
  clean_comp_rule?: string;
  pitfalls?: string;
}

export const METRICS = compMetrics.metrics as Record<string, MetricDef>;
export const GROUPS = compMetrics.groups as Record<string, GroupDef>;
const INDUSTRY_TO_GROUP = compMetrics.industry_to_group as Record<string, string>;
const SECTOR_FALLBACK = compMetrics.sector_fallback as Record<string, string>;
const DEFAULT_GROUP = compMetrics.default_group as string;

export interface GroupResolution {
  key: string;
  group: GroupDef;
  via: "industry" | "sector" | "default" | "holdco-detection";
}

/** Resolution order per the file: industry (exact) → sector → default, logged. */
export function resolveMetricGroup(
  industry: string | undefined,
  sector: string | undefined,
): GroupResolution {
  if (industry && INDUSTRY_TO_GROUP[industry]) {
    return { key: INDUSTRY_TO_GROUP[industry], group: GROUPS[INDUSTRY_TO_GROUP[industry]], via: "industry" };
  }
  if (sector && SECTOR_FALLBACK[sector]) {
    return { key: SECTOR_FALLBACK[sector], group: GROUPS[SECTOR_FALLBACK[sector]], via: "sector" };
  }
  return { key: DEFAULT_GROUP, group: GROUPS[DEFAULT_GROUP], via: "default" };
}

/**
 * Deposit- and float-funded balance sheets (John's July 18 rule 3: banks,
 * insurers, anything consolidating funds or third-party capital): an
 * insurer's investment portfolio backs policyholder reserves — it is float,
 * not spare cash. These groups get NO enterprise value, NO net debt, and NO
 * net cash lines anywhere; the July 10 EV recipe applies only to
 * non-financial operating companies.
 */
export const BALANCE_SHEET_BUSINESS = new Set([
  "banks",
  "insurance_carriers",
  "capital_markets_ib",
  "specialty_finance_credit",
]);

/** Convenience: does this industry/sector resolve to a float/deposit-funded group? */
export function isBalanceSheetBusiness(industry: string | undefined, sector: string | undefined): boolean {
  return BALANCE_SHEET_BUSINESS.has(resolveMetricGroup(industry, sector).key);
}
