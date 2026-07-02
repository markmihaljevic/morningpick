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
  BATCH_SIZE: z.coerce.number().int().positive().default(3),

  // Operational alerts (run digest, failed deliveries). Empty = disabled.
  ADMIN_EMAIL: z.string().email().or(z.literal("")).default(""),
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
