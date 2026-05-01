// Fixture: pre-patch openai-to-cli.js (matches live vendored proxy shape, post-extractContent patch)
// @openclaw-bridge:extractContent v1
function extractContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(p => (p && p.type === "text" && typeof p.text === "string") ? p.text : "").filter(Boolean).join("\n");
  return String(c == null ? "" : c);
}
export function messagesToPrompt(messages) {
    const parts = [];
    for (const msg of messages) {
        switch (msg.role) {
            case "system":
                // System messages become context instructions
                parts.push(`<system>\n${extractContent(msg.content)}\n</system>\n`);
                break;
            case "user":
                parts.push(extractContent(msg.content));
                break;
        }
    }
    return parts.join("\n").trim();
}
export function openaiToCli(request) {
    return {
        prompt: messagesToPrompt(request.messages),
        model: extractModel(request.model),
        sessionId: request.user, // Use OpenAI's user field for session mapping
    };
}
