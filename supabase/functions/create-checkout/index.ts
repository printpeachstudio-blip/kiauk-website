import { createClient } from "npm:@supabase/supabase-js@2";
import {
  GIFT_AID_WORDING,
  GIFT_AID_WORDING_VERSION,
  buildCheckoutParams,
  corsHeaders,
  validatePayload,
} from "./lib.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://kiauk.org";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://kiauk.org,https://www.kiauk.org")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin, ALLOWED_ORIGINS);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: "Forbidden" }, 403, cors);

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    console.error("STRIPE_SECRET_KEY is not set");
    return json({ error: "Payments are not available right now." }, 503, cors);
  }

  let raw: Record<string, unknown>;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400, cors);
  }

  // Honeypot: real visitors never fill this in. Pretend it worked so bots move on.
  if (typeof raw.website === "string" && raw.website.trim() !== "") {
    return json({ url: `${SITE_URL}/thanks.html` }, 200, cors);
  }

  const result = validatePayload(raw);
  if (!result.ok) return json({ error: "Please check the form.", fields: result.errors }, 422, cors);
  const p = result.value;

  // Light abuse guard: no more than 10 attempts per email per hour.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("donors")
    .select("id", { count: "exact", head: true })
    .eq("email", p.email)
    .gte("created_at", since);
  if ((count ?? 0) >= 10) return json({ error: "Too many attempts. Please try again later." }, 429, cors);

  const now = new Date().toISOString();
  const { data: donor, error: donorErr } = await supabase
    .from("donors")
    .insert({
      donor_type: p.donor_type,
      first_name: p.first_name,
      last_name: p.last_name,
      email: p.email,
      business_name: p.business_name,
      house_name_or_number: p.house_name_or_number,
      address_line_1: p.address_line_1,
      town: p.town,
      postcode: p.postcode,
      country: "GB",
      public_naming_ok: p.public_naming_ok,
      marketing_consent: p.marketing_consent,
      marketing_consent_at: p.marketing_consent ? now : null,
    })
    .select("id")
    .single();
  if (donorErr || !donor) {
    console.error("donor insert failed", donorErr);
    return json({ error: "Something went wrong. Please try again." }, 500, cors);
  }

  let declarationId: string | null = null;
  if (p.gift_aid) {
    const { data: decl, error: declErr } = await supabase
      .from("gift_aid_declarations")
      .insert({
        donor_id: donor.id,
        declared_at: now,
        wording: `[${GIFT_AID_WORDING_VERSION}] ${GIFT_AID_WORDING}`,
        covers_past_four_years: true,
        covers_future: true,
        source: "website",
      })
      .select("id")
      .single();
    if (declErr || !decl) {
      console.error("declaration insert failed", declErr);
      return json({ error: "Something went wrong. Please try again." }, 500, cors);
    }
    declarationId = decl.id;
  }

  const { data: donation, error: donationErr } = await supabase
    .from("donations")
    .insert({
      donor_id: donor.id,
      declaration_id: declarationId,
      amount_pence: p.amount_pence,
      currency: "gbp",
      frequency: p.frequency,
      bags: p.bags,
      status: "pending",
    })
    .select("id")
    .single();
  if (donationErr || !donation) {
    console.error("donation insert failed", donationErr);
    return json({ error: "Something went wrong. Please try again." }, 500, cors);
  }

  const params = buildCheckoutParams({
    payload: p,
    donationId: donation.id,
    donorId: donor.id,
    siteUrl: SITE_URL,
  });

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `checkout-${donation.id}`,
    },
    body: params,
  });
  const session = await res.json();
  if (!res.ok || !session?.url) {
    console.error("stripe session failed", res.status, session?.error?.message);
    await supabase.from("donations").update({ status: "failed" }).eq("id", donation.id);
    return json({ error: "We could not start the payment. Please try again." }, 502, cors);
  }

  await supabase.from("donations").update({ stripe_checkout_session_id: session.id }).eq("id", donation.id);

  return json({ url: session.url }, 200, cors);
});
