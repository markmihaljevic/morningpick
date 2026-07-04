import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: config().ANTHROPIC_API_KEY,
      // Explicit client timeout bypasses the SDK's "streaming required"
      // guard (which only reads the CLIENT-level timeout). 5 min: legitimate
      // tool rounds run 1-3 min; a hung request must die fast enough that
      // its retry still fits inside Vercel's 800s function ceiling.
      timeout: 5 * 60 * 1000,
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
