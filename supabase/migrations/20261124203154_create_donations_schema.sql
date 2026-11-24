-- Donations and Gift Aid capture.
-- RLS is enabled on every table with NO policies, so browser keys (anon,
-- authenticated) can read and write nothing. Only server code using the
-- service role can touch these tables.

create table public.donors (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  donor_type text check (donor_type in ('individual', 'business')),
  first_name text,
  last_name text,
  email text,
  business_name text,
  house_name_or_number text,
  address_line_1 text,
  town text,
  postcode text,
  country text default 'GB',
  public_naming_ok boolean default false,
  marketing_consent boolean default false,
  marketing_consent_at timestamptz
);

create table public.gift_aid_declarations (
  id uuid primary key default gen_random_uuid(),
  donor_id uuid not null references public.donors (id),
  declared_at timestamptz not null default now(),
  wording text not null,
  covers_past_four_years boolean default true,
  covers_future boolean default true,
  source text,
  withdrawn_at timestamptz null
);

create table public.donations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  donor_id uuid not null references public.donors (id),
  declaration_id uuid null references public.gift_aid_declarations (id),
  amount_pence integer not null check (amount_pence > 0),
  currency text default 'gbp',
  frequency text check (frequency in ('one_off', 'monthly')),
  bags integer null,
  status text default 'pending' check (status in ('pending', 'paid', 'failed', 'refunded')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  stripe_subscription_id text,
  stripe_invoice_id text unique null,
  paid_at timestamptz,
  gift_aid_claimed_at timestamptz null
);

alter table public.donors enable row level security;
alter table public.gift_aid_declarations enable row level security;
alter table public.donations enable row level security;

-- Indexes (the unique constraints on the two stripe ids already create indexes)
create index donations_stripe_payment_intent_id_idx on public.donations (stripe_payment_intent_id);
create index donations_stripe_subscription_id_idx on public.donations (stripe_subscription_id);
create index donors_email_idx on public.donors (email);
create index donations_status_idx on public.donations (status);
-- Foreign key lookups
create index donations_donor_id_idx on public.donations (donor_id);
create index donations_declaration_id_idx on public.donations (declaration_id);
create index gift_aid_declarations_donor_id_idx on public.gift_aid_declarations (donor_id);

-- Export for the HMRC Gift Aid claim
create view public.gift_aid_export
with (security_invoker = true) as
select
  d.paid_at as donation_date,
  d.amount_pence,
  dn.first_name,
  dn.last_name,
  dn.house_name_or_number,
  dn.postcode,
  g.declared_at as declaration_date
from public.donations d
join public.donors dn on dn.id = d.donor_id
join public.gift_aid_declarations g on g.id = d.declaration_id
where d.status = 'paid';

-- Nothing is reachable from a browser
revoke all on table public.donors from anon, authenticated;
revoke all on table public.gift_aid_declarations from anon, authenticated;
revoke all on table public.donations from anon, authenticated;
revoke all on table public.gift_aid_export from anon, authenticated;
