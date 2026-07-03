import { anthropic } from "./anthropic";
import { config } from "./config";

/**
 * The editorial desk: a second set of eyes on the finished note's WRITING —
 * the verifier audits numbers, this audits prose. One critique, at most one
 * revision, hard rules against touching facts. Fails open: any error returns
 * the original markdown.
 */

const CRITIQUE_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["publish", "revise"],
      description: "revise ONLY when issues materially weaken the note",
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          where: { type: "string", description: "section or quoted fragment" },
          problem: { type: "string", description: "what's weak and why" },
        },
        required: ["where", "problem"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "issues"],
  additionalProperties: false,
} as const;

const CRITIQUE_SYSTEM =
  "You are the ruthless senior editor at an investment research desk, reviewing a note before " +
  "it goes to a paying subscriber. You do NOT check facts or numbers — another pass does that. " +
  "You check the WRITING: hedge-slop ('it remains to be seen', 'only time will tell'), filler " +
  "sentences that assert nothing, repeated sentence rhythms, formulaic tics (every title as " +
  "'TICKER — clever subordinate clause', every section opening the same way), burying the most " +
  "interesting fact, risk sections that read like compliance boilerplate, and claims so vague " +
  "they can't be wrong. Great notes should pass untouched: verdict 'publish' with minor or no " +
  "issues. Demand a revision only when the problems would make a sophisticated reader respect " +
  "the analyst less.";

const REVISE_SYSTEM =
  "You are the analyst revising your own research note per your editor's line notes. HARD " +
  "RULES: every number, ticker, date, name, and factual claim stays EXACTLY as written — you " +
  "are polishing prose, not re-researching. Keep every markdown link exactly as it is (same " +
  "text is fine to adjust, same URL mandatory). Keep the same section structure and roughly " +
  "the same length. Do not add new facts, sources, or hedges. Output ONLY the revised memo " +
  "markdown, starting with the H1.";

export interface EditorialResult {
  markdown: string;
  revised: boolean;
  issues: string[];
}

export async function editMemo(markdown: string): Promise<EditorialResult> {
  const cfg = config();
  try {
    const critique = await anthropic().messages.create({
      model: cfg.FEEDBACK_MODEL,
      max_tokens: 6000,
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema: CRITIQUE_SCHEMA }, effort: "medium" },
      system: CRITIQUE_SYSTEM,
      messages: [{ role: "user", content: `<note>\n${markdown}\n</note>` }],
    });
    if (critique.stop_reason === "refusal") return { markdown, revised: false, issues: [] };
    const cText = critique.content.find((b) => b.type === "text");
    const parsed = JSON.parse(cText && "text" in cText ? cText.text : "{}") as {
      verdict?: string;
      issues?: { where: string; problem: string }[];
    };
    const issues = (parsed.issues ?? []).slice(0, 6).map((i) => `${i.where}: ${i.problem}`);
    if (parsed.verdict !== "revise" || issues.length === 0) {
      return { markdown, revised: false, issues };
    }

    const revision = await anthropic().messages.create({
      model: cfg.MEMO_MODEL,
      max_tokens: 20000,
      output_config: { effort: "medium" },
      system: REVISE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `<note>\n${markdown}\n</note>\n\n<editor_notes>\n${issues
            .map((i, n) => `${n + 1}. ${i}`)
            .join("\n")}\n</editor_notes>\n\nRevise the note.`,
        },
      ],
    });
    if (revision.stop_reason !== "end_turn") return { markdown, revised: false, issues };
    const revised = revision.content
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? b.text : ""))
      .join("")
      .trim();

    // Fail-safes: a revision that shrank the note or lost sections is worse
    // than the original — keep what the author wrote.
    const requiredSections = ["## The idea", "## Risks", "## What would change my mind"];
    const structureIntact =
      revised.startsWith("#") &&
      revised.length > markdown.length * 0.6 &&
      (markdown.includes("## Scorecard") /* follow-up format */ ||
        requiredSections.every((s) => revised.includes(s)));
    if (!structureIntact) return { markdown, revised: false, issues };

    return { markdown: revised, revised: true, issues };
  } catch (e) {
    console.error("Editorial pass failed (fail-open, sending author's cut):", e);
    return { markdown, revised: false, issues: [] };
  }
}
