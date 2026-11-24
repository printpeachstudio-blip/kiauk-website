// Pure logic for the Stripe webhook. No Deno or Node specific APIs, so it can be tested in Node.

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Verifies a Stripe-Signature header against the raw request body. */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || !sigs.length) return false;
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  return sigs.some((s) => safeEqual(s, expected));
}

export type Donation = {
  id: string;
  donor_id: string;
  declaration_id: string | null;
  amount_pence: number;
  frequency: string;
  status: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_subscription_id: string | null;
  stripe_invoice_id: string | null;
};

export type Find = Partial<{
  id: string;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string;
  stripe_subscription_id: string;
  stripe_invoice_id: string;
}>;

export interface Db {
  find(by: Find): Promise<Donation | null>;
  update(id: string, patch: Record<string, unknown>): Promise<void>;
  insert(row: Record<string, unknown>): Promise<void>;
}

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;
export type StripeEvent = { id: string; type: string; data: { object: Obj } };

export type Outcome = "handled" | "ignored" | "retry";

const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" && typeof (v as Obj).id === "string" ? (v as Obj).id : null;

/** Subscription id on an invoice, across old and new Stripe API versions. */
export function invoiceSubscriptionId(inv: Obj): string | null {
  return idOf(inv.subscription) ?? idOf(inv.parent?.subscription_details?.subscription);
}

export function invoiceDonationId(inv: Obj): string | null {
  const m = inv.subscription_details?.metadata ?? inv.parent?.subscription_details?.metadata ?? inv.metadata ?? {};
  return typeof m.donation_id === "string" ? m.donation_id : null;
}

export async function handleEvent(event: StripeEvent, db: Db, now: () => string = () => new Date().toISOString()): Promise<Outcome> {
  const o = event.data.object;

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const donationId = (o.metadata?.donation_id as string | undefined) ?? (o.client_reference_id as string | undefined);
      const row = (donationId ? await db.find({ id: donationId }) : null) ?? (await db.find({ stripe_checkout_session_id: o.id }));
      if (!row) return "retry";
      const patch: Record<string, unknown> = { stripe_checkout_session_id: o.id };
      const pi = idOf(o.payment_intent);
      const sub = idOf(o.subscription);
      if (pi) patch.stripe_payment_intent_id = pi;
      if (sub) patch.stripe_subscription_id = sub;
      // Delayed methods complete the session before the money arrives.
      if (o.payment_status === "paid" && row.status !== "refunded") {
        patch.status = "paid";
        if (row.status !== "paid") patch.paid_at = now();
      }
      await db.update(row.id, patch);
      return "handled";
    }

    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const row = await db.find({ stripe_checkout_session_id: o.id });
      if (!row) return "ignored";
      if (row.status === "pending") await db.update(row.id, { status: "failed" });
      return "handled";
    }

    case "invoice.paid": {
      const subId = invoiceSubscriptionId(o);
      if (!subId) return "ignored"; // not a subscription invoice
      if (await db.find({ stripe_invoice_id: o.id })) return "handled"; // already recorded

      const donationId = invoiceDonationId(o);
      const parent = (donationId ? await db.find({ id: donationId }) : null) ?? (await db.find({ stripe_subscription_id: subId }));
      if (!parent) return "retry";

      if (!parent.stripe_invoice_id) {
        // First invoice of the subscription belongs to the row created at checkout.
        await db.update(parent.id, {
          stripe_invoice_id: o.id,
          stripe_subscription_id: subId,
          status: "paid",
          paid_at: parent.status === "paid" ? undefined : now(),
        });
        return "handled";
      }

      // A later monthly payment: new row, same donor and Gift Aid declaration.
      await db.insert({
        donor_id: parent.donor_id,
        declaration_id: parent.declaration_id,
        amount_pence: o.amount_paid,
        currency: o.currency ?? "gbp",
        frequency: "monthly",
        bags: null,
        status: "paid",
        stripe_subscription_id: subId,
        stripe_invoice_id: o.id,
        paid_at: now(),
      });
      return "handled";
    }

    case "charge.refunded": {
      if (o.refunded !== true) return "ignored"; // partial refund: needs a human to review it in Stripe
      const pi = idOf(o.payment_intent);
      const inv = idOf(o.invoice);
      const row = (pi ? await db.find({ stripe_payment_intent_id: pi }) : null) ?? (inv ? await db.find({ stripe_invoice_id: inv }) : null);
      if (!row) return "ignored";
      await db.update(row.id, { status: "refunded" });
      return "handled";
    }

    default:
      return "ignored";
  }
}
