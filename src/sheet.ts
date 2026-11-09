import { createSign } from "node:crypto";
import { formatCatalog, parsePricesCsv, parseStockCsv, type Table } from "./catalog.js";
import type { PricingConfig } from "./pricing.js";

/**
 * Reads the warehouse sheet's BOT STOCK and BOT PRICES tabs with a Google service account.
 * The sheet stays private: it is only shared (Viewer) with the service account's email. Never published to the web.
 */

export const STOCK_TAB = "BOT STOCK";
export const PRICES_TAB = "BOT PRICES";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const CACHE_MS = 2 * 60 * 1000;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** GOOGLE_SERVICE_ACCOUNT_JSON: the whole key file, pasted as-is (or base64 of it). */
export function parseServiceAccount(raw: string): ServiceAccount | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const text = t.startsWith("{") ? t : Buffer.from(t, "base64").toString("utf8");
  try {
    const j = JSON.parse(text) as ServiceAccount;
    if (!j.client_email || !j.private_key) return undefined;
    // Some hosts turn the key's newlines into literal "\n".
    return { ...j, private_key: j.private_key.replace(/\\n/g, "\n") };
  } catch {
    return undefined;
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signedJwt(sa: ServiceAccount, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
}

export class GoogleSheetsReader {
  private token = "";
  private tokenExp = 0;

  constructor(
    private sa: ServiceAccount,
    private sheetId: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    const res = await this.fetchFn(this.sa.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedJwt(this.sa) }),
    });
    if (!res.ok) throw new Error(`Google token request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = j.access_token;
    this.tokenExp = Date.now() + j.expires_in * 1000;
    return this.token;
  }

  /** Returns each tab as rows of cells, in the order asked. */
  async tabs(tabs: string[]): Promise<string[][][]> {
    const qs = tabs.map((t) => `ranges=${encodeURIComponent(`'${t}'!A:Z`)}`).join("&");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.sheetId)}/values:batchGet?${qs}&valueRenderOption=FORMATTED_VALUE`;
    const res = await this.fetchFn(url, { headers: { authorization: `Bearer ${await this.accessToken()}` } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const hint = res.status === 403 ? ` (share the sheet with ${this.sa.client_email} as Viewer)` : res.status === 404 ? " (check WAREHOUSE_SHEET_ID)" : "";
      throw new Error(`Sheets API HTTP ${res.status}${hint}: ${body}`);
    }
    const j = (await res.json()) as { valueRanges?: { values?: string[][] }[] };
    return tabs.map((_, i) => j.valueRanges?.[i]?.values ?? []);
  }
}

export interface Catalog {
  pricing: PricingConfig;
  /** What the AI sees as the LIVE STOCK SHEET. */
  text: string;
  source: "sheet" | "snapshot";
}

export function catalogFrom(base: PricingConfig, stockCsv: Table, pricesCsv: Table, source: Catalog["source"]): Catalog {
  const stock = parseStockCsv(stockCsv);
  const parsed = parsePricesCsv(pricesCsv);
  const tables = Object.keys(parsed).length ? parsed : base.tables;
  const pricing: PricingConfig = { ...base, tables, stock };
  return { pricing, text: formatCatalog(stock, tables), source };
}

/**
 * Live stock and prices, cached for 2 minutes. If the sheet can't be read it keeps the last good copy,
 * and before the first good read it uses the committed snapshot (config/stock.csv + config/pricing.json).
 */
export class LiveCatalog {
  private cached: Catalog;
  private fetchedAt = 0;

  constructor(
    private snapshot: Catalog,
    private reader?: Pick<GoogleSheetsReader, "tabs">,
  ) {
    this.cached = snapshot;
  }

  async get(): Promise<Catalog> {
    if (!this.reader || Date.now() - this.fetchedAt < CACHE_MS) return this.cached;
    try {
      const [stock, prices] = await this.reader.tabs([STOCK_TAB, PRICES_TAB]);
      const next = catalogFrom(this.snapshot.pricing, stock, prices, "sheet");
      if (!next.pricing.stock?.length) throw new Error(`no rows found on the ${STOCK_TAB} tab`);
      this.cached = next;
    } catch (err) {
      console.error(`[sheet] could not read the warehouse sheet, using the ${this.cached.source === "sheet" ? "last good copy" : "saved snapshot"}:`, err);
    }
    // Retry failures after the same wait, so a bad key doesn't hammer Google on every DM.
    this.fetchedAt = Date.now();
    return this.cached;
  }
}
