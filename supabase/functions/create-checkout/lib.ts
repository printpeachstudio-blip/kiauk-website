// Pure helpers for create-checkout. No Deno or Node specific APIs, so they can be tested in Node.

export const GIFT_AID_WORDING_VERSION = "v1";
export const GIFT_AID_WORDING =
  "I want to Gift Aid my donation and any donations I make in the future or have made in the past 4 years to Kindness In Action UK. I am a UK taxpayer and understand that if I pay less Income Tax and/or Capital Gains Tax in the current tax year than the amount of Gift Aid claimed on all my donations it is my responsibility to pay any difference.";

export const MIN_PENCE = 100; // £1
export const MAX_PENCE = 1_000_000; // £10,000
export const BAG_PENCE = 4000; // £40 per winter bag

export type Payload = {
  frequency: "one_off" | "monthly";
  amount_pence: number;
  donor_type: "individual" | "business";
  first_name: string;
  last_name: string;
  email: string;
  business_name: string | null;
  gift_aid: boolean;
  house_name_or_number: string | null;
  address_line_1: string | null;
  town: string | null;
  postcode: string | null;
  public_naming_ok: boolean;
  marketing_consent: boolean;
  bags: number | null;
};

export type ValidationResult =
  | { ok: true; value: Payload }
  | { ok: false; errors: Record<string, string> };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// UK postcode, loose but sensible. Normalised to upper case with a single space.
const POSTCODE_RE = /^([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9][A-Z]{2})$/;

export function normalisePostcode(input: string): string | null {
  const m = input.trim().toUpperCase().match(POSTCODE_RE);
  return m ? `${m[1]} ${m[2]}` : null;
}

function str(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  // strip control characters, collapse whitespace
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function validatePayload(raw: unknown): ValidationResult {
  const errors: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: { _: "Invalid request." } };
  }
  const b = raw as Record<string, unknown>;

  const frequency = b.frequency === "monthly" ? "monthly" : b.frequency === "one_off" ? "one_off" : null;
  if (!frequency) errors.frequency = "Choose one-off or monthly.";

  const amount = b.amount_pence;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < MIN_PENCE || amount > MAX_PENCE) {
    errors.amount_pence = "Enter an amount between £1 and £10,000.";
  }

  const donorType = b.donor_type === "business" ? "business" : b.donor_type === "individual" ? "individual" : null;
  if (!donorType) errors.donor_type = "Choose individual or business.";

  const first = str(b.first_name, 80);
  const last = str(b.last_name, 80);
  if (!first) errors.first_name = "Enter your first name.";
  if (!last) errors.last_name = "Enter your last name.";

  const email = str(b.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";

  let business: string | null = null;
  if (donorType === "business") {
    business = str(b.business_name, 160);
    if (!business) errors.business_name = "Enter the business name.";
  }

  // Gift Aid is for individuals only. Ignore the flag for businesses rather than trusting the client.
  const giftAid = donorType === "individual" && b.gift_aid === true;
  let house: string | null = null;
  let line1: string | null = null;
  let town: string | null = null;
  let postcode: string | null = null;
  if (giftAid) {
    house = str(b.house_name_or_number, 80);
    if (!house) errors.house_name_or_number = "Enter your house name or number.";
    line1 = str(b.address_line_1, 120) || null;
    town = str(b.town, 80) || null;
    postcode = normalisePostcode(str(b.postcode, 12));
    if (!postcode) errors.postcode = "Enter a valid UK postcode.";
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  const amountPence = amount as number;
  const bags = frequency === "one_off" && amountPence % BAG_PENCE === 0 ? amountPence / BAG_PENCE : null;

  return {
    ok: true,
    value: {
      frequency: frequency as Payload["frequency"],
      amount_pence: amountPence,
      donor_type: donorType as Payload["donor_type"],
      first_name: first,
      last_name: last,
      email,
      business_name: business,
      gift_aid: giftAid,
      house_name_or_number: house,
      address_line_1: line1,
      town,
      postcode,
      public_naming_ok: donorType === "business" && b.public_naming_ok === true,
      marketing_consent: b.marketing_consent === true,
      bags,
    },
  };
}

export type SessionInput = {
  payload: Payload;
  donationId: string;
  donorId: string;
  siteUrl: string;
};

/** Builds the form-encoded body for POST /v1/checkout/sessions. */
export function buildCheckoutParams(i: SessionInput): URLSearchParams {
  const p = i.payload;
  const monthly = p.frequency === "monthly";
  const params = new URLSearchParams();
  params.set("mode", monthly ? "subscription" : "payment");
  params.set("success_url", `${i.siteUrl}/thanks.html`);
  params.set("cancel_url", `${i.siteUrl}/donate.html?cancelled=1`);
  params.set("customer_email", p.email);
  params.set("submit_type", monthly ? "auto" : "donate");
  params.set("client_reference_id", i.donationId);
  params.set("billing_address_collection", "auto");

  const productName = monthly
    ? "Monthly donation to Kindness In Action UK"
    : p.bags
    ? `Sponsor ${p.bags} winter bag${p.bags === 1 ? "" : "s"} - Kindness In Action UK`
    : "Donation to Kindness In Action UK";

  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "gbp");
  params.set("line_items[0][price_data][unit_amount]", String(p.amount_pence));
  params.set("line_items[0][price_data][product_data][name]", productName);
  if (monthly) params.set("line_items[0][price_data][recurring][interval]", "month");

  const meta: Record<string, string> = {
    donation_id: i.donationId,
    donor_id: i.donorId,
    gift_aid: p.gift_aid ? "yes" : "no",
    donor_type: p.donor_type,
  };
  for (const [k, v] of Object.entries(meta)) {
    params.set(`metadata[${k}]`, v);
    params.set(monthly ? `subscription_data[metadata][${k}]` : `payment_intent_data[metadata][${k}]`, v);
  }
  if (!monthly) {
    params.set("payment_intent_data[receipt_email]", p.email);
    params.set("payment_intent_data[description]", productName);
  }
  return params;
}

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
