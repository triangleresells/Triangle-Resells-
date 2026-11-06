const MAX_DM_CHARS = 1000;

export interface InstagramApi {
  sendText(recipientId: string, text: string): Promise<string | undefined>;
  sendPrivateReply(commentId: string, text: string): Promise<string | undefined>;
  replyToComment(commentId: string, text: string): Promise<void>;
  getUsername(userId: string): Promise<string | undefined>;
  /** Our own Instagram account id (from the webhook), used to find the right Facebook Page for EAA tokens. */
  setAccountId?(id: string): void;
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

/**
 * Sends DMs and comment replies.
 * - Instagram tokens (IG...) use graph.instagram.com, the Instagram Login API.
 * - Facebook-style tokens (EAA..., from Meta's Facebook/Unified login setup) use graph.facebook.com.
 *   A user token is swapped for the Page token of the Page linked to @triangleresells; a Page token is used as is.
 */
export class InstagramClient implements InstagramApi {
  private base: string;
  private facebook: boolean;
  private sendPath = "/me/messages";
  private resolved?: Promise<void>;
  private accountId?: string;

  constructor(
    private token: string,
    apiVersion: string,
    private fetchFn: typeof fetch = fetch,
  ) {
    this.facebook = token.startsWith("EAA");
    this.base = this.facebook ? `https://graph.facebook.com/${apiVersion}` : `https://graph.instagram.com/${apiVersion}`;
  }

  setAccountId(id: string): void {
    this.accountId ??= id;
  }

  /** Facebook-style tokens only: work out which token and path can send Instagram DMs. Runs once. */
  private ready(): Promise<void> {
    if (!this.facebook) return Promise.resolve();
    this.resolved ??= (async () => {
      try {
        const r = await this.rawCall("/me/accounts?fields=id,name,access_token,instagram_business_account");
        const pages: { id: string; name?: string; access_token?: string; instagram_business_account?: { id: string } }[] = r.data ?? [];
        const withIg = pages.filter((p) => p.instagram_business_account && p.access_token);
        const page = withIg.find((p) => p.instagram_business_account!.id === this.accountId) ?? withIg[0];
        if (page) {
          this.token = page.access_token!;
          this.sendPath = `/${page.id}/messages`;
          console.log(`[instagram] using the Facebook Page "${page.name ?? page.id}" linked to Instagram ${page.instagram_business_account!.id}`);
        } else if (this.accountId) {
          this.sendPath = `/${this.accountId}/messages`;
          console.log("[instagram] no Facebook Page found for this token; sending through the Instagram account directly");
        }
      } catch {
        // /me/accounts only works for user tokens. A Page token sends through /me/messages.
        console.log("[instagram] using the token as a Page token");
      }
    })();
    return this.resolved;
  }

  private async call(pathname: string, init: RequestInit = {}): Promise<any> {
    await this.ready();
    return this.rawCall(pathname, init);
  }

  private async rawCall(pathname: string, init: RequestInit = {}): Promise<any> {
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
      await this.ready();
      const r = await this.call(this.sendPath, {
        method: "POST",
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text: part } }),
      });
      lastId = r.message_id;
    }
    return lastId;
  }

  /** DMs someone who commented. Instagram allows one per comment, within 7 days. */
  async sendPrivateReply(commentId: string, text: string): Promise<string | undefined> {
    await this.ready();
    const r = await this.call(this.sendPath, {
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
