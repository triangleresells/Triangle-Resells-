/**
 * POST /team/assistant: the CRM page sends {messages} with the person's login token. Checks the request, finds out who
 * it is (only Josh, Chema and Diego get an answer), and runs the assistant as them.
 */
import type { AssistantMessage, ChatImage, TeamAssistant, UserDb } from "./assistant.js";
import { UserDbError } from "./assistant.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_MESSAGES = 40;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 5_000_000;

/** The chat history from the page, or why it's not acceptable. */
export function parseMessages(body: unknown): { messages: AssistantMessage[] } | { error: string } {
  const raw = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(raw) || !raw.length) return { error: "messages must be a non-empty list" };
  if (raw.length > MAX_MESSAGES) return { error: `at most ${MAX_MESSAGES} messages` };
  const messages: AssistantMessage[] = [];
  for (const m of raw) {
    const role = (m as AssistantMessage)?.role;
    const text = (m as AssistantMessage)?.text;
    if (role !== "user" && role !== "assistant") return { error: "each message needs role user or assistant" };
    if (typeof text !== "string" || text.length > 8000) return { error: "each message needs text (8000 characters max)" };
    const imgs = (m as AssistantMessage).images ?? [];
    if (!Array.isArray(imgs) || imgs.length > MAX_IMAGES) return { error: `at most ${MAX_IMAGES} pictures per message` };
    const images: ChatImage[] = [];
    for (const i of imgs) {
      if (!IMAGE_TYPES.has(i?.mediaType) || typeof i?.data !== "string" || !i.data || i.data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(i.data)) {
        return { error: "pictures must be PNG, JPEG, WebP or GIF, under 3.5 MB" };
      }
      images.push({ mediaType: i.mediaType, data: i.data });
    }
    if (!text.trim() && !images.length) return { error: "empty message" };
    messages.push({ role, text, ...(images.length ? { images } : {}) });
  }
  if (messages[messages.length - 1].role !== "user") return { error: "the last message must be yours" };
  // The model needs the conversation to start with the person.
  while (messages.length && messages[0].role !== "user") messages.shift();
  return { messages };
}

export function assistantHandler(d: { assistant: Pick<TeamAssistant, "chat">; dbFor: (token: string) => UserDb; now?: () => Date }) {
  return async (token: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const parsed = parseMessages(body);
    if ("error" in parsed) return { status: 400, body: { error: parsed.error } };
    const db = d.dbFor(token);
    let who: string | null;
    try {
      who = await db.rpc<string | null>("whoami", {});
    } catch (err) {
      const status = err instanceof UserDbError && err.status < 500 ? 401 : 502;
      return { status, body: { error: status === 401 ? "Your login expired. Log in again." : "Can't reach the CRM right now." } };
    }
    if (!who) return { status: 403, body: { error: "This login isn't on the Triangle team." } };
    const result = await d.assistant.chat(db, who, parsed.messages, d.now?.() ?? new Date());
    return { status: 200, body: { who, ...result } };
  };
}
