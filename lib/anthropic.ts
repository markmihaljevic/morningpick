import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: config().ANTHROPIC_API_KEY,
      // Explicit client timeout: the SDK's "streaming required over 10 min"
      // guard only respects the CLIENT-level timeout, and 24k max_tokens on
      // the memo call trips its estimate. Real calls finish in 2-4 minutes.
      timeout: 10 * 60 * 1000,
    });
  }
  return client;
}

export function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
