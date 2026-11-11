import type { Customer, OrderLabel } from "./store.js";

const DAY = 24 * 60 * 60 * 1000;

/** Customers whose saved interests or past orders mention the search words ("" = everyone). */
export function matchCustomers(customers: Customer[], search: string): Customer[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return customers;
  return customers.filter((c) => {
    const text = [...c.interests.map((i) => i.item), ...c.orders.map((o) => o.summary)].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

const csvCell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
const day = (t: number) => (t ? new Date(t).toISOString().slice(0, 10) : "");

/** The customer list as a spreadsheet: who they are, what they want, what they bought, and if the bot can DM them now. */
export function customersCsv(customers: Customer[], now = Date.now()): string {
  const rows = [["username", "instagram", "wants", "orders", "total spent", "last message", "bot can DM now"]];
  for (const c of [...customers].sort((a, b) => b.lastMessageAt - a.lastMessageAt)) {
    rows.push([
      c.username ?? `user ${c.userId}`,
      c.username ? `https://instagram.com/${c.username}` : "",
      c.interests.map((i) => i.item).join("; "),
      String(c.orders.length),
      String(c.orders.reduce((s, o) => s + o.total, 0)),
      day(c.lastMessageAt),
      now - c.lastMessageAt < DAY ? "yes" : "no (DM them yourself)",
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

/** Tiny page Josh opens on his phone: search the list, download it, and send a restock DM. */
export function adminPage(key: string, result?: { sent: Customer[]; manual: Customer[]; message: string }, labels: OrderLabel[] = [], notice = ""): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const who = (c: Customer) =>
    c.username ? `<a href="https://ig.me/m/${esc(c.username)}">@${esc(c.username)}</a>` : `user ${esc(c.userId)}`;
  const list = (cs: Customer[]) => (cs.length ? `<ul>${cs.map((c) => `<li>${who(c)} – ${esc(c.interests.at(-1)?.item ?? "")}</li>`).join("")}</ul>` : "<p>None.</p>");
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Triangle customers</title>
<style>body{font:16px system-ui;margin:16px;max-width:640px;background:#0B0B0B;color:#eee}a{color:#D4A017}input,textarea,button{font:inherit;width:100%;margin:6px 0;padding:10px;box-sizing:border-box}button{background:#D4A017;border:0;font-weight:600}</style>
${notice ? `<p><b>${esc(notice)}</b></p>` : ""}
<h1>🔺 Orders</h1>
${labelsHtml(labels, key, esc)}
<h1>🔺 Customer list</h1>
<p><a href="/admin/customers.csv?key=${encodeURIComponent(key)}">Download everyone (spreadsheet)</a></p>
<form method="post" action="/admin/unpause?key=${encodeURIComponent(key)}"><button>Turn the bot back on in all paused chats</button></form>
<h2>Restock blast</h2>
<form method="post" action="/admin/blast?key=${encodeURIComponent(key)}">
<label>Who: words from what they wanted (blank = everyone)<input name="search" placeholder="essentials hoodie"></label>
<label>Message<textarea name="message" rows="3" required placeholder="Essentials hoodies just landed, black in XS and L. Want me to set you up?"></textarea></label>
<button>Send</button></form>
<p>Instagram only lets the bot DM people who messaged in the last 24 hours. Everyone else shows up below with a link so you can DM them yourself.</p>
${result ? `<h2>Sent by the bot (${result.sent.length})</h2>${list(result.sent)}<h2>DM these yourself (${result.manual.length})</h2>${list(result.manual)}<p>Message: ${esc(result.message)}</p>` : ""}`;
}

/** PAID and BOOKED orders, newest first, each with a link to the DM and buttons to mark paid / clear. */
function labelsHtml(labels: OrderLabel[], key: string, esc: (s: string) => string): string {
  const k = encodeURIComponent(key);
  const btn = (action: string, id: string, text: string) =>
    `<form method="post" action="/admin/labels/${action}?key=${k}" style="display:inline"><input type="hidden" name="id" value="${esc(id)}"><button style="width:auto;padding:6px 10px">${text}</button></form>`;
  const row = (l: OrderLabel) => {
    const who = l.username ? `<a href="https://ig.me/m/${esc(l.username)}">@${esc(l.username)}</a>` : `user ${esc(l.userId)}`;
    const tag = l.label === "PAID" ? "🟢 PAID" : "🟡 BOOKED";
    const says = l.saysPaid ? `<br>💸 <b>Says they paid</b> (${esc(l.saysPaid)}). Check your app before marking paid.` : "";
    const ship = l.shipTo ? `<br>📦 ${esc([l.shipTo.name, l.shipTo.street, l.shipTo.apt, `${l.shipTo.city}, ${l.shipTo.state} ${l.shipTo.zip}`].filter(Boolean).join(", "))}` : "";
    return `<li><b>${tag}</b> ${who} – $${l.total} (${esc(l.payment)})<br>${esc(l.summary)}${ship}${says}<br><small>${esc(l.when)} · ${new Date(l.createdAt).toLocaleString("en-US", { timeZone: "America/New_York" })}</small><br>${
      l.label === "BOOKED" ? btn("paid", l.id, "Mark paid") + " " : ""
    }${btn("clear", l.id, "Done, clear label")} ${btn("cancel", l.id, "Cancel (put stock back)")}</li>`;
  };
  if (!labels.length) return "<p>No open orders.</p>";
  return `<ul>${labels.map(row).join("")}</ul><form method="post" action="/admin/labels/clear-all?key=${k}"><button>Clear all PAID labels (end of day)</button></form>`;
}
