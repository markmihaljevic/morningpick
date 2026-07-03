import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { config } from "@/lib/config";
import { db, logEvent } from "@/lib/db";
import { getReceivedEmail } from "@/lib/resend";
import { isAutoReply, cleanReplyBody, parseReplyTarget } from "@/lib/replies";
import { interpretFeedback, applyFeedback } from "@/lib/feedback";
import { answerQuestions } from "@/lib/qa";

export const runtime = "nodejs";
export const maxDuration = 300;

interface ResendEvent {
  type: string;
  data: {
    email_id?: string;
    to?: string[] | string;
    from?: string;
    subject?: string;
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const payload = await req.text();

  let event: ResendEvent;
  try {
    const wh = new Webhook(config().RESEND_WEBHOOK_SECRET);
    event = wh.verify(payload, {
      "svix-id": req.headers.get("svix-id") ?? "",
      "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
      "svix-signature": req.headers.get("svix-signature") ?? "",
    }) as ResendEvent;
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  switch (event.type) {
    case "email.bounced":
    case "email.complained":
      return handleSuppression(event);
    case "email.received":
      return handleInbound(event);
    default:
      return NextResponse.json({ ok: true, ignored: event.type });
  }
}

async function handleSuppression(event: ResendEvent): Promise<NextResponse> {
  const recipients = Array.isArray(event.data.to)
    ? event.data.to
    : [event.data.to].filter(Boolean);
  for (const email of recipients) {
    const { data } = await db()
      .from("subscribers")
      .update({ status: "bounced" })
      .eq("email", String(email).toLowerCase())
      .select("id")
      .maybeSingle();
    if (data) {
      await logEvent(event.type === "email.bounced" ? "bounce" : "complaint", {
        subscriberId: data.id,
      });
    }
  }
  return NextResponse.json({ ok: true });
}

async function handleInbound(event: ResendEvent): Promise<NextResponse> {
  const emailId = event.data.email_id;
  if (!emailId) return NextResponse.json({ ok: true, skipped: "no email_id" });

  // Dedupe webhook retries via unique inbound_email_id. We need the subscriber
  // before we can insert the stub, so check-first then rely on the unique
  // constraint as the race-proof backstop.
  const { data: dupe } = await db()
    .from("feedback")
    .select("id")
    .eq("inbound_email_id", emailId)
    .maybeSingle();
  if (dupe) return NextResponse.json({ ok: true, skipped: "duplicate" });

  const email = await getReceivedEmail(emailId);

  if (isAutoReply(email)) {
    await logEvent("inbound_auto_reply_dropped", { payload: { emailId, from: email.from } });
    return NextResponse.json({ ok: true, skipped: "auto-reply" });
  }

  // Link the reply: plus-address → In-Reply-To → sender's latest memo.
  const target = parseReplyTarget(email.to);
  let memoId: string | null = null;
  let subscriberId: string | null = null;

  if (target.kind === "memo" && target.id) {
    const { data: memo } = await db()
      .from("memos")
      .select("id, subscriber_id")
      .eq("id", target.id)
      .maybeSingle();
    if (memo) {
      memoId = memo.id;
      subscriberId = memo.subscriber_id;
    }
  } else if (target.kind === "welcome" && target.id) {
    subscriberId = target.id;
  }

  if (!subscriberId) {
    const inReplyTo = email.headers["in-reply-to"]?.replace(/[<>]/g, "");
    if (inReplyTo) {
      const { data: memo } = await db()
        .from("memos")
        .select("id, subscriber_id")
        .eq("resend_message_id", inReplyTo)
        .maybeSingle();
      if (memo) {
        memoId = memo.id;
        subscriberId = memo.subscriber_id;
      }
    }
  }

  const senderEmail = (email.from.match(/<([^>]+)>/)?.[1] ?? email.from).toLowerCase().trim();
  const { data: subscriber } = await db()
    .from("subscribers")
    .select("id, email, status, unsubscribe_token")
    .eq(subscriberId ? "id" : "email", subscriberId ?? senderEmail)
    .maybeSingle();

  if (!subscriber) {
    await logEvent("inbound_unknown_sender", { payload: { emailId, from: senderEmail } });
    return NextResponse.json({ ok: true, skipped: "unknown sender" });
  }
  // Anti-spoofing: a plus-addressed reply must come from the memo's owner.
  if (subscriber.email.toLowerCase() !== senderEmail) {
    await logEvent("inbound_sender_mismatch", {
      subscriberId: subscriber.id,
      payload: { emailId, from: senderEmail },
    });
    return NextResponse.json({ ok: true, skipped: "sender mismatch" });
  }

  if (!memoId && !subscriberId) {
    // Fallback linkage: sender's most recent memo.
    const { data: latest } = await db()
      .from("memos")
      .select("id")
      .eq("subscriber_id", subscriber.id)
      .order("delivery_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    memoId = latest?.id ?? null;
  }

  const cleanedBody = cleanReplyBody(email);
  if (!cleanedBody) return NextResponse.json({ ok: true, skipped: "empty body" });

  const { data: stub, error: stubError } = await db()
    .from("feedback")
    .insert({
      subscriber_id: subscriber.id,
      memo_id: memoId,
      inbound_email_id: emailId,
      raw_subject: email.subject,
      cleaned_body: cleanedBody,
    })
    .select("id")
    .single();
  if (stubError) {
    // Unique violation = concurrent retry already handled it.
    return NextResponse.json({ ok: true, skipped: "duplicate race" });
  }

  const { data: profile } = await db()
    .from("preference_profiles")
    .select("structured, philosophy")
    .eq("subscriber_id", subscriber.id)
    .single();

  let memoContext: { ticker: string; title: string | null; date: string } | null = null;
  let memoRow: {
    ticker: string;
    title: string | null;
    content_md: string;
    delivery_date: string;
  } | null = null;
  if (memoId) {
    const { data: memo } = await db()
      .from("memos")
      .select("ticker, title, content_md, delivery_date")
      .eq("id", memoId)
      .single();
    if (memo) {
      memoContext = { ticker: memo.ticker, title: memo.title, date: memo.delivery_date };
      memoRow = memo;
    }
  }

  const interpretation = await interpretFeedback({
    structured: (profile?.structured as Record<string, unknown>) ?? {},
    philosophy: (profile?.philosophy as string) ?? "",
    memoContext,
    cleanedBody,
  });

  const hasQuestions =
    Array.isArray(interpretation.questions) && interpretation.questions.length > 0;

  await applyFeedback({
    subscriberId: subscriber.id,
    subscriberEmail: subscriber.email,
    feedbackId: stub.id,
    memoId,
    interpretation,
    unsubscribeToken: subscriber.unsubscribe_token,
    suppressAck: hasQuestions, // the researched answer doubles as the ack
  });

  // Route questions to the research desk — answered in the same email thread.
  let answered = false;
  if (hasQuestions && !interpretation.is_auto_reply_suspected) {
    const result = await answerQuestions({
      subscriberId: subscriber.id,
      subscriberEmail: subscriber.email,
      unsubscribeToken: subscriber.unsubscribe_token,
      memoId,
      memo: memoRow,
      questions: interpretation.questions.slice(0, 3),
      profile: {
        structured: (profile?.structured as Record<string, unknown>) ?? {},
        philosophy: (profile?.philosophy as string) ?? "",
      },
      feedbackApplied: interpretation.is_investment_feedback,
      ackSummary: interpretation.ack_summary,
    });
    answered = result.sent;
    if (!result.sent) {
      console.warn(`QA not sent for ${subscriber.id}: ${result.reason}`);
    }
  }

  return NextResponse.json({
    ok: true,
    applied: interpretation.is_investment_feedback,
    answered,
  });
}
