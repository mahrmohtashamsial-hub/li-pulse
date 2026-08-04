create table if not exists jobs (
  id text primary key,
  status text not null,
  created_at text not null,
  updated_at text not null,
  config_json text not null,
  url_count integer not null,
  error text
);

create table if not exists job_actors (
  job_id text not null,
  actor_key text not null,
  apify_run_id text,
  status text not null,
  dataset_id text,
  item_count integer,
  output_json text,
  error text,
  started_at text,
  finished_at text,
  primary key (job_id, actor_key),
  foreign key (job_id) references jobs(id) on delete cascade
);

create table if not exists job_results (
  job_id text not null,
  profile_slug text not null,
  merged_json text not null,
  primary key (job_id, profile_slug),
  foreign key (job_id) references jobs(id) on delete cascade
);

create table if not exists job_webhook_events (
  job_id text not null,
  apify_run_id text not null,
  event_type text not null,
  received_at text not null,
  primary key (job_id, apify_run_id, event_type)
);

create index if not exists idx_jobs_status_updated on jobs(status, updated_at);
create index if not exists idx_job_actors_status_started on job_actors(status, started_at);
create index if not exists idx_job_results_job_slug on job_results(job_id, profile_slug);
