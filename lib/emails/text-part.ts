/**
 * Derive the plain-text alternative part from our email HTML. HTML-only
 * mail is a spam-filter signal; a faithful text part improves placement
 * and serves text-preferring clients. Tuned for our own templates (simple
 * tables, no scripts) — not a general-purpose converter.
 */
export function htmlToText(html: string): string {
  let text = html
    // Drop non-content blocks entirely.
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Links become "label (url)" — skip anchors whose label IS the url.
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const plain = label.replace(/<[^>]+>/g, "").trim();
      if (!plain) return "";
      return plain === href ? plain : `${plain} (${href})`;
    })
    // List items get a bullet.
    .replace(/<li[^>]*>/gi, "\n• ")
    // Block-level closes become line breaks.
    .replace(/<\/(p|div|tr|h1|h2|h3|h4|li|ul|ol|table|blockquote)>/gi, "\n")
    .replace(/<br[^>]*>/gi, "\n")
    // Everything else: strip.
    .replace(/<[^>]+>/g, "");

  // Decode the entities our templates use.
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Tidy whitespace: per-line trim, collapse runs of blank lines.
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
