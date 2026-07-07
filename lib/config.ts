import { z } from "zod";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  MEMO_MODEL: z.string().default("claude-sonnet-5"),
  FEEDBACK_MODEL: z.string().default("claude-sonnet-5"),

  RESEND_API_KEY: z.string().min(1),
  RESEND_WEBHOOK_SECRET: z.string().min(1),

  FMP_API_KEY: z.string().min(1),
  FMP_BASE_URL: z.string().default("https://financialmodelingprep.com/stable"),
  FMP_DAILY_BUDGET: z.coerce.number().int().positive().default(230),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  CRON_SECRET: z.string().min(16),

  EMAIL_DOMAIN: z.string().min(1), // outbound sending domain, e.g. mail.example.com
  REPLY_DOMAIN: z.string().min(1), // inbound receiving domain, e.g. reply.example.com
  EMAIL_FROM_NAME: z.string().default("Morningpick"),
  APP_URL: z.string().url(), // e.g. https://example.com
  POSTAL_ADDRESS: z.string().min(1), // CAN-SPAM footer address

  DELIVERY_MODE: z.enum(["daily", "hourly"]).default("daily"),

  // Parallel worker chains kicked per morning run. Each chain processes ~1
  // memo per invocation and self-reinvokes; the SKIP LOCKED queue makes any
  // number of chains collision-free. Throughput ≈ chains × 20 memos/hour.
  // Size against your Anthropic rate limits.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),

  // Operational alerts (run digest, failed deliveries). Empty = disabled.
  ADMIN_EMAIL: z.string().email().or(z.literal("")).default(""),

  // A covered name moving this % since its last note triggers a follow-up.
  FOLLOWUP_MOVE_PCT: z.coerce.number().positive().default(15),

  // Attach the one-page tear-sheet PDF to daily notes. Off before a domain
  // warm-up if attachments dent inbox placement at scale.
  ATTACH_TEARSHEET: z.enum(["true", "false"]).default("true"),

  // The analyst persona's first name — greets and signs every note, same daily.
  ANALYST_NAME: z.string().default("Sam"),

  // Stripe (paid tier). All optional — billing routes no-op until configured.
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  STRIPE_PRICE_ID: z.string().default(""), // the $99/mo "The Desk" price
  STRIPE_PRICE_ID_MOI: z.string().default(""), // the $49/mo MOI Global member price
});

export type Config = z.infer<typeof envSchema>;

let cached: Config | null = null;

// Lazy so that `next build` doesn't require a fully populated environment.
export function config(): Config {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const missing = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid environment configuration — ${missing}`);
    }
    cached = parsed.data;
  }
  return cached;
}
