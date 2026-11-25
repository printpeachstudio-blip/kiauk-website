import { createClient } from "npm:@supabase/supabase-js@2";
import { buildCountResponse } from "./lib.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// The number is public and contains no personal information, so any origin may read it.
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=60",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });

  const amounts: number[] = [];
  const page = 1000;
  for (let from = 0; from < 20000; from += page) {
    const { data, error } = await supabase
      .from("donations")
      .select("amount_pence")
      .eq("status", "paid")
      .eq("frequency", "one_off")
      .order("created_at", { ascending: true })
      .range(from, from + page - 1);
    if (error) {
      console.error("bag-count query failed", error);
      return new Response(JSON.stringify({ error: "Unavailable" }), { status: 503, headers: { ...headers, "Cache-Control": "no-store" } });
    }
    for (const r of data ?? []) amounts.push(r.amount_pence as number);
    if (!data || data.length < page) break;
  }
  return new Response(JSON.stringify(buildCountResponse(amounts)), { status: 200, headers });
});
