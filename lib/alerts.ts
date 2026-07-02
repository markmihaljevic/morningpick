import { config } from "./config";
import { resend, fromAddress } from "./resend";

/**
 * Operational alerts to the admin. Never throws — an alerting failure must
 * not take down the pipeline it reports on.
 */
export async function sendAdminAlert(subject: string, lines: string[]): Promise<void> {
  const cfg = config();
  if (!cfg.ADMIN_EMAIL) return;
  try {
    await resend().emails.send({
      from: fromAddress(),
      to: cfg.ADMIN_EMAIL,
      subject: `[morningpick] ${subject}`,
      text: lines.join("\n"),
    });
  } catch (e) {
    console.error("Admin alert failed:", e);
  }
}
