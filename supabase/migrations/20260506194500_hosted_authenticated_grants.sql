-- API role privileges for the hosted kernel.
-- RLS still controls row-level access; these grants allow authenticated
-- Supabase requests to reach the policies and RPC functions.

grant usage on schema public to authenticated;

grant select, insert, update on table
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
to authenticated;

grant execute on function public.create_relationship_context(jsonb) to authenticated;
grant execute on function public.commit_update_batch(jsonb) to authenticated;
