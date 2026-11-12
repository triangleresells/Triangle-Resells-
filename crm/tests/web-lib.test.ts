import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the browser
import * as lib from "../web/lib.js";

const good = {
  date: "2026-11-14", time: "16:00", ig_handle: "@TEST_buyer", name: "", phone: "",
  items: [{ brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M", qty: "2", unit_price: "60" }, { item: "" }],
  sale_price: "", payment_method: "cash_app", fulfillment: "pickup", delivery_fee: "5", shipping_fee: "", label_cost: "",
  location: "Warehouse", assignee: "Chema", source: "in_person", source_account: "", tracking_number: "1Z", notes: "",
};

describe("CRM screen helpers", () => {
  it("builds a month grid that starts on Sunday and covers the month", () => {
    const g = lib.monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(g[0]).toEqual({ iso: "2026-11-01", day: 1, inMonth: true });
    expect(g.filter((d: { inMonth: boolean }) => d.inMonth)).toHaveLength(30);
    expect(g.length % 7).toBe(0);
  });

  it("turns the form into the API payload, dropping blank lines and fields that don't apply", () => {
    const r = lib.bookingPayload(good);
    expect(r.error).toBeUndefined();
    expect(r.payload).toMatchObject({
      date: "2026-11-14", time: "16:00", customer: { ig_handle: "@TEST_buyer" },
      items: [{ brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M", qty: 2, unit_price: 60 }],
      delivery_fee: 0, tracking_number: null, assignee: "Chema",
    });
    expect(r.payload.items).toHaveLength(1);
    expect(r.payload).not.toHaveProperty("sale_price");
  });

  it("says exactly what's missing", () => {
    expect(lib.bookingPayload({ ...good, items: [{ item: "Hoodie", qty: "1", unit_price: "60" }] }).error).toMatch(/needs a size/);
    expect(lib.bookingPayload({ ...good, items: [{ item: "Hoodie", size: "M", qty: "1" }] }).error).toMatch(/sale price/);
    expect(lib.bookingPayload({ ...good, ig_handle: "" }).error).toMatch(/buyer/);
    expect(lib.bookingPayload({ ...good, payment_method: "cash", fulfillment: "delivery" }).error).toMatch(/pickup only/);
    expect(lib.bookingPayload({ ...good, date: "" }).error).toMatch(/date/);
  });

  it("formats money, times, statuses and day counts", () => {
    expect(lib.money(120)).toBe("$120");
    expect(lib.money(12.5)).toBe("$12.50");
    expect(lib.fmtTime("16:00:00")).toBe("4:00 PM");
    expect(lib.fmtTime("00:30")).toBe("12:30 AM");
    expect(lib.statusOf("paid_needs_check").label).toBe("Paid - needs check");
    expect(lib.isRed("no_show")).toBe(true);
    expect(lib.dayCounts([{ status: "booked" }, { status: "paid" }, { status: "done" }, { status: "cancelled" }])).toEqual({ open: 2, done: 1, red: 1 });
    expect(lib.itemLine({ qty: 2, brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M" })).toBe("2x Essentials Hoodie Black M");
  });
});

describe("money screen helpers", () => {
  it("month ranges and labels", () => {
    expect(lib.monthRange("2026-11")).toEqual(["2026-11-01", "2026-11-30"]);
    expect(lib.monthRange("2028-02")).toEqual(["2028-02-01", "2028-02-29"]);
    expect(lib.monthLabel("2026-11")).toBe("November 2026");
    expect(lib.monthLabel("2026-11", true)).toBe("Nov '26");
  });
  it("draws one revenue and one profit bar per month, tappable", () => {
    const svg = lib.monthChart([{ month: "2026-10", revenue: 35, profit: 22.65 }, { month: "2026-11", revenue: 205.5, profit: 118.45 }], "2026-11");
    expect(svg.match(/data-month=/g)).toHaveLength(2);
    expect(svg).toContain("November 2026 revenue $205.50");
    expect(svg).toContain("October 2026 profit $22.65");
  });
});
