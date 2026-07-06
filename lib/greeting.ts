/**
 * The name for "Good morning, {name},". Prefers a stored first name; falls
 * back to the email's local part only when it plausibly IS a name (letters,
 * no digits). "john@" → "John"; "mark.smith@" → "Mark"; "markmih99@" → none
 * (we'd rather greet with no name than a handle).
 */
export function greetingName(email: string, firstName?: string | null): string | null {
  const stored = (firstName ?? "").trim();
  if (stored) return capitalize(stored.split(/\s+/)[0]);

  const local = (email.split("@")[0] ?? "").trim();
  const token = local.split(/[._+\-]/)[0];
  if (/^[a-zA-Z]{2,20}$/.test(token)) return capitalize(token);
  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
