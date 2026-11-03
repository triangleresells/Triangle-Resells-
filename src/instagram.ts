const MAX_DM_CHARS = 1000;

export interface InstagramApi {
  sendText(recipientId: string, text: string): Promise<string | undefined>;
  sendPrivateReply(commentId: string, text: string): Promise<string | undefined>;
  replyToComment(commentId: string, text: string): Promise<void>;
  getUsername(userId: string): Promise<string | undefined>;
}

/** Splits long replies into chunks under Instagram's 1,000-character DM limit. */
export function splitMessage(text: string, max = MAX_DM_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Instagram API with Instagram Login (graph.instagram.com). */
export class InstagramClient implements InstagramApi {
  private base: string;

  constructor(
    private token: string,
    apiVersion: string,
    private fetchFn: typeof fetch = fetch,
  ) {
    this.base = `https://graph.instagram.com/${apiVersion}`;
  }

  private async call(pathname: string, init: RequestInit = {}): Promise<any> {
    const res = await this.fetchFn(`${this.base}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Instagram API ${res.status} on ${pathname}: ${JSON.stringify(body?.error ?? body)}`);
    }
    return body;
  }

  async sendText(recipientId: string, text: string): Promise<string | undefined> {
    let lastId: string | undefined;
    for (const part of splitMessage(text)) {
      const r = await this.call("/me/messages", {
        method: "POST",
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text: part } }),
      });
      lastId = r.message_id;
    }
    return lastId;
  }

  /** DMs someone who commented. Instagram allows one per comment, within 7 days. */
  async sendPrivateReply(commentId: string, text: string): Promise<string | undefined> {
    const r = await this.call("/me/messages", {
      method: "POST",
      body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text: splitMessage(text)[0] } }),
    });
    return r.message_id;
  }

  async replyToComment(commentId: string, text: string): Promise<void> {
    await this.call(`/${commentId}/replies`, {
      method: "POST",
      body: JSON.stringify({ message: text }),
    });
  }

  async getUsername(userId: string): Promise<string | undefined> {
    try {
      const r = await this.call(`/${userId}?fields=username`);
      return r.username;
    } catch {
      return undefined;
    }
  }
}
