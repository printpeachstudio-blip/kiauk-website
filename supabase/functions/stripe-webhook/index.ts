import { createClient } from "npm:@supabase/supabase-js@2";
import { type Db, type Donation, type Find, handleEvent, verifyStripeSignature } from "./lib.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const COLUMNS =
  "id, donor_id, declaration_id, amount_pence, frequency, status, stripe_checkout_session_id, stripe_payment_intent_id, stripe_subscription_id, stripe_invoice_id";

const db: Db = {
  async find(by: Find): Promise<Donation | null> {
    let q = supabase.from("donations").select(COLUMNS);
    for (const [k, v] of Object.entries(by)) q = q.eq(k, v as string);
    const { data, error } = await q.order("created_at", { ascending: true }).limit(1);
    if (error) throw error;
    return (data?.[0] as Donation) ?? null;
  },
  async update(id, patch) {
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const { error } = await supabase.from("donations").update(clean).eq("id", id);
    if (error) throw error;
  },
  async insert(row) {
    const { error } = await supabase.from("donations").insert(row);
    if (error) throw error;
  },
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set");
    return new Response("Not configured", { status: 503 });
  }

  const rawBody = await req.text();
  const ok = await verifyStripeSignature(rawBody, req.headers.get("stripe-signature"), secret);
  if (!ok) return new Response("Invalid signature", { status: 400 });

  try {
    const event = JSON.parse(rawBody);
    const outcome = await handleEvent(event, db);
    console.log(JSON.stringify({ event: event.id, type: event.type, outcome }));
    // "retry" means we could not find the row yet (events can arrive out of order). Stripe will resend.
    if (outcome === "retry") return new Response("Retry later", { status: 409 });
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("webhook handler failed", err);
    return new Response("Handler error", { status: 500 });
  }
});
