/**
 * Chats + Knowledge in the team's phone CRM. Every DM (buyer, bot, team typing in Instagram) is saved to the
 * `conversations` / `messages` tables; "Take over" in the app sets bot_silent and the bot stays quiet in that chat.
 * Learning loop: when the bot passed a question to the team (quick sec) and a team member answers it in the chat,
 * that pair goes to `knowledge_base` as pending. Approved answers are given to the bot on every reply.
 *
 * Writes use SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (server-side only). Logging never breaks or slows a reply:
 * every call is best effort.
 */
export type ChatRole = "customer" | "bot" | "agent";

export interface ChatLog {
  message(userId: string, role: ChatRole, text: string, opts?: { username?: string; mid?: string; isTest?: boolean }): Promise<void>;
  setNeedsHuman(userId: string, needsHuman: boolean): Promise<void>;
  isSilent(userId: string): Promise<boolean>;
  propose(userId: string, question: string, answer: string, isTest?: boolean): Promise<void>;
  /** Approved team answers, formatted for the bot's context ("" if none). */
  approvedText(): Promise<string>;
}

const SILENT_CACHE_MS = 10_000;
const KNOWLEDGE_CACHE_MS = 5 * 60_000;

export function supabaseChatLog(supabaseUrl: string, serviceKey: string, fetchFn: typeof fetch = fetch, now: () => number = Date.now): ChatLog {
  const base = supabaseUrl.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "").replace(/\/+$/, "") + "/rest/v1";
  const headers = (prefer?: string): Record<string, string> => ({
    apikey: serviceKey,
    ...(serviceKey.startsWith("sb_") ? {} : { Authorization: `Bearer ${serviceKey}` }),
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  });
  const req = async (path: string, init: RequestInit): Promise<Response> => {
    const res = await fetchFn(`${base}${path}`, init);
    if (!res.ok && res.status !== 409) throw new Error(`chat log HTTP ${res.status} on ${path.split("?")[0]}`);
    return res;
  };
  const quiet = (what: string) => (err: unknown) => console.error(`[chats] ${what} failed:`, (err as Error).message ?? err);
  const silent = new Map<string, { value: boolean; at: number }>();
  let knowledge: { text: string; at: number } | undefined;

  const upsertConversation = (userId: string, fields: Record<string, unknown>) =>
    req(`/conversations?on_conflict=id`, {
      method: "POST",
      headers: headers("resolution=merge-duplicates,return=minimal"),
      body: JSON.stringify({ id: userId, ig_user_id: userId, updated_at: new Date(now()).toISOString(), ...fields }),
    });

  return {
    async message(userId, role, text, opts = {}) {
      if (!text.trim()) return;
      const at = new Date(now()).toISOString();
      try {
        await upsertConversation(userId, {
          last_message_at: at,
          ...(opts.username ? { ig_handle: opts.username } : {}),
          ...(opts.isTest ? { is_test: true } : {}),
        });
        await req(`/messages${opts.mid ? "?on_conflict=ig_mid" : ""}`, {
          method: "POST",
          headers: headers(`${opts.mid ? "resolution=ignore-duplicates," : ""}return=minimal`),
          body: JSON.stringify({ conversation_id: userId, role, text: text.slice(0, 4000), ig_mid: opts.mid ?? null, created_at: at, ...(opts.isTest ? { is_test: true } : {}) }),
        });
      } catch (err) {
        quiet("saving a message")(err);
      }
    },
    async setNeedsHuman(userId, needsHuman) {
      await upsertConversation(userId, { needs_human: needsHuman }).then(() => undefined, quiet("needs-human flag"));
    },
    async isSilent(userId) {
      const hit = silent.get(userId);
      if (hit && now() - hit.at < SILENT_CACHE_MS) return hit.value;
      try {
        const res = await req(`/conversations?id=eq.${encodeURIComponent(userId)}&select=bot_silent`, { method: "GET", headers: headers() });
        const rows = (await res.json()) as { bot_silent?: boolean }[];
        const value = rows[0]?.bot_silent === true;
        silent.set(userId, { value, at: now() });
        return value;
      } catch (err) {
        quiet("reading Take over")(err);
        return hit?.value ?? false; // can't reach it: keep the last known answer
      }
    },
    async propose(userId, question, answer, isTest) {
      if (!question.trim() || !answer.trim()) return;
      await req(`/knowledge_base`, {
        method: "POST",
        headers: headers("return=minimal"),
        body: JSON.stringify({ question: question.slice(0, 500), answer: answer.slice(0, 2000), source_conversation_id: userId, ...(isTest ? { is_test: true } : {}) }),
      }).then(() => undefined, quiet("proposing a knowledge answer"));
    },
    async approvedText() {
      if (knowledge && now() - knowledge.at < KNOWLEDGE_CACHE_MS) return knowledge.text;
      try {
        const res = await req(`/knowledge_base?status=eq.approved&is_test=eq.false&select=question,answer&order=created_at.desc&limit=100`, { method: "GET", headers: headers() });
        const rows = (await res.json()) as { question: string; answer: string }[];
        const text = rows.length
          ? `\n\nTEAM-APPROVED ANSWERS (Josh approved these; use them, they count like the knowledge base)\n${rows.map((r) => `- Q: ${r.question}\n  A: ${r.answer}`).join("\n")}`
          : "";
        knowledge = { text, at: now() };
        return text;
      } catch (err) {
        quiet("reading approved answers")(err);
        return knowledge?.text ?? "";
      }
    },
  };
}
