create table if not exists public.li_pulse_cache (
  provider text not null,
  linkedin_url text not null,
  fetched_at timestamptz not null default now(),
  raw jsonb not null,
  primary key (provider, linkedin_url)
);

alter table public.li_pulse_cache enable row level security;
revoke all on public.li_pulse_cache from anon, authenticated;

comment on table public.li_pulse_cache is
  'Private raw provider-response cache used only by the li-pulse Edge Function.';

