// Triangle CRM: login, month calendar, each day's bookings with big status buttons, add / edit, history + undo.
// Reads and writes ONLY through the database functions (every change is logged with who did it).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm";
import * as L from "./lib.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const opts = (list, val) => list.map((o) => `<option value="${esc(o.key)}" ${o.key === val ? "selected" : ""}>${esc(o.label)}</option>`).join("");

const state = {
  sb: null,
  me: null,                 // team member name
  view: new Date(),         // month shown
  sel: L.isoDate(new Date()),
  bookings: {},             // date -> bookings
  includeTest: false,
  editing: null,            // null | "new" | booking id
  history: null,            // booking id whose history is open
  historyRows: [],
};

function banner(msg, ok = false) {
  const b = $("banner");
  b.textContent = msg;
  b.className = "banner" + (ok ? " ok" : "");
  b.hidden = false;
  clearTimeout(banner.t);
  banner.t = setTimeout(() => (b.hidden = true), ok ? 3000 : 8000);
}

async function rpc(fn, args) {
  const { data, error } = await state.sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

// ---------- login ----------
function renderLogin(msg = "") {
  $("who").innerHTML = "";
  $("main").innerHTML = `<form class="panel stack login" id="loginF">
    <h2>Log in</h2>
    <div class="fld"><label for="em">Email</label><input id="em" type="email" autocomplete="username" required></div>
    <div class="fld"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
    ${msg ? `<p class="muted">${esc(msg)}</p>` : ""}
    <button class="btn gold">Log in</button>
  </form>`;
  $("loginF").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await state.sb.auth.signInWithPassword({ email: $("em").value.trim(), password: $("pw").value });
    if (error) renderLogin("That email and password didn't work.");
  };
}

async function whoAmI() {
  const { data } = await state.sb.from("team_members").select("name, user_id");
  const { data: u } = await state.sb.auth.getUser();
  return data?.find((m) => m.user_id === u.user?.id)?.name ?? null;
}

// ---------- data ----------
function gridRange() {
  const g = L.monthGrid(state.view.getFullYear(), state.view.getMonth());
  return [g[0].iso, g.at(-1).iso];
}

async function load() {
  const [from, to] = gridRange();
  try {
    const rows = await rpc("bookings_between", { p_from: from, p_to: to, p_include_test: state.includeTest });
    state.bookings = L.groupByDate(rows ?? []);
  } catch (e) {
    banner("Couldn't load bookings: " + e.message);
  }
  render();
}

let reloadT;
function reloadSoon() {
  clearTimeout(reloadT);
  reloadT = setTimeout(load, 300);
}

// ---------- render ----------
function render() {
  $("who").innerHTML = `<span>${esc(state.me)}</span><button class="link" id="out">Log out</button>`;
  $("out").onclick = () => state.sb.auth.signOut();
  $("main").innerHTML = `<div class="layout">
    <section class="panel" aria-labelledby="calH">
      <div class="spread" style="margin-bottom:8px">
        <h2 id="calH">${esc(state.view.toLocaleDateString("en-US", { month: "long", year: "numeric" }))}</h2>
        <div class="row">
          <button class="btn small" id="prev" aria-label="Previous month">‹</button>
          <button class="btn small" id="today">Today</button>
          <button class="btn small" id="next" aria-label="Next month">›</button>
        </div>
      </div>
      <div class="dows">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div>${d}</div>`).join("")}</div>
      <div class="grid" id="cal">${calendarHtml()}</div>
      <label class="toggle" style="margin-top:10px"><input type="checkbox" id="tst" ${state.includeTest ? "checked" : ""}> Show TEST bookings</label>
    </section>
    <section class="panel stack" aria-labelledby="dayH">${dayHtml()}</section>
  </div>`;
  $("prev").onclick = () => { state.view = new Date(state.view.getFullYear(), state.view.getMonth() - 1, 1); load(); };
  $("next").onclick = () => { state.view = new Date(state.view.getFullYear(), state.view.getMonth() + 1, 1); load(); };
  $("today").onclick = () => { state.view = new Date(); state.sel = L.isoDate(new Date()); state.editing = null; load(); };
  $("tst").onchange = (e) => { state.includeTest = e.target.checked; load(); };
  $("cal").onclick = (e) => {
    const b = e.target.closest("[data-d]");
    if (!b) return;
    state.sel = b.dataset.d; state.editing = null; state.history = null; render();
  };
  wireDay();
}

function calendarHtml() {
  const today = L.isoDate(new Date());
  return L.monthGrid(state.view.getFullYear(), state.view.getMonth()).map((d) => {
    const c = L.dayCounts(state.bookings[d.iso] ?? []);
    return `<button class="day ${d.inMonth ? "" : "out"} ${d.iso === today ? "today" : ""} ${d.iso === state.sel ? "sel" : ""}" data-d="${d.iso}"
        aria-label="${esc(L.parseIso(d.iso).toDateString())}: ${c.open} to fulfill, ${c.done} done, ${c.red} cancelled or no-show">
      <span class="n">${d.day}</span>
      ${c.open ? `<span class="chip open">${c.open} to fill</span>` : ""}
      ${c.done ? `<span class="chip done">${c.done} done</span>` : ""}
      ${c.red ? `<span class="chip red">${c.red} ✕</span>` : ""}
    </button>`;
  }).join("");
}

function dayHtml() {
  const list = state.bookings[state.sel] ?? [];
  const c = L.dayCounts(list);
  const title = L.parseIso(state.sel).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  return `<div class="spread">
      <h3 id="dayH">${esc(title)}</h3>
      <button class="btn gold small" id="add">+ Add sale</button>
    </div>
    <div class="meta"><span>To fulfill <b>${c.open}</b></span><span>Done <b>${c.done}</b></span><span>Cancelled / no-show <b>${c.red}</b></span></div>
    ${state.editing === "new" ? formHtml(null) : ""}
    ${list.length ? list.map((b) => (state.editing === b.id ? formHtml(b) : cardHtml(b))).join("") : state.editing === "new" ? "" : `<div class="empty">No sales booked for this day.</div>`}`;
}

function cardHtml(b) {
  const st = L.statusOf(b.status);
  const red = L.isRed(b.status);
  const fees = [b.delivery_fee > 0 ? `delivery fee ${L.money(b.delivery_fee)}` : "", b.shipping_fee > 0 ? `shipping ${L.money(b.shipping_fee)}` : ""].filter(Boolean).join(", ");
  return `<article class="card ${st.tone}" data-id="${b.id}">
    <div class="spread">
      <span class="buyer">${esc(L.customerName(b.customer))}${b.customer?.ig_handle && b.customer?.name ? ` <span class="muted">@${esc(b.customer.ig_handle)}</span>` : ""}</span>
      <span class="price">${L.money(b.sale_price)}</span>
    </div>
    ${red ? `<div><span class="redtag">${esc(st.label)}</span>${b.status_reason ? ` <span class="muted">${esc(b.status_reason)}</span>` : ""}</div>` : ""}
    ${b.status === "paid_needs_check" ? `<div><span class="checktag">Paid - needs check</span> <span class="muted">Check the app, then tap Paid.</span></div>` : ""}
    <ul class="items">${b.items.map((i) => `<li>${esc(L.itemLine(i))}${i.unit_price != null ? ` <span class="muted">@ ${L.money(i.unit_price)}</span>` : ""}</li>`).join("")}</ul>
    <div class="meta">
      ${b.time ? `<span><b>${esc(L.fmtTime(b.time))}</b></span>` : ""}
      <span>${esc(L.labelOf(L.FULFILLMENT, b.fulfillment))}</span>
      ${b.location ? `<span>${esc(b.location)}</span>` : ""}
      <span>${esc(L.labelOf(L.PAYMENTS, b.payment_method))}</span>
      <span>Fulfilling: <b>${esc(b.assignee || "Unassigned")}</b></span>
      <span>${esc(L.labelOf(L.SOURCES, b.source))}${b.source_account ? ` · ${esc(b.source_account)}` : ""}</span>
      ${fees ? `<span>${esc(fees)} (not revenue)</span>` : ""}
      ${b.tracking_number ? `<span>Tracking <b>${esc(b.tracking_number)}</b></span>` : ""}
      ${b.customer?.phone ? `<span>${esc(b.customer.phone)}</span>` : ""}
      <span>by ${esc(b.created_by)}</span>
    </div>
    ${b.notes ? `<div class="meta">${esc(b.notes)}</div>` : ""}
    <div class="status" role="group" aria-label="Status">
      ${L.STATUS_BUTTONS.map((k) => {
        const s = L.statusOf(k);
        const on = b.status === k;
        return `<button class="st ${s.tone} ${on ? "on" : ""}" data-st="${k}" aria-pressed="${on}">${esc(k === "paid" && b.status === "paid_needs_check" ? "Confirm paid" : s.label)}</button>`;
      }).join("")}
    </div>
    <div class="row">
      <button class="link" data-edit>Edit / reschedule</button>
      <button class="link" data-hist>${state.history === b.id ? "Hide history" : "History"}</button>
    </div>
    ${state.history === b.id ? historyHtml() : ""}
  </article>`;
}

function historyHtml() {
  if (!state.historyRows.length) return `<div class="history muted">No history yet.</div>`;
  return `<div class="history">${state.historyRows.map((a) => `<div class="h">
      <span><b>${esc(a.actor)}</b> · ${esc(L.activityLine(a))}<br><span class="muted">${esc(new Date(a.at).toLocaleString("en-US"))}</span></span>
      ${a.undo_of ? `<span class="muted">undo</span>` : `<button class="link" data-undo="${a.id}">Undo</button>`}
    </div>`).join("")}</div>`;
}

function formHtml(b) {
  const v = b ?? { date: state.sel, payment_method: "cash", fulfillment: "pickup", source: "in_person", assignee: state.me, items: [{}] };
  const c = b?.customer ?? {};
  const items = v.items?.length ? v.items : [{}];
  const itemRow = (i, n) => `<div class="itemrow" data-row>
      <div class="fld"><label>Brand</label><input name="brand" value="${esc(i.brand)}"></div>
      <div class="fld"><label>Item${n === 0 ? " *" : ""}</label><input name="item" value="${esc(i.item)}"></div>
      <div class="fld"><label>Color</label><input name="color" value="${esc(i.color)}"></div>
      <div class="fld"><label>Size *</label><input name="size" value="${esc(i.size)}" placeholder="M / One Size"></div>
      <div class="fld"><label>Qty</label><input name="qty" type="number" min="1" step="1" inputmode="numeric" value="${esc(i.qty ?? 1)}"></div>
      <div class="fld"><label>$ each</label><input name="unit_price" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(i.unit_price)}"></div>
      <button type="button" class="link danger" data-delrow aria-label="Remove item">✕</button>
    </div>`;
  return `<form class="panel f" id="bf">
    <div class="full spread"><h2>${b ? "Edit sale" : "New sale"}</h2></div>
    <div class="fld"><label for="f_date">Date *</label><input id="f_date" name="date" type="date" required value="${esc(v.date)}"></div>
    <div class="fld"><label for="f_time">Time</label><input id="f_time" name="time" type="time" value="${esc((v.time ?? "").slice(0, 5))}"></div>
    <div class="fld"><label for="f_ig">Buyer IG handle</label><input id="f_ig" name="ig_handle" value="${esc(c.ig_handle ? "@" + c.ig_handle : "")}" placeholder="@handle"></div>
    <div class="fld"><label for="f_name">Buyer name</label><input id="f_name" name="name" value="${esc(c.name)}"></div>
    <div class="fld"><label for="f_phone">Phone</label><input id="f_phone" name="phone" type="tel" value="${esc(c.phone)}"></div>
    <div class="fld"><label for="f_sale">Sale price (items total)</label><input id="f_sale" name="sale_price" type="number" min="0" step="0.01" inputmode="decimal" value="${b ? esc(b.sale_price) : ""}" placeholder="Blank = add up item prices"></div>
    <div class="full stack" id="rows">${items.map(itemRow).join("")}</div>
    <div class="full"><button type="button" class="btn small" id="addrow">+ Item</button></div>
    <div class="fld"><label for="f_pay">Payment</label><select id="f_pay" name="payment_method">${opts(L.PAYMENTS, v.payment_method)}</select></div>
    <div class="fld"><label for="f_ful">Fulfillment</label><select id="f_ful" name="fulfillment">${opts(L.FULFILLMENT, v.fulfillment)}</select></div>
    <div class="fld"><label for="f_dfee">Delivery fee (not revenue)</label><select id="f_dfee" name="delivery_fee"><option value="0">None</option>${L.DELIVERY_FEES.map((d) => `<option value="${d.fee}" ${Number(v.delivery_fee) === d.fee ? "selected" : ""}>${esc(d.label)}: $${d.fee}</option>`).join("")}</select></div>
    <div class="fld"><label for="f_ship">Shipping charged</label><input id="f_ship" name="shipping_fee" type="number" min="0" step="0.01" value="${esc(b ? b.shipping_fee : 10)}"></div>
    <div class="fld"><label for="f_label">Label cost</label><input id="f_label" name="label_cost" type="number" min="0" step="0.01" value="${esc(b?.label_cost ?? "")}"></div>
    <div class="fld"><label for="f_track">Tracking number</label><input id="f_track" name="tracking_number" value="${esc(b?.tracking_number)}"></div>
    <div class="fld full"><label for="f_loc">Location / address</label><input id="f_loc" name="location" value="${esc(v.location)}" placeholder="Warehouse, meetup spot, or shipping address"></div>
    <div class="fld"><label for="f_who">Who's fulfilling</label><select id="f_who" name="assignee"><option value="">Unassigned</option>${opts(L.TEAM.map((n) => ({ key: n, label: n })), v.assignee)}</select></div>
    <div class="fld"><label for="f_src">Source</label><select id="f_src" name="source">${opts(L.SOURCES, v.source)}</select></div>
    <div class="fld"><label for="f_acct">IG account</label><select id="f_acct" name="source_account"><option value="">—</option>${opts(L.ACCOUNTS.map((n) => ({ key: n, label: n })), v.source_account)}</select></div>
    <div class="fld full"><label for="f_notes">Notes</label><textarea id="f_notes" name="notes">${esc(v.notes)}</textarea></div>
    <div class="full spread">
      <button type="button" class="btn" id="cancelF">Cancel</button>
      <button class="btn gold">${b ? "Save changes" : "Add sale"}</button>
    </div>
  </form>`;
}

function readForm(form) {
  const f = Object.fromEntries(new FormData(form).entries());
  f.items = [...form.querySelectorAll("[data-row]")].map((r) => Object.fromEntries(["brand", "item", "color", "size", "qty", "unit_price"].map((k) => [k, r.querySelector(`[name=${k}]`).value])));
  return f;
}

function wireDay() {
  $("add").onclick = () => { state.editing = "new"; render(); $("f_ig")?.focus(); };
  const form = $("bf");
  if (form) {
    $("cancelF").onclick = () => { state.editing = null; render(); };
    $("addrow").onclick = () => {
      const tmp = document.createElement("div");
      tmp.innerHTML = formHtml({ date: state.sel, items: [{}] });
      $("rows").append(tmp.querySelector("[data-row]"));
    };
    $("rows").onclick = (e) => {
      if (e.target.closest("[data-delrow]") && $("rows").children.length > 1) e.target.closest("[data-row]").remove();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const r = L.bookingPayload(readForm(form));
      if (r.error) return banner(r.error);
      const btn = form.querySelector("button.gold");
      btn.disabled = true;
      try {
        if (state.editing === "new") await rpc("create_booking", { p: r.payload });
        else await rpc("update_booking", { p_id: state.editing, p: r.payload });
        state.sel = r.payload.date;
        state.editing = null;
        banner("Saved.", true);
        await load();
      } catch (err) {
        banner("Not saved: " + err.message);
        btn.disabled = false;
      }
    };
  }
  document.querySelectorAll(".card").forEach((card) => {
    const id = card.dataset.id;
    card.onclick = async (e) => {
      const st = e.target.closest("[data-st]");
      if (st) {
        let reason = null;
        if (st.dataset.st === "cancelled" || st.dataset.st === "no_show") {
          reason = prompt(st.dataset.st === "cancelled" ? "Why was it cancelled? (optional)" : "Any note on the no-show? (optional)");
          if (reason === null) return;
        }
        try {
          await rpc("set_booking_status", { p_id: id, p_status: st.dataset.st, p_reason: reason });
          await load();
          if (state.history === id) await openHistory(id);
        } catch (err) { banner("Not saved: " + err.message); }
      }
      if (e.target.closest("[data-edit]")) { state.editing = id; state.history = null; render(); }
      if (e.target.closest("[data-hist]")) {
        if (state.history === id) { state.history = null; render(); } else await openHistory(id);
      }
      const u = e.target.closest("[data-undo]");
      if (u) {
        if (!confirm("Undo this change?")) return;
        try { await rpc("undo_activity", { p_id: Number(u.dataset.undo) }); banner("Undone.", true); await load(); await openHistory(id); }
        catch (err) { banner("Couldn't undo: " + err.message); }
      }
    };
  });
}

async function openHistory(id) {
  try {
    state.historyRows = await rpc("recent_activity", { p_limit: 50, p_entity: "bookings", p_entity_id: id });
    state.history = id;
  } catch (err) { banner("Couldn't load history: " + err.message); }
  render();
}

// ---------- start ----------
async function start() {
  let cfg;
  try {
    cfg = await (await fetch("/api/config")).json();
    if (!cfg.supabaseUrl || !cfg.anonKey) throw new Error("not configured");
  } catch {
    $("main").innerHTML = `<p class="banner">The CRM isn't connected to its database yet.</p>`;
    return;
  }
  state.sb = createClient(cfg.supabaseUrl, cfg.anonKey);
  state.sb.channel("bookings").on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, reloadSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "booking_items" }, reloadSoon).subscribe();
  state.sb.auth.onAuthStateChange(async (_e, session) => {
    if (!session) return renderLogin();
    state.me = await whoAmI();
    if (!state.me) {
      await state.sb.auth.signOut();
      return renderLogin("This login isn't on the Triangle team.");
    }
    load();
  });
}
start();
