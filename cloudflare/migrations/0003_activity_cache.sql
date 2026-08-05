alter table jobs add column cache_key text;
create index if not exists idx_jobs_cache_key_status_created on jobs(cache_key, status, created_at);
