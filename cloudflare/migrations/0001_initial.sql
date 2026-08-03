create table if not exists profile_cache (
  provider text not null,
  linkedin_url text not null,
  fetched_at text not null,
  raw_json text not null,
  primary key (provider, linkedin_url)
);

create index if not exists idx_profile_cache_fetched_at
  on profile_cache(fetched_at);

create table if not exists run_audit (
  id text primary key,
  created_at text not null,
  profile_count integer not null,
  provider text not null,
  succeeded integer not null,
  failed integer not null
);

create index if not exists idx_run_audit_created_at
  on run_audit(created_at);

