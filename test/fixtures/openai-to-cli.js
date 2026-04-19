// FIXTURE ONLY — synthetic stand-in for claude-max-api-proxy's openai-to-cli.js.
// Mirrors only the three call-sites patch-adapter.mjs rewrites, and the anchor
// "export function messagesToPrompt(" it inserts the helper before.

export function messagesToPrompt(messages) {
  const parts = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      parts.push(`<system>\n${msg.content}\n</system>\n`);
    } else if (msg.role === "user") {
      parts.push(msg.content);
    } else if (msg.role === "assistant") {
      parts.push(`<previous_response>\n${msg.content}\n</previous_response>\n`);
    }
  }
  return parts.join("");
}
