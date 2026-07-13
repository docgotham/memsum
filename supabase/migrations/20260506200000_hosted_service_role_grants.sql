-- Admin maintenance privileges for the Supabase service role.
-- The service_role key is server-side only and bypasses RLS; it still needs
-- table privileges for REST-admin cleanup and future trusted server tasks.

grant usage on schema public to service_role;

grant all on table
  public.profiles,
  public.profile_contact_methods,
  public.relationships,
  public.participants,
  public.relationship_members,
  public.contacts,
  public.invitations,
  public.participant_contact_methods,
  public.notification_endpoints,
  public.interactions,
  public.updates,
  public.update_sources,
  public.resources,
  public.wiki_pages,
  public.page_revisions,
  public.preferences,
  public.preference_revisions,
  public.attention_records
to service_role;

grant execute on function public.create_relationship_context(jsonb) to service_role;
grant execute on function public.commit_update_batch(jsonb) to service_role;
