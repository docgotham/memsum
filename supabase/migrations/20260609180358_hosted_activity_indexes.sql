-- Read-path support for hosted list_activity.
-- These indexes keep recent relationship activity windows and joins cheap
-- without adding any new semantic tables or app-view state.

create index if not exists interactions_relationship_created_at_idx
  on public.interactions (relationship_id, created_at desc);

create index if not exists updates_relationship_created_at_idx
  on public.updates (relationship_id, created_at desc);

create index if not exists resources_relationship_created_at_idx
  on public.resources (relationship_id, created_at desc);

create index if not exists resources_interaction_idx
  on public.resources (interaction_id)
  where interaction_id is not null;

create index if not exists resources_update_idx
  on public.resources (update_id)
  where update_id is not null;

create index if not exists update_sources_update_idx
  on public.update_sources (update_id);

create index if not exists page_revisions_update_idx
  on public.page_revisions (update_id);

create index if not exists notification_jobs_source_idx
  on public.notification_jobs (source_kind, source_id);
