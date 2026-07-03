import { NextRequest, NextResponse } from "next/server";
import React from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { MemoPdf } from "@/lib/pdf/memo-pdf";
import type { KeyStat } from "@/lib/stats";
import type { StreetItem } from "@/lib/street";
import type { ResearchLink } from "@/lib/research-links";
import type { MemoSource, MemoMeta } from "@/lib/memo";
import type { PrimarySource } from "@/lib/enrich-sources";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Download a memo as a typeset PDF research note. Access model: memo ids are
 * unguessable UUIDs delivered only inside the subscriber's own email.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: memo } = await db()
    .from("memos")
    .select("ticker, title, delivery_date, content_md, extras, sent_at, subscribers(email)")
    .eq("id", id)
    .maybeSingle();
  if (!memo || !memo.sent_at) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const subscriber = Array.isArray(memo.subscribers) ? memo.subscribers[0] : memo.subscribers;
  const extras = (memo.extras ?? {}) as {
    chartUrl?: string | null;
    researchLinks?: ResearchLink[];
    sources?: MemoSource[];
    stats?: KeyStat[];
    street?: StreetItem[];
    meta?: MemoMeta | null;
    primarySources?: PrimarySource[];
    dateLine?: string;
  };

  const buffer = await renderToBuffer(
    // MemoPdf returns a <Document>; createElement can't see that through the fn type.
    React.createElement(MemoPdf, {
      markdown: memo.content_md,
      ticker: memo.ticker,
      dateLine: extras.dateLine ?? memo.delivery_date,
      preparedFor: (subscriber as { email?: string })?.email,
      stats: extras.stats,
      street: extras.street,
      meta: extras.meta,
      primarySources: extras.primarySources,
      chartUrl: extras.chartUrl,
      researchLinks: extras.researchLinks,
      sources: extras.sources,
      postalAddress: config().POSTAL_ADDRESS,
    }) as unknown as React.ReactElement<DocumentProps>,
  );

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="morningpick-${memo.ticker.replace(/[^A-Za-z0-9.-]/g, "")}-${memo.delivery_date}.pdf"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
