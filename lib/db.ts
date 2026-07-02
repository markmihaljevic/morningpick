// NOTE: server-side only — never import from a client component. The service
// role key bypasses RLS.
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";

let client: SupabaseClient | null = null;

// Service-role client — server routes only. RLS is deny-all for other keys.
export function db(): SupabaseClient {
  if (!client) {
    const cfg = config();
    client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export async function logEvent(
  type: string,
  opts: { subscriberId?: string; payload?: unknown; ipHash?: string } = {},
): Promise<void> {
  await db().from("events").insert({
    type,
    subscriber_id: opts.subscriberId ?? null,
    payload: opts.payload ?? null,
    ip_hash: opts.ipHash ?? null,
  });
}
