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
  tab: "calendar",
  money: { month: L.thisMonth(), chart: false, months: [], report: null, filters: {} },
  customers: { sort: "top_spenders", search: "", list: [], open: null },
  cash: { day: L.isoDate(new Date()), report: null },
  stock: { rows: [], restocks: [], search: "", editing: null },
  chat: { messages: [], pending: [], draft: "", busy: false },
  videos: { day: L.isoDate(new Date()), data: null, busy: false },
  assistantUrl: "",
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
const TABS = [
  { key: "calendar", label: "Calendar" },
  { key: "assistant", label: "Assistant" },
  { key: "money", label: "Money" },
  { key: "videos", label: "Videos" },
  { key: "stock", label: "Stock" },
  { key: "customers", label: "Customers" },
  { key: "cash", label: "Cash" },
];

function tabsHtml() {
  return `<nav class="tabs" role="tablist">${TABS.map((t) => `<button role="tab" class="tab ${state.tab === t.key ? "on" : ""}" aria-selected="${state.tab === t.key}" data-tab="${t.key}">${t.label}</button>`).join("")}</nav>`;
}

function render() {
  $("who").innerHTML = `<span>${esc(state.me)}</span><button class="link" id="out">Log out</button>`;
  $("out").onclick = () => state.sb.auth.signOut();
  if (state.tab === "money") return renderMoney();
  if (state.tab === "customers") return renderCustomers();
  if (state.tab === "cash") return renderCash();
  if (state.tab === "stock") return renderStock();
  if (state.tab === "assistant") return renderAssistant();
  if (state.tab === "videos") return renderVideos();
  $("main").innerHTML = tabsHtml() + `<div class="layout">
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

// ---------- Money: revenue + profit, chart of every month, drill-down ----------
async function openTab() {
  try {
    if (state.tab === "money") await loadMoney();
    if (state.tab === "customers") await loadCustomers();
    if (state.tab === "cash") await loadCash();
    if (state.tab === "stock") await loadStock();
    if (state.tab === "videos") await loadVideos();
  } catch (err) {
    banner("Couldn't load: " + err.message);
  }
  if (state.tab === "calendar") return load();
  render();
}

async function loadMoney() {
  const m = state.money;
  const [from, to] = L.monthRange(m.month);
  const [report, months] = await Promise.all([
    rpc("sales_report", { p_from: from, p_to: to, p_filters: m.filters, p_include_test: state.includeTest }),
    m.chart ? rpc("monthly_report", { p_months: 12, p_filters: m.filters, p_include_test: state.includeTest }) : Promise.resolve(m.months),
  ]);
  m.report = report;
  m.months = months ?? [];
}

function filterSelect(id, label, list, val) {
  return `<div class="fld"><label for="${id}">${label}</label><select id="${id}" data-filter="${id.slice(3)}"><option value="">All</option>${opts(list, val)}</select></div>`;
}

function renderMoney() {
  const m = state.money;
  const r = m.report;
  const t = r?.totals ?? { revenue: 0, profit: 0, sales: 0, item_cost: 0, label_cost: 0, delivery_fees: 0, sales_missing_cost: 0 };
  const f = m.filters;
  $("main").innerHTML = tabsHtml() + `<div class="stack">
    <section class="panel stack">
      <div class="spread">
        <h2>${esc(L.monthLabel(m.month))}</h2>
        <div class="row">
          <button class="btn small" id="mPrev" aria-label="Previous month">‹</button>
          <button class="btn small" id="mNow">This month</button>
          <button class="btn small" id="mNext" aria-label="Next month">›</button>
        </div>
      </div>
      <button class="bignum" id="mChart" aria-expanded="${m.chart}">
        <span><span class="label">Revenue</span><b class="gold">${L.money(t.revenue)}</b></span>
        <span><span class="label">Profit</span><b class="good">${L.money(t.profit)}</b></span>
        <span><span class="label">Sales done</span><b>${t.sales}</b></span>
        <span class="muted small">${m.chart ? "Tap to hide the chart" : "Tap for every month"}</span>
      </button>
      ${t.sales_missing_cost ? `<div class="checktag">${t.sales_missing_cost} sale(s) have an item with no cost on BOT STOCK: their profit counts that item as $0 cost.</div>` : ""}
      <div class="meta"><span>Item cost <b>${L.money(t.item_cost)}</b></span><span>Label cost <b>${L.money(t.label_cost)}</b></span><span>Delivery fees (not revenue) <b>${L.money(t.delivery_fees)}</b></span></div>
      ${(r?.by_account ?? []).map((a) => `<div class="spread acct"><span>${esc(a.account)}: <b>${L.money(a.revenue)}</b> revenue, ${esc(L.monthLabel(m.month))}</span><span class="muted">${L.money(a.profit)} profit · ${a.sales} sale${a.sales === 1 ? "" : "s"}</span></div>`).join("")}
      ${m.chart ? `<div class="chartbox" id="chart">${L.monthChart(m.months, m.month)}</div><p class="muted small">Gold = revenue, green = profit. Tap a month to see its sales.</p>` : ""}
    </section>
    <section class="panel stack">
      <div class="spread"><h2>Filters</h2><button class="link" id="fClear">Clear</button></div>
      <div class="filters">
        ${filterSelect("fl_assignee", "Who fulfilled", L.TEAM.map((n) => ({ key: n, label: n })), f.assignee)}
        ${filterSelect("fl_payment_method", "Payment", L.PAYMENTS, f.payment_method)}
        ${filterSelect("fl_fulfillment", "Fulfillment", L.FULFILLMENT, f.fulfillment)}
        ${filterSelect("fl_source_account", "IG account", [...L.ACCOUNTS.map((n) => ({ key: n, label: n })), { key: "none", label: "No account (in person etc.)" }], f.source_account)}
      </div>
    </section>
    <section class="panel stack">
      <div class="spread"><h2>Every Done sale in ${esc(L.monthLabel(m.month))}</h2><span class="muted">${t.sales} · ${L.money(t.revenue)} · ${L.money(t.profit)} profit</span></div>
      ${(r?.sales ?? []).length ? `<div class="tablewrap"><table class="sales">
        <thead><tr><th>Date</th><th>Customer</th><th>Items</th><th class="n">Price</th><th class="n">Cost</th><th class="n">Profit</th><th>Payment</th><th>Fulfillment</th><th>Location</th><th>Fulfilled by</th></tr></thead>
        <tbody>${r.sales.map((s) => `<tr>
          <td>${esc(s.date)}</td>
          <td>${esc(L.customerName(s.customer))}</td>
          <td>${s.items.map((i) => esc(L.itemLine(i))).join("<br>")}</td>
          <td class="n">${L.money(s.revenue)}</td>
          <td class="n">${L.money(Number(s.item_cost) + Number(s.label_cost))}${s.cost_missing ? ` <span class="checktag" title="An item has no cost on BOT STOCK">?</span>` : ""}</td>
          <td class="n">${L.money(s.profit)}</td>
          <td>${esc(L.labelOf(L.PAYMENTS, s.payment_method))}</td>
          <td>${esc(L.labelOf(L.FULFILLMENT, s.fulfillment))}</td>
          <td>${esc(s.location ?? "")}</td>
          <td>${esc(s.assignee ?? "")}</td>
        </tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="3"><b>Total (${t.sales})</b></td><td class="n"><b>${L.money(t.revenue)}</b></td><td class="n"><b>${L.money(Number(t.item_cost) + Number(t.label_cost))}</b></td><td class="n"><b>${L.money(t.profit)}</b></td><td colspan="4"></td></tr></tfoot>
      </table></div>` : `<div class="empty">No Done sales in ${esc(L.monthLabel(m.month))}${Object.values(f).some(Boolean) ? " with these filters" : ""}.</div>`}
    </section>
  </div>`;
  const go = async (ym) => { m.month = ym; await loadMoney().catch((e) => banner(e.message)); renderMoney(); };
  const shift = (n) => { const [y, mo] = m.month.split("-").map(Number); go(L.thisMonth(new Date(y, mo - 1 + n, 1, 12))); };
  $("mPrev").onclick = () => shift(-1);
  $("mNext").onclick = () => shift(1);
  $("mNow").onclick = () => go(L.thisMonth());
  $("mChart").onclick = async () => { m.chart = !m.chart; await loadMoney().catch((e) => banner(e.message)); renderMoney(); };
  $("chart")?.addEventListener("click", (e) => { const b = e.target.closest("[data-month]"); if (b) go(b.dataset.month); });
  document.querySelectorAll("[data-filter]").forEach((sel) => (sel.onchange = async () => {
    m.filters[sel.dataset.filter] = sel.value || undefined;
    await loadMoney().catch((e) => banner(e.message));
    renderMoney();
  }));
  $("fClear").onclick = async () => { m.filters = {}; await loadMoney().catch((e) => banner(e.message)); renderMoney(); };
}

// ---------- Customers ----------
async function loadCustomers() {
  const c = state.customers;
  c.list = await rpc("customers_report", { p_sort: c.sort, p_limit: 200, p_include_test: state.includeTest, p_search: c.search || null });
}

function renderCustomers() {
  const c = state.customers;
  if (c.open) return renderCustomer();
  $("main").innerHTML = tabsHtml() + `<section class="panel stack">
    <div class="filters">
      <div class="fld"><label for="cSort">Sort</label><select id="cSort">${opts(L.CUSTOMER_SORTS, c.sort)}</select></div>
      <div class="fld"><label for="cSearch">Search</label><input id="cSearch" type="search" value="${esc(c.search)}" placeholder="@handle, name or phone"></div>
    </div>
    ${c.list.length ? `<div class="tablewrap"><table class="sales">
      <thead><tr><th>Customer</th><th>Phone</th><th class="n">Orders</th><th class="n">Total spent</th><th>Last order</th><th class="n">DM chats</th></tr></thead>
      <tbody>${c.list.map((x) => `<tr class="clickable" data-cust="${x.id}">
        <td><b>${esc(L.customerName(x))}</b>${x.ig_handle && x.name ? ` <span class="muted">@${esc(x.ig_handle)}</span>` : ""}${x.open_orders ? ` <span class="chip open">${x.open_orders} open</span>` : ""}${x.no_shows ? ` <span class="chip red">${x.no_shows} no-show</span>` : ""}</td>
        <td>${esc(x.phone ?? "")}</td><td class="n">${x.orders}</td><td class="n">${L.money(x.total_spent)}</td>
        <td>${esc(x.last_order ?? "")}</td><td class="n">${x.dm_conversations}</td>
      </tr>`).join("")}</tbody></table></div>` : `<div class="empty">No customers${c.search ? " match that search" : " yet"}.</div>`}
  </section>`;
  $("cSort").onchange = async (e) => { c.sort = e.target.value; await loadCustomers().catch((x) => banner(x.message)); renderCustomers(); };
  let t;
  $("cSearch").oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(async () => { c.search = e.target.value.trim(); await loadCustomers().catch((x) => banner(x.message)); renderCustomers(); $("cSearch").focus(); }, 350);
  };
  document.querySelectorAll("[data-cust]").forEach((row) => (row.onclick = async () => {
    try { c.open = await rpc("customer_orders", { p_customer: row.dataset.cust }); } catch (x) { return banner(x.message); }
    renderCustomers();
  }));
}

function renderCustomer() {
  const c = state.customers;
  const x = c.open.customer;
  $("main").innerHTML = tabsHtml() + `<section class="panel stack">
    <div class="spread"><button class="link" id="cBack">‹ All customers</button></div>
    <h3>${esc(L.customerName(x))}${x.ig_handle && x.name ? ` <span class="muted">@${esc(x.ig_handle)}</span>` : ""}</h3>
    <div class="meta"><span>Orders <b>${x.orders}</b></span><span>Total spent <b>${L.money(x.total_spent)}</b></span><span>Last order <b>${esc(x.last_order ?? "—")}</b></span><span>DM chats <b>${x.dm_conversations}</b></span>${x.phone ? `<span>${esc(x.phone)}</span>` : ""}</div>
    ${c.open.orders.length ? `<div class="tablewrap"><table class="sales"><thead><tr><th>Date</th><th>Status</th><th>Items</th><th class="n">Price</th><th>Payment</th><th>Fulfillment</th></tr></thead>
      <tbody>${c.open.orders.map((o) => `<tr><td>${esc(o.date)}</td><td>${L.isRed(o.status) ? `<span class="redtag">${esc(L.statusOf(o.status).label)}</span>` : esc(L.statusOf(o.status).label)}</td>
        <td>${o.items.map((i) => esc(L.itemLine(i))).join("<br>")}</td><td class="n">${L.money(o.revenue)}</td><td>${esc(L.labelOf(L.PAYMENTS, o.payment_method))}</td><td>${esc(L.labelOf(L.FULFILLMENT, o.fulfillment))}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">No orders yet.</div>`}
  </section>`;
  $("cBack").onclick = () => { c.open = null; renderCustomers(); };
}

// ---------- Cash per person per day ----------
async function loadCash() {
  state.cash.report = await rpc("cash_report", { p_day: state.cash.day, p_include_test: state.includeTest });
}

function renderCash() {
  const c = state.cash;
  const people = c.report?.people ?? [];
  $("main").innerHTML = tabsHtml() + `<section class="panel stack">
    <div class="spread">
      <h2>Cash collected</h2>
      <div class="fld"><label for="cDay">Day</label><input id="cDay" type="date" value="${esc(c.day)}"></div>
    </div>
    <div class="cashgrid">${people.map((p) => `<div class="card">
      <div class="spread"><span class="buyer">${esc(p.name)}</span><span class="price">${L.money(p.total)}</span></div>
      ${p.bookings.length ? `<ul class="items">${p.bookings.map((b) => `<li>${L.money(b.revenue)} · ${esc(L.customerName(b.customer))} · ${b.items.map((i) => esc(L.itemLine(i))).join(", ")}</li>`).join("")}</ul>` : `<span class="muted">No cash collected.</span>`}
    </div>`).join("")}</div>
    <p class="muted small">Cash counts the moment a cash booking is marked Paid or Done, for whoever tapped it (or who was fulfilling, if the bot marked it). Day = Eastern time.</p>
  </section>`;
  $("cDay").onchange = async (e) => { c.day = e.target.value; await loadCash().catch((x) => banner(x.message)); renderCash(); };
}

// ---------- Stock: the full picture per item + restocks ----------
async function loadStock() {
  const [overview, restocks] = await Promise.all([
    rpc("stock_overview", { p_is_test: state.includeTest }),
    rpc("restocks_list", { p_include_test: state.includeTest }),
  ]);
  state.stock.rows = overview ?? [];
  state.stock.restocks = restocks ?? [];
}

const STOCK_STATUS = { for_sale: "For sale", incoming: "Incoming", freebie: "Freebie", not_for_sale: "Not for sale", other: "Other" };

function restockRowHtml(i = {}) {
  return `<div class="itemrow" data-rrow>
    <div class="fld"><label>Brand</label><input name="brand" value="${esc(i.brand)}"></div>
    <div class="fld"><label>Item *</label><input name="item" value="${esc(i.item)}"></div>
    <div class="fld"><label>Color</label><input name="color" value="${esc(i.color)}"></div>
    <div class="fld"><label>Size</label><input name="size" value="${esc(i.size)}"></div>
    <div class="fld"><label>Qty *</label><input name="qty_expected" type="number" min="0" step="1" inputmode="numeric" value="${esc(i.qty_expected ?? "")}"></div>
    <div class="fld"><label>$ cost</label><input name="unit_cost" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(i.unit_cost ?? "")}"></div>
    <button type="button" class="link danger" data-delrrow aria-label="Remove line">✕</button>
  </div>`;
}

function renderStock() {
  const st = state.stock;
  const q = st.search.trim().toLowerCase();
  const rows = st.rows.filter((r) => !q || [r.brand, r.item, r.color, r.size].join(" ").toLowerCase().includes(q));
  const editing = st.editing; // null | "new" | restock id
  const restockForm = (r) => `<form class="panel f" id="rf">
      <div class="full"><h2>${r ? "Edit incoming restock" : "New incoming restock"}</h2></div>
      <div class="fld"><label for="r_name">Name *</label><input id="r_name" name="name" required value="${esc(r?.name ?? "")}" placeholder="Nov 16-17 restock"></div>
      <div class="fld"><label for="r_date">Expected</label><input id="r_date" name="expected_date" type="date" value="${esc(r?.expected_date ?? "")}"></div>
      <div class="full stack" id="rrows">${(r?.items?.length ? r.items : [{}]).map(restockRowHtml).join("")}</div>
      <div class="full"><button type="button" class="btn small" id="raddrow">+ Line</button></div>
      <div class="fld full"><label for="r_notes">Notes</label><input id="r_notes" name="notes" value="${esc(r?.notes ?? "")}"></div>
      <div class="full spread"><button type="button" class="btn" id="rcancel">Cancel</button><button class="btn gold">${r ? "Save" : "Log restock"}</button></div>
    </form>`;
  $("main").innerHTML = tabsHtml() + `<div class="stack">
    <section class="panel stack">
      <div class="spread"><h2>Restocks</h2><button class="btn gold small" id="rnew">+ Incoming restock</button></div>
      ${editing === "new" ? restockForm(null) : ""}
      ${st.restocks.length ? st.restocks.map((r) => editing === r.id ? restockForm(r) : `<article class="card ${r.status === "received" ? "done" : "check"}" data-restock="${r.id}">
        <div class="spread"><span class="buyer">${esc(r.name)}</span><span>${r.status === "received" ? `<span class="chip done">Received ${esc(new Date(r.received_at).toLocaleDateString("en-US"))}</span>` : `<span class="checktag">Incoming${r.expected_date ? ` · ${esc(r.expected_date)}` : ""}</span>`}</span></div>
        <div class="tablewrap"><table class="sales"><thead><tr><th>Item</th><th class="n">${r.status === "received" ? "Expected" : "Coming"}</th>${r.status === "received" ? `<th class="n">Received</th>` : `<th class="n">Got</th>`}</tr></thead>
          <tbody>${r.items.map((i) => `<tr><td>${esc([i.brand && !i.item.toLowerCase().startsWith(i.brand.toLowerCase()) ? i.brand : "", i.item, i.color, i.size].filter(Boolean).join(" "))}</td>
            <td class="n">${i.qty_expected}</td>
            <td class="n">${r.status === "received" ? i.qty_received : `<input class="got" type="number" min="0" step="1" inputmode="numeric" data-got="${i.id}" value="${i.qty_expected}" aria-label="How many arrived">`}</td></tr>`).join("")}</tbody></table></div>
        ${r.notes ? `<div class="meta">${esc(r.notes)}</div>` : ""}
        ${r.status === "incoming" ? `<div class="row"><button class="btn gold small" data-receive>It landed: mark received</button><button class="link" data-redit>Edit</button></div>
          <p class="muted small">Change "Got" for anything that came in short before you mark it received. The pieces are added to stock right away, and the bot puts them on BOT STOCK within a minute.</p>` : ""}
      </article>`).join("") : editing === "new" ? "" : `<div class="empty">No restocks logged yet.</div>`}
    </section>
    <section class="panel stack">
      <div class="spread"><h2>Stock</h2><div class="fld"><input id="sSearch" type="search" placeholder="Search items" value="${esc(st.search)}" aria-label="Search items"></div></div>
      ${rows.length ? `<div class="tablewrap"><table class="sales">
        <thead><tr><th>Item</th><th>Status</th><th class="n">Came in</th><th class="n">Sold this restock</th><th class="n">Reserved</th><th class="n">Free to sell</th><th class="n">Sold all-time</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><b>${esc([r.brand && !r.item.toLowerCase().startsWith((r.brand || "").toLowerCase()) ? r.brand : "", r.item].filter(Boolean).join(" "))}</b> ${esc([r.color, r.size].filter(Boolean).join(" · "))}${r.restock ? `<br><span class="muted small">${esc(r.restock)}</span>` : ""}${r.needs_sheet_row ? `<br><span class="checktag">Being added to BOT STOCK</span>` : ""}</td>
          <td>${esc(STOCK_STATUS[r.status] ?? r.status)}</td>
          <td class="n">${r.restock ? r.came_in : "—"}</td>
          <td class="n">${r.sold_since_restock}</td>
          <td class="n">${r.reserved}</td>
          <td class="n">${r.status === "for_sale" && r.free === 0 ? `<span class="redtag">0</span>` : `<b>${r.free}</b>`}</td>
          <td class="n">${r.sold_all_time}</td>
        </tr>`).join("")}</tbody></table></div>` : `<div class="empty">${q ? "Nothing matches that search." : "No stock yet. It shows up once the bot syncs BOT STOCK."}</div>`}
      <p class="muted small">Free to sell is what buyers can get (the bot only offers this). Reserved = booked, not picked up yet. Sold this restock counts Done sales since the restock landed.</p>
    </section>
  </div>`;
  $("rnew").onclick = () => { st.editing = "new"; renderStock(); $("r_name")?.focus(); };
  let t;
  $("sSearch").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { st.search = e.target.value; renderStock(); $("sSearch").focus(); }, 250); };
  const form = $("rf");
  if (form) {
    $("rcancel").onclick = () => { st.editing = null; renderStock(); };
    $("raddrow").onclick = () => { const d = document.createElement("div"); d.innerHTML = restockRowHtml(); $("rrows").append(d.firstElementChild); };
    $("rrows").onclick = (e) => { if (e.target.closest("[data-delrrow]") && $("rrows").children.length > 1) e.target.closest("[data-rrow]").remove(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const items = [...form.querySelectorAll("[data-rrow]")].map((r) => Object.fromEntries(["brand", "item", "color", "size", "qty_expected", "unit_cost"].map((k) => [k, r.querySelector(`[name=${k}]`).value.trim()])))
        .filter((i) => i.item)
        .map((i) => ({ ...i, qty_expected: Number(i.qty_expected), unit_cost: i.unit_cost === "" ? null : Number(i.unit_cost) }));
      if (!items.length) return banner("Add at least one line.");
      if (items.some((i) => !Number.isInteger(i.qty_expected) || i.qty_expected < 0)) return banner("Every line needs a quantity.");
      const p = { name: $("r_name").value.trim(), expected_date: $("r_date").value || null, notes: $("r_notes").value.trim() || null, items, is_test: state.includeTest };
      try {
        if (st.editing === "new") await rpc("create_restock", { p });
        else await rpc("update_restock", { p_id: st.editing, p });
        st.editing = null;
        banner("Saved.", true);
        await loadStock();
      } catch (err) { return banner("Not saved: " + err.message); }
      renderStock();
    };
  }
  document.querySelectorAll("[data-restock]").forEach((card) => (card.onclick = async (e) => {
    const id = card.dataset.restock;
    if (e.target.closest("[data-redit]")) { st.editing = id; return renderStock(); }
    if (!e.target.closest("[data-receive]")) return;
    const got = [...card.querySelectorAll("[data-got]")].map((x) => ({ id: x.dataset.got, qty_received: Number(x.value) }));
    if (got.some((g) => !Number.isInteger(g.qty_received) || g.qty_received < 0)) return banner("Each 'Got' needs a number (0 or more).");
    const total = got.reduce((a, g) => a + g.qty_received, 0);
    if (!confirm(`Mark it received? ${total} piece(s) go into stock now.`)) return;
    try { await rpc("receive_restock", { p_id: id, p_received: got }); banner("Received. Stock is updated.", true); await loadStock(); }
    catch (err) { return banner("Not saved: " + err.message); }
    renderStock();
  }));
}

// ---------- Assistant: chat with the team assistant (it acts as you) ----------
const CHAT_KEY = "triangle-assistant-chat";

function loadChat() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHAT_KEY) ?? "[]");
    if (Array.isArray(saved)) state.chat.messages = saved;
  } catch {
    /* private mode or blocked storage: start fresh */
  }
}
function saveChat() {
  try {
    // Pictures aren't kept (too big); the text of the conversation is.
    sessionStorage.setItem(CHAT_KEY, JSON.stringify(state.chat.messages.map(({ images, ...m }) => ({ ...m, hadImages: m.hadImages || !!images?.length }))));
  } catch {
    /* ignore */
  }
}

/** Shrinks a photo to at most 1600px and JPEG, so screenshots upload fast. Returns {mediaType, data(base64)}. */
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL("image/jpeg", 0.85).split(",")[1];
    return { mediaType: "image/jpeg", data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function renderAssistant() {
  const ch = state.chat;
  if (!state.assistantUrl) {
    $("main").innerHTML = tabsHtml() + `<section class="panel"><p class="empty">The assistant isn't switched on yet (it needs the bot's address in the CRM settings).</p></section>`;
    return;
  }
  $("main").innerHTML = tabsHtml() + `<section class="panel chat">
    <div class="msgs" id="msgs" aria-live="polite">
      ${ch.messages.length ? "" : `<div class="empty">Ask or tell me anything, ${esc(state.me)}. For example:<br>"Sold 2 black Essentials hoodies M to @jay, $120 cash"<br>"What's booked tomorrow?"<br>"How much did Diego bring in this week?"<br>Send a screenshot of an incoming restock to log it.<br>"Tell the bot the BAPE restock moved to Tuesday"</div>`}
      ${ch.messages.map((m) => `<div class="msg ${m.role}">
        ${m.images?.length ? m.images.map((i) => `<img src="data:${i.mediaType};base64,${i.data}" alt="Picture you sent">`).join("") : m.hadImages ? `<span class="muted small">(picture)</span>` : ""}
        ${m.text ? `<div class="bubble">${esc(m.text).replace(/\n/g, "<br>")}</div>` : ""}
        ${m.changes?.length ? `<ul class="changes">${m.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
      </div>`).join("")}
      ${ch.busy ? `<div class="msg assistant"><div class="bubble muted">Working on it…</div></div>` : ""}
    </div>
    <form id="chatF" class="chatbar">
      ${ch.pending.length ? `<div class="thumbs">${ch.pending.map((i, n) => `<span class="thumb"><img src="data:${i.mediaType};base64,${i.data}" alt="Picture to send"><button type="button" class="link danger" data-unpick="${n}" aria-label="Remove picture">✕</button></span>`).join("")}</div>` : ""}
      <div class="row">
        <label class="btn small" for="pick" title="Add a screenshot">📎<span class="sr">Add a picture</span></label>
        <input id="pick" type="file" accept="image/*" multiple hidden>
        <textarea id="say" rows="1" placeholder="Message the assistant" ${ch.busy ? "disabled" : ""}></textarea>
        <button class="btn gold small" ${ch.busy ? "disabled" : ""}>Send</button>
      </div>
      ${ch.messages.length ? `<button type="button" class="link small" id="newChat">New chat</button>` : ""}
    </form>
  </section>`;
  const msgs = $("msgs");
  msgs.scrollTop = msgs.scrollHeight;
  const say = $("say");
  say.value = ch.draft;
  say.oninput = () => { ch.draft = say.value; say.style.height = "auto"; say.style.height = Math.min(say.scrollHeight, 160) + "px"; };
  say.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chatF").requestSubmit(); } };
  if (!ch.busy) say.focus();
  $("pick").onchange = async (e) => {
    const files = [...e.target.files].slice(0, 4 - ch.pending.length);
    try { for (const f of files) ch.pending.push(await shrinkImage(f)); } catch { banner("Couldn't read that picture."); }
    renderAssistant();
  };
  document.querySelectorAll("[data-unpick]").forEach((b) => (b.onclick = () => { ch.pending.splice(Number(b.dataset.unpick), 1); renderAssistant(); }));
  $("newChat")?.addEventListener("click", () => { ch.messages = []; saveChat(); renderAssistant(); });
  $("chatF").onsubmit = async (e) => {
    e.preventDefault();
    const text = ch.draft.trim();
    if ((!text && !ch.pending.length) || ch.busy) return;
    ch.messages.push({ role: "user", text, ...(ch.pending.length ? { images: ch.pending } : {}) });
    ch.pending = [];
    ch.draft = "";
    ch.busy = true;
    saveChat();
    renderAssistant();
    try {
      const { data } = await state.sb.auth.getSession();
      const res = await fetch(`${state.assistantUrl}/team/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` },
        // Only the last 20 messages, and pictures only on the newest one (older ones were already read).
        body: JSON.stringify({ messages: ch.messages.slice(-20).map((m, i, all) => ({ role: m.role, text: m.text || "", ...(i === all.length - 1 && m.images ? { images: m.images } : {}) })) }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? `error ${res.status}`);
      ch.messages.push({ role: "assistant", text: out.reply, changes: out.changes });
      // Whatever it changed shows up on the other tabs too.
      if (out.changes?.length) state.bookings = {};
    } catch (err) {
      ch.messages.push({ role: "assistant", text: "Didn't go through: " + err.message });
    }
    ch.busy = false;
    saveChat();
    renderAssistant();
  };
}

// ---------- Videos: daily ideas per account ----------
const VACCOUNTS = [
  { key: "resells", label: "Triangle Resells" },
  { key: "scales", label: "Triangle Scales" },
  { key: "sales", label: "Triangle Sales" },
];
const VSTATUS = { todo: "To film", filmed: "Filmed", posted: "Posted" };
const VNEXT = { todo: "filmed", filmed: "posted", posted: "todo" };

async function loadVideos() {
  state.videos.data = await rpc("videos_for_day", { p_day: state.videos.day, p_is_test: state.includeTest });
}

function renderVideos() {
  const v = state.videos;
  const d = v.data ?? { goals: {}, ideas: [] };
  const title = L.parseIso(v.day).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  $("main").innerHTML = tabsHtml() + `<section class="panel stack">
    <div class="spread">
      <h3>${esc(title)}</h3>
      <div class="row">
        <button class="btn small" id="vPrev" aria-label="Previous day">‹</button>
        <input id="vDay" type="date" value="${esc(v.day)}" aria-label="Day">
        <button class="btn small" id="vNext" aria-label="Next day">›</button>
      </div>
    </div>
    ${state.assistantUrl ? `<div><button class="btn small" id="vGen" ${v.busy ? "disabled" : ""}>${v.busy ? "Writing…" : "✨ Write ideas for this day"}</button> <span class="muted small">Fills each account up to its goal with fresh hooks.</span></div>` : ""}
    ${VACCOUNTS.map((a) => {
      const list = d.ideas.filter((i) => i.account === a.key);
      const posted = list.filter((i) => i.status === "posted").length;
      const goal = d.goals?.[a.key] ?? 0;
      return `<div class="stack">
        <div class="spread"><h2>${esc(a.label)}</h2><span class="${posted >= goal && goal ? "chip done" : "muted"}">${posted}/${goal} posted${a.key === "sales" ? " · incl. a meetup video" : ""}</span></div>
        ${list.length ? list.map((i) => `<div class="vid ${i.status}" data-vid="${i.id}">
          <div class="spread">
            <span class="hook">${esc(i.hook)}${i.meetup ? ` <span class="chip open">meetup</span>` : ""}${i.auto ? ` <span class="muted small">auto</span>` : ""}</span>
            <button class="st ${i.status === "posted" ? "on done" : i.status === "filmed" ? "on booked" : ""}" data-vstatus title="Tap to change">${VSTATUS[i.status]}</button>
          </div>
          <div class="row small">
            <span class="muted">Posted to:</span>
            ${VACCOUNTS.map((p) => `<label class="toggle"><input type="checkbox" data-vpost="${p.key}" ${i.posted_to.includes(p.key) ? "checked" : ""}>${p.label.replace("Triangle ", "")}</label>`).join("")}
          </div>
          <div class="row">
            <input data-vlink placeholder="Post link" value="${esc(i.post_link ?? "")}" aria-label="Post link">
            <input data-vviews type="number" min="0" step="1" inputmode="numeric" placeholder="Views" value="${esc(i.views ?? "")}" aria-label="Views" style="max-width:110px">
            <button class="link danger" data-vdel aria-label="Remove idea">✕</button>
          </div>
        </div>`).join("") : `<div class="empty">No ${esc(a.label)} ideas yet.</div>`}
      </div>`;
    }).join("")}
    <form class="row" id="vAdd">
      <select id="vAcct" aria-label="Account">${VACCOUNTS.map((a) => `<option value="${a.key}">${a.label}</option>`).join("")}</select>
      <input id="vHook" placeholder="New hook, e.g. How I turned $200 into $2,000" required aria-label="Hook">
      <button class="btn gold small">Add idea</button>
    </form>
  </section>`;
  const go = async (day) => { v.day = day; await loadVideos().catch((e) => banner(e.message)); renderVideos(); };
  const shift = (n) => { const x = L.parseIso(v.day); x.setDate(x.getDate() + n); go(L.isoDate(x)); };
  $("vPrev").onclick = () => shift(-1);
  $("vNext").onclick = () => shift(1);
  $("vDay").onchange = (e) => e.target.value && go(e.target.value);
  $("vAdd").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await rpc("add_video_ideas", { p_day: v.day, p_ideas: [{ account: $("vAcct").value, hook: $("vHook").value.trim() }], p_is_test: state.includeTest });
      await loadVideos();
    } catch (err) { return banner("Not saved: " + err.message); }
    renderVideos();
  };
  $("vGen")?.addEventListener("click", async () => {
    v.busy = true;
    renderVideos();
    try {
      const { data } = await state.sb.auth.getSession();
      const res = await fetch(`${state.assistantUrl}/team/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` },
        body: JSON.stringify({ messages: [{ role: "user", text: `Write video ideas for ${v.day} (fill each account up to its goal).` }] }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? `error ${res.status}`);
      banner(out.reply || "Done.", true);
      await loadVideos();
    } catch (err) { banner("Couldn't write ideas: " + err.message); }
    v.busy = false;
    renderVideos();
  });
  document.querySelectorAll("[data-vid]").forEach((card) => {
    const id = card.dataset.vid;
    const idea = d.ideas.find((i) => i.id === id);
    const save = async (p) => { try { await rpc("update_video_idea", { p_id: id, p }); await loadVideos(); renderVideos(); } catch (err) { banner("Not saved: " + err.message); } };
    card.querySelector("[data-vstatus]").onclick = () => save({ status: VNEXT[idea.status] });
    card.querySelectorAll("[data-vpost]").forEach((cb) => (cb.onchange = () => save({ posted_to: [...card.querySelectorAll("[data-vpost]:checked")].map((x) => x.dataset.vpost) })));
    card.querySelector("[data-vlink]").onchange = (e) => save({ post_link: e.target.value });
    card.querySelector("[data-vviews]").onchange = (e) => save({ views: e.target.value === "" ? null : Number(e.target.value) });
    card.querySelector("[data-vdel]").onclick = async () => {
      if (!confirm("Remove this idea?")) return;
      try { await rpc("delete_video_idea", { p_id: id }); await loadVideos(); renderVideos(); } catch (err) { banner("Not removed: " + err.message); }
    };
  });
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
  state.assistantUrl = (cfg.assistantUrl ?? "").replace(/\/+$/, "");
  loadChat();
  state.sb.channel("bookings").on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, reloadSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "booking_items" }, reloadSoon).subscribe();
  // Tabs: Calendar / Money / Customers / Cash.
  $("main").addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (!t || t.dataset.tab === state.tab) return;
    state.tab = t.dataset.tab;
    openTab();
  });
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
