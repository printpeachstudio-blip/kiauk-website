import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePayload, buildCheckoutParams, normalisePostcode, GIFT_AID_WORDING, corsHeaders } from "../supabase/functions/create-checkout/lib.ts";
import { verifyStripeSignature, hmacSha256Hex, handleEvent } from "../supabase/functions/stripe-webhook/lib.ts";
import type { Db, Donation, Find } from "../supabase/functions/stripe-webhook/lib.ts";
import { bagsFromPence, buildCountResponse } from "../supabase/functions/bag-count/lib.ts";
import { readFileSync } from "node:fs";

const base = {
  frequency: "one_off", amount_pence: 4000, donor_type: "individual",
  first_name: "Ada", last_name: "Lovelace", email: "Ada@Example.com",
  gift_aid: true, house_name_or_number: "12", postcode: "ha7 1nl",
};

test("valid individual with gift aid", () => {
  const r = validatePayload(base);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.email, "ada@example.com");
    assert.equal(r.value.postcode, "HA7 1NL");
    assert.equal(r.value.bags, 1);
    assert.equal(r.value.gift_aid, true);
  }
});
test("gift aid needs house and postcode", () => {
  const r = validatePayload({ ...base, house_name_or_number: "", postcode: "nope" });
  assert.equal(r.ok, false);
  if (!r.ok) { assert.ok(r.errors.house_name_or_number); assert.ok(r.errors.postcode); }
});
test("business can never gift aid and needs a name", () => {
  const r = validatePayload({ ...base, donor_type: "business", business_name: "Acme Ltd", public_naming_ok: true });
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.value.gift_aid, false); assert.equal(r.value.postcode, null); assert.equal(r.value.public_naming_ok, true); }
  const r2 = validatePayload({ ...base, donor_type: "business" });
  assert.equal(r2.ok, false);
});
test("individuals cannot set public naming", () => {
  const r = validatePayload({ ...base, public_naming_ok: true });
  assert.ok(r.ok && r.value.public_naming_ok === false);
});
test("amount limits", () => {
  for (const a of [99, 1_000_001, 12.5, "40", null, NaN]) assert.equal(validatePayload({ ...base, amount_pence: a }).ok, false, String(a));
  assert.equal(validatePayload({ ...base, amount_pence: 100 }).ok, true);
  assert.equal(validatePayload({ ...base, amount_pence: 1_000_000 }).ok, true);
});
test("bags only for one-off multiples of 40", () => {
  const b = (f: string, a: number) => { const r = validatePayload({ ...base, frequency: f, amount_pence: a }); return r.ok ? r.value.bags : "err"; };
  assert.equal(b("one_off", 8000), 2);
  assert.equal(b("one_off", 5000), null);
  assert.equal(b("monthly", 4000), null);
});
test("rejects bad email and non-object", () => {
  assert.equal(validatePayload({ ...base, email: "x" }).ok, false);
  assert.equal(validatePayload(null).ok, false);
  assert.equal(validatePayload("hi").ok, false);
});
test("postcode normalisation", () => {
  assert.equal(normalisePostcode("sw1a2aa"), "SW1A 2AA");
  assert.equal(normalisePostcode("M1 1AE"), "M1 1AE");
  assert.equal(normalisePostcode("12345"), null);
});
test("checkout params one-off", () => {
  const r = validatePayload(base); assert.ok(r.ok);
  const p = buildCheckoutParams({ payload: r.value, donationId: "d1", donorId: "o1", siteUrl: "https://kiauk.org" });
  assert.equal(p.get("mode"), "payment");
  assert.equal(p.get("line_items[0][price_data][unit_amount]"), "4000");
  assert.equal(p.get("line_items[0][price_data][currency]"), "gbp");
  assert.equal(p.get("payment_intent_data[metadata][donation_id]"), "d1");
  assert.equal(p.get("metadata[donation_id]"), "d1");
  assert.equal(p.get("line_items[0][price_data][recurring][interval]"), null);
  assert.equal(p.get("success_url"), "https://kiauk.org/thanks.html");
  assert.ok(p.get("line_items[0][price_data][product_data][name]")!.includes("1 winter bag"));
  assert.equal(p.has("payment_method_types[0]"), false);
});
test("checkout params monthly", () => {
  const r = validatePayload({ ...base, frequency: "monthly", amount_pence: 1000 }); assert.ok(r.ok);
  const p = buildCheckoutParams({ payload: r.value, donationId: "d1", donorId: "o1", siteUrl: "https://kiauk.org" });
  assert.equal(p.get("mode"), "subscription");
  assert.equal(p.get("line_items[0][price_data][recurring][interval]"), "month");
  assert.equal(p.get("subscription_data[metadata][donation_id]"), "d1");
  assert.equal(p.get("payment_intent_data[metadata][donation_id]"), null);
});
test("cors only for allowed origin", () => {
  assert.equal(corsHeaders("https://kiauk.org", ["https://kiauk.org"])["Access-Control-Allow-Origin"], "https://kiauk.org");
  assert.equal(corsHeaders("https://evil.example", ["https://kiauk.org"])["Access-Control-Allow-Origin"], undefined);
});
test("gift aid wording on page matches server wording", () => {
  const html = readFileSync(new URL("../donate.html", import.meta.url), "utf8");
  assert.ok(html.includes(GIFT_AID_WORDING), "donate.html wording differs from server wording");
  assert.ok(!GIFT_AID_WORDING.includes("—"));
});

// ---- signature ----
test("stripe signature", async () => {
  const secret = "whsec_test", body = '{"id":"evt_1"}', t = 1_700_000_000;
  const sig = await hmacSha256Hex(secret, `${t}.${body}`);
  assert.equal(await verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, t + 10), true);
  assert.equal(await verifyStripeSignature(body, `t=${t},v1=bad,v1=${sig}`, secret, 300, t + 10), true, "multiple v1");
  assert.equal(await verifyStripeSignature(body + " ", `t=${t},v1=${sig}`, secret, 300, t + 10), false, "tampered body");
  assert.equal(await verifyStripeSignature(body, `t=${t},v1=${sig}`, "other", 300, t + 10), false, "wrong secret");
  assert.equal(await verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, t + 1000), false, "stale");
  assert.equal(await verifyStripeSignature(body, null, secret), false);
  assert.equal(await verifyStripeSignature(body, "garbage", secret), false);
});

// ---- webhook logic with an in-memory db ----
function memDb(rows: Donation[]) {
  const db: Db & { rows: Donation[] } = {
    rows,
    async find(by: Find) { return rows.find((r) => Object.entries(by).every(([k, v]) => (r as any)[k] === v)) ?? null; },
    async update(id, patch) { const r = rows.find((x) => x.id === id)!; for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as any)[k] = v; },
    async insert(row) { rows.push({ id: "new" + rows.length, stripe_checkout_session_id: null, stripe_payment_intent_id: null, ...row } as any); },
  };
  return db;
}
const row = (o: Partial<Donation> = {}): Donation => ({ id: "d1", donor_id: "o1", declaration_id: "g1", amount_pence: 4000, frequency: "one_off", status: "pending",
  stripe_checkout_session_id: null, stripe_payment_intent_id: null, stripe_subscription_id: null, stripe_invoice_id: null, ...o });
const ev = (type: string, object: any) => ({ id: "evt", type, data: { object } });
const T = () => "2026-12-01T10:00:00Z";

test("one-off checkout completed marks paid and is idempotent", async () => {
  const db = memDb([row()]);
  const e = ev("checkout.session.completed", { id: "cs_1", metadata: { donation_id: "d1" }, payment_intent: "pi_1", payment_status: "paid", mode: "payment" });
  assert.equal(await handleEvent(e, db, T), "handled");
  assert.equal(db.rows[0].status, "paid");
  assert.equal(db.rows[0].stripe_payment_intent_id, "pi_1");
  assert.equal(await handleEvent(e, db, T), "handled");
  assert.equal(db.rows.length, 1);
});
test("delayed method: completed unpaid stays pending, async success marks paid, async failure marks failed", async () => {
  const db = memDb([row()]);
  await handleEvent(ev("checkout.session.completed", { id: "cs_1", metadata: { donation_id: "d1" }, payment_intent: "pi_1", payment_status: "unpaid" }), db, T);
  assert.equal(db.rows[0].status, "pending");
  await handleEvent(ev("checkout.session.async_payment_succeeded", { id: "cs_1", metadata: { donation_id: "d1" }, payment_intent: "pi_1", payment_status: "paid" }), db, T);
  assert.equal(db.rows[0].status, "paid");
  const db2 = memDb([row({ stripe_checkout_session_id: "cs_2" })]);
  await handleEvent(ev("checkout.session.async_payment_failed", { id: "cs_2" }), db2, T);
  assert.equal(db2.rows[0].status, "failed");
});
test("expired does not overwrite a paid row", async () => {
  const db = memDb([row({ status: "paid", stripe_checkout_session_id: "cs_1" })]);
  await handleEvent(ev("checkout.session.expired", { id: "cs_1" }), db, T);
  assert.equal(db.rows[0].status, "paid");
});
test("unknown row on checkout completed asks Stripe to retry", async () => {
  assert.equal(await handleEvent(ev("checkout.session.completed", { id: "cs_x", metadata: { donation_id: "nope" } }), memDb([]), T), "retry");
});
test("subscription: first invoice attaches to checkout row, later invoices add rows", async () => {
  const db = memDb([row({ frequency: "monthly", amount_pence: 1000 })]);
  await handleEvent(ev("checkout.session.completed", { id: "cs_1", metadata: { donation_id: "d1" }, subscription: "sub_1", payment_status: "paid", mode: "subscription" }), db, T);
  assert.equal(db.rows[0].status, "paid");
  const inv1 = { id: "in_1", subscription: "sub_1", amount_paid: 1000, currency: "gbp", subscription_details: { metadata: { donation_id: "d1" } } };
  await handleEvent(ev("invoice.paid", inv1), db, T);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].stripe_invoice_id, "in_1");
  await handleEvent(ev("invoice.paid", inv1), db, T); // replay
  assert.equal(db.rows.length, 1);
  const inv2 = { id: "in_2", parent: { subscription_details: { subscription: "sub_1", metadata: { donation_id: "d1" } } }, amount_paid: 1000, currency: "gbp" };
  await handleEvent(ev("invoice.paid", inv2), db, T);
  await handleEvent(ev("invoice.paid", inv2), db, T); // replay
  assert.equal(db.rows.length, 2);
  assert.equal(db.rows[1].donor_id, "o1");
  assert.equal(db.rows[1].declaration_id, "g1");
  assert.equal(db.rows[1].status, "paid");
});
test("subscription: invoice before checkout event still works", async () => {
  const db = memDb([row({ frequency: "monthly", amount_pence: 1000 })]);
  await handleEvent(ev("invoice.paid", { id: "in_1", subscription: "sub_1", amount_paid: 1000, subscription_details: { metadata: { donation_id: "d1" } } }), db, T);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].status, "paid");
  await handleEvent(ev("checkout.session.completed", { id: "cs_1", metadata: { donation_id: "d1" }, subscription: "sub_1", payment_status: "paid" }), db, T);
  assert.equal(db.rows.length, 1);
});
test("invoice without subscription is ignored; invoice with unknown parent retries", async () => {
  assert.equal(await handleEvent(ev("invoice.paid", { id: "in_9" }), memDb([]), T), "ignored");
  assert.equal(await handleEvent(ev("invoice.paid", { id: "in_9", subscription: "sub_9", amount_paid: 1 }), memDb([]), T), "retry");
});
test("full refund marks refunded; partial is ignored", async () => {
  const db = memDb([row({ status: "paid", stripe_payment_intent_id: "pi_1" })]);
  assert.equal(await handleEvent(ev("charge.refunded", { payment_intent: "pi_1", refunded: false }), db, T), "ignored");
  assert.equal(db.rows[0].status, "paid");
  await handleEvent(ev("charge.refunded", { payment_intent: "pi_1", refunded: true }), db, T);
  assert.equal(db.rows[0].status, "refunded");
  const db2 = memDb([row({ status: "paid", stripe_invoice_id: "in_1" })]);
  await handleEvent(ev("charge.refunded", { invoice: "in_1", refunded: true }), db2, T);
  assert.equal(db2.rows[0].status, "refunded");
});
test("refunded rows are not flipped back to paid by a replayed checkout event", async () => {
  const db = memDb([row({ status: "refunded" })]);
  await handleEvent(ev("checkout.session.completed", { id: "cs_1", metadata: { donation_id: "d1" }, payment_status: "paid", payment_intent: "pi_1" }), db, T);
  assert.equal(db.rows[0].status, "refunded");
});
test("unrelated events ignored", async () => {
  assert.equal(await handleEvent(ev("customer.created", {}), memDb([]), T), "ignored");
});

test("bag count: one bag per full £40 of each paid one-off gift", () => {
  assert.equal(bagsFromPence([]), 0);
  assert.equal(bagsFromPence([4000, 8000, 5000, 3999, 100000]), 1 + 2 + 1 + 0 + 25);
  assert.equal(bagsFromPence([NaN, -5, 0]), 0);
  assert.deepEqual(buildCountResponse([4000, 40000]), { sponsored: 11, target: 600 });
});
