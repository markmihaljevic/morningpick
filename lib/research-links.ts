export interface ResearchLink {
  label: string;
  url: string;
}

const US_EXCHANGES = new Set(["NYSE", "NASDAQ", "AMEX", "OTC"]);

interface CompanyProfileLike {
  website?: string;
  cik?: string;
  companyName?: string;
  exchangeShortName?: string;
  exchange?: string;
}

/**
 * Deterministic follow-up research links — no LLM involved, so every URL is
 * structurally trustworthy (search pages and registries, never guessed
 * deep links).
 */
export function buildResearchLinks(
  ticker: string,
  companyName: string,
  profile: CompanyProfileLike | undefined,
): ResearchLink[] {
  const links: ResearchLink[] = [];
  const name = companyName || ticker;
  const exchange = (profile?.exchangeShortName ?? profile?.exchange ?? "").toUpperCase();

  if (profile?.website) {
    links.push({ label: "Company & investor relations", url: profile.website });
  }

  if (profile?.cik) {
    links.push({
      label: "SEC filings (EDGAR)",
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${profile.cik}&type=&dateb=&owner=include&count=40`,
    });
  } else if (US_EXCHANGES.has(exchange)) {
    links.push({
      label: "SEC filings (EDGAR)",
      url: `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(name)}%22&dateRange=custom`,
    });
  } else if (exchange === "LSE" || exchange === "AQS") {
    links.push({
      label: "Regulatory news (RNS)",
      url: `https://www.investegate.co.uk/search?query=${encodeURIComponent(name)}`,
    });
  }

  links.push({
    label: "Substack coverage",
    url: `https://substack.com/search/${encodeURIComponent(`${name}`)}?searching=all_posts`,
  });
  links.push({
    label: "Recent news",
    url: `https://news.google.com/search?q=${encodeURIComponent(`"${name}" stock`)}`,
  });
  links.push({
    label: "Annual reports",
    url: `https://www.google.com/search?q=${encodeURIComponent(`${name} annual report investor relations pdf`)}`,
  });

  return links;
}
