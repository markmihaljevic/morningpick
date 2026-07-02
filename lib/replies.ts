import type { ReceivedEmail } from "./resend";

/** Header/sender-based auto-reply detection. Runs BEFORE any LLM call. */
export function isAutoReply(email: ReceivedEmail): boolean {
  const h = email.headers;
  const autoSubmitted = h["auto-submitted"];
  if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") return true;
  const precedence = (h["precedence"] ?? "").toLowerCase();
  if (["bulk", "auto_reply", "auto-reply", "junk", "list"].includes(precedence)) return true;
  if (h["x-autoreply"] || h["x-autorespond"] || h["x-auto-response-suppress"]) return true;

  const from = email.from.toLowerCase();
  if (/mailer-daemon|postmaster|no-?reply|donotreply|notifications?@/.test(from)) return true;

  const subject = (email.subject ?? "").toLowerCase();
  if (/^(auto(matic)?[:\s-]|out of office|ooo[:\s]|away from|delivery status|undeliverable|vacation)/.test(subject)) {
    return true;
  }
  return false;
}

/** Strip quoted reply text, signatures, and HTML noise; cap length. */
export function cleanReplyBody(email: ReceivedEmail): string {
  let text = email.text ?? "";
  if (!text && email.html) {
    text = email.html
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  // Cut at common quoted-reply markers.
  const markers = [
    // Gmail may wrap "On <date> <sender> wrote:" across two lines.
    /^On [\s\S]{5,300}? wrote:\s*$/m,
    /^-{2,}\s*Original Message\s*-{2,}/im,
    /^From:\s.+@.+$/m,
    /^_{10,}\s*$/m,
    /^Sent from my (iPhone|iPad|Android|Samsung)/im,
  ];
  for (const marker of markers) {
    const match = text.match(marker);
    if (match && match.index !== undefined && match.index > 0) {
      text = text.slice(0, match.index);
    }
  }

  // Drop quoted lines and truncate at the signature delimiter.
  const lines = text.split("\n").filter((l) => !l.trimStart().startsWith(">"));
  const sigIndex = lines.findIndex((l) => l.trim() === "--");
  const kept = sigIndex > 0 ? lines.slice(0, sigIndex) : lines;

  return kept.join("\n").trim().slice(0, 4000);
}

export interface ReplyTarget {
  kind: "memo" | "welcome" | "unknown";
  id: string | null; // memoId or subscriberId
}

/**
 * Parse the plus-addressed recipient to link a reply to its memo
 * (reply+<memoId>@reply.DOMAIN) or to onboarding (reply+welcome-<subscriberId>@).
 */
export function parseReplyTarget(to: string[]): ReplyTarget {
  for (const addr of to) {
    const match = addr.toLowerCase().match(/reply\+([a-z0-9-]+)@/);
    if (!match) continue;
    const local = match[1];
    if (local.startsWith("welcome-")) {
      return { kind: "welcome", id: local.slice("welcome-".length) };
    }
    return { kind: "memo", id: local };
  }
  return { kind: "unknown", id: null };
}
