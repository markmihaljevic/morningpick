/**
 * Morningpick brand system — "dawn meets research desk".
 * Used by email templates and the PDF renderer; the website mirrors these
 * values in Tailwind classes.
 */
export const BRAND = {
  ink: "#10202F", // deep navy-black: mastheads, headings, body text
  paper: "#FBFAF6", // warm paper white: backgrounds
  gold: "#B08C3D", // rising-sun accent: links, marks, highlights
  slate: "#5C6670", // secondary text
  rule: "#E4E0D5", // hairline rules
  green: "#1E6E44",
  red: "#A3271E",
  serif: "Palatino, 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
  sans: "Helvetica, Arial, sans-serif",
} as const;

export const BRAND_NAME = "MORNINGPICK";
export const TAGLINE = "One idea. Every morning.";
