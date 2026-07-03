import React from "react";
import { Document, Page, Text, View, Image, Link, StyleSheet } from "@react-pdf/renderer";
import { marked, type Token, type Tokens } from "marked";
import { BRAND } from "../brand";
import type { KeyStat } from "../stats";
import type { ResearchLink } from "../research-links";
import type { MemoSource, MemoMeta } from "../memo";
import type { StreetItem } from "../street";

const styles = StyleSheet.create({
  page: {
    backgroundColor: "#FFFFFF",
    paddingTop: 46,
    paddingBottom: 64,
    paddingHorizontal: 52,
    fontFamily: "Times-Roman",
    fontSize: 10.5,
    lineHeight: 1.55,
    color: BRAND.ink,
  },
  masthead: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 34,
    backgroundColor: BRAND.ink,
    borderBottomWidth: 2,
    borderBottomColor: BRAND.gold,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 52,
  },
  wordmark: { fontFamily: "Helvetica-Bold", fontSize: 10, letterSpacing: 3, color: "#FBFAF6" },
  mastRight: { fontFamily: "Helvetica", fontSize: 7, letterSpacing: 1.5, color: "#8FA0B0" },
  preparedFor: {
    marginTop: 6,
    fontFamily: "Helvetica",
    fontSize: 6.5,
    letterSpacing: 1.5,
    color: BRAND.slate,
  },
  title: { fontFamily: "Times-Bold", fontSize: 19, lineHeight: 1.25, marginTop: 10, marginBottom: 12 },
  statsRow: { flexDirection: "row", marginBottom: 4 },
  statCell: {
    flex: 1,
    borderWidth: 0.75,
    borderColor: BRAND.rule,
    paddingVertical: 5,
    paddingHorizontal: 7,
  },
  statLabel: { fontFamily: "Helvetica", fontSize: 5.5, letterSpacing: 1, color: BRAND.slate },
  statValue: { fontFamily: "Helvetica-Bold", fontSize: 9, marginTop: 1.5 },
  para: { marginBottom: 9 },
  bold: { fontFamily: "Times-Bold" },
  italic: { fontFamily: "Times-Italic" },
  listItem: { flexDirection: "row", marginBottom: 6, paddingLeft: 8 },
  listMarker: { width: 16, fontFamily: "Times-Bold" },
  listBody: { flex: 1 },
  chart: { marginTop: 14, marginBottom: 6, borderWidth: 0.75, borderColor: BRAND.rule },
  sectionLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7,
    letterSpacing: 2,
    color: BRAND.gold,
    marginTop: 16,
    marginBottom: 6,
  },
  linkLine: { marginBottom: 4, fontSize: 10 },
  sourceLine: { marginBottom: 3, fontFamily: "Helvetica", fontSize: 7, color: BRAND.slate },
  footer: {
    position: "absolute",
    bottom: 22,
    left: 52,
    right: 52,
    borderTopWidth: 0.75,
    borderTopColor: BRAND.rule,
    paddingTop: 6,
    fontFamily: "Helvetica",
    fontSize: 6,
    color: BRAND.slate,
    lineHeight: 1.5,
  },
});

export interface MemoPdfArgs {
  markdown: string;
  ticker: string;
  dateLine?: string;
  preparedFor?: string;
  stats?: KeyStat[];
  street?: StreetItem[];
  meta?: MemoMeta | null;
  chartUrl?: string | null;
  researchLinks?: ResearchLink[];
  sources?: MemoSource[];
  postalAddress: string;
}

/** Render inline markdown tokens (bold/em/links/text) into nested Text. */
function inline(tokens: Token[] | undefined, keyPrefix: string): React.ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (t.type) {
      case "strong":
        return (
          <Text key={key} style={styles.bold}>
            {inline((t as Tokens.Strong).tokens, key)}
          </Text>
        );
      case "em":
        return (
          <Text key={key} style={styles.italic}>
            {inline((t as Tokens.Em).tokens, key)}
          </Text>
        );
      case "link":
        return (
          <Link key={key} src={(t as Tokens.Link).href} style={{ color: BRAND.ink }}>
            {inline((t as Tokens.Link).tokens, key)}
          </Link>
        );
      case "codespan":
        return <Text key={key}>{(t as Tokens.Codespan).text}</Text>;
      default:
        return <Text key={key}>{"text" in t ? (t as Tokens.Text).text : ""}</Text>;
    }
  });
}

function blocks(markdown: string): React.ReactNode[] {
  const tokens = marked.lexer(markdown);
  const out: React.ReactNode[] = [];
  tokens.forEach((token, i) => {
    switch (token.type) {
      case "heading":
        if (token.depth === 1) return; // H1 rendered separately as the title
        // Section headings: mono-gold label over a hairline rule.
        out.push(
          <View
            key={i}
            style={{
              marginTop: 12,
              marginBottom: 6,
              borderTopWidth: 0.75,
              borderTopColor: BRAND.rule,
              paddingTop: 8,
            }}
          >
            <Text
              style={{
                fontFamily: "Helvetica-Bold",
                fontSize: 7.5,
                letterSpacing: 2,
                color: BRAND.gold,
              }}
            >
              {token.text.toUpperCase()}
            </Text>
          </View>,
        );
        return;
      case "paragraph":
        out.push(
          <Text key={i} style={styles.para}>
            {inline(token.tokens, `p-${i}`)}
          </Text>,
        );
        return;
      case "list": {
        const list = token as Tokens.List;
        list.items.forEach((item, j) => {
          const marker = list.ordered ? `${(Number(list.start) || 1) + j}.` : "•";
          // List items wrap their content in nested tokens (often a single text/paragraph).
          const itemTokens =
            item.tokens?.flatMap((t) =>
              t.type === "text" || t.type === "paragraph"
                ? ((t as Tokens.Text).tokens ?? [t])
                : [t],
            ) ?? [];
          out.push(
            <View key={`${i}-${j}`} style={styles.listItem}>
              <Text style={styles.listMarker}>{marker}</Text>
              <Text style={styles.listBody}>{inline(itemTokens, `li-${i}-${j}`)}</Text>
            </View>,
          );
        });
        return;
      }
      default:
        return;
    }
  });
  return out;
}

export function MemoPdf(args: MemoPdfArgs) {
  const lexed = marked.lexer(args.markdown);
  const h1 = lexed.find((t) => t.type === "heading" && (t as Tokens.Heading).depth === 1) as
    | Tokens.Heading
    | undefined;
  const title = h1?.text ?? args.ticker;

  return (
    <Document title={title} author="Morningpick" creator="morningpick.ai">
      <Page size="A4" style={styles.page}>
        <View style={styles.masthead} fixed>
          <Text style={styles.wordmark}>MORNINGPICK</Text>
          <Text style={styles.mastRight}>
            {(args.dateLine ?? "").toUpperCase() || "PRIVATE RESEARCH NOTE"}
          </Text>
        </View>

        {args.preparedFor && (
          <Text style={styles.preparedFor}>
            PRIVATE RESEARCH NOTE · PREPARED FOR {args.preparedFor.toUpperCase()}
          </Text>
        )}

        <Text style={styles.title}>{title}</Text>

        {args.meta && (
          <View style={{ flexDirection: "row", marginBottom: 8, gap: 6 }}>
            {[
              ["CONVICTION", `${args.meta.conviction}/10`],
              ["HORIZON", args.meta.horizon.toUpperCase()],
              ...args.meta.style_tags.map((t) => ["STYLE", t.toUpperCase()] as [string, string]),
            ].map(([label, value], i) => (
              <View
                key={i}
                style={{
                  borderWidth: 0.75,
                  borderColor: i === 0 ? BRAND.gold : BRAND.rule,
                  backgroundColor: i === 0 ? "#FAF3E3" : "#FFFFFF",
                  paddingVertical: 3,
                  paddingHorizontal: 7,
                }}
              >
                <Text style={{ fontFamily: "Helvetica", fontSize: 5, letterSpacing: 1, color: BRAND.slate }}>
                  {label}
                </Text>
                <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 8, marginTop: 1 }}>{value}</Text>
              </View>
            ))}
          </View>
        )}

        {args.meta?.one_liner && (
          <View
            style={{
              borderLeftWidth: 2,
              borderLeftColor: BRAND.gold,
              backgroundColor: "#FAF3E3",
              paddingVertical: 6,
              paddingHorizontal: 9,
              marginBottom: 10,
            }}
          >
            <Text style={{ fontFamily: "Times-Italic", fontSize: 11 }}>{args.meta.one_liner}</Text>
          </View>
        )}

        {args.stats && args.stats.length > 0 && (
          <View style={{ marginBottom: 12 }}>
            <View style={styles.statsRow}>
              {args.stats.slice(0, Math.ceil(args.stats.length / 2)).map((s, i) => (
                <View key={i} style={styles.statCell}>
                  <Text style={styles.statLabel}>{s.label.toUpperCase()}</Text>
                  <Text style={styles.statValue}>{s.value}</Text>
                </View>
              ))}
            </View>
            {args.stats.length > 1 && (
              <View style={styles.statsRow}>
                {args.stats.slice(Math.ceil(args.stats.length / 2)).map((s, i) => (
                  <View key={i} style={styles.statCell}>
                    <Text style={styles.statLabel}>{s.label.toUpperCase()}</Text>
                    <Text style={styles.statValue}>{s.value}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {args.street && args.street.length > 0 && (
          <Text
            style={{
              fontFamily: "Helvetica",
              fontSize: 6.5,
              letterSpacing: 0.5,
              color: BRAND.slate,
              marginBottom: 12,
            }}
          >
            {args.street.map((s) => `${s.label.toUpperCase()} ${s.value}`).join("   ·   ")}
          </Text>
        )}

        {blocks(args.markdown)}

        {args.chartUrl && (
          // eslint-disable-next-line jsx-a11y/alt-text
          <Image src={args.chartUrl} style={styles.chart} />
        )}

        {args.researchLinks && args.researchLinks.length > 0 && (
          <View>
            <Text style={styles.sectionLabel}>DIG DEEPER</Text>
            {args.researchLinks.map((l, i) => (
              <Text key={i} style={styles.linkLine}>
                →{"  "}
                <Link src={l.url} style={{ color: BRAND.ink }}>
                  {l.label}
                </Link>
              </Text>
            ))}
          </View>
        )}

        {args.sources && args.sources.length > 0 && (
          <View>
            <Text style={styles.sectionLabel}>SOURCES CITED</Text>
            {args.sources.map((s, i) => (
              <Text key={i} style={styles.sourceLine}>
                <Link src={s.url} style={{ color: BRAND.slate }}>
                  {s.title || s.url}
                </Link>
              </Text>
            ))}
          </View>
        )}

        <View style={styles.footer} fixed>
          <Text>
            Not investment advice. This memo is AI-generated, for informational and entertainment
            purposes only, and may contain errors. Always do your own research. {args.postalAddress}{" "}
            · morningpick.ai
          </Text>
        </View>
      </Page>
    </Document>
  );
}
