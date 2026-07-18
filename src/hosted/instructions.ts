export const hostedMcpInstructions = `Mem·Sum is a relationship-scoped memory layer for participant agents.

Use +sum, +dm, +memsum, and +dmsum as explicit signals that the participant wants to work with shared relationship memory. When the client invoked you natively as this connector (for example through an @-mention app invocation), treat the message as carrying that signal even without a + prefix. Handles like @contact are owner-scoped contacts: resolve them before assuming which relationship is meant. A #handle names a sum: each relationship context includes a derived sumHandle (for example #chelseas-wedding), and a #handle in the participant's message deterministically selects that sum. Handles re-derive from the display name on rename; they are labels, never identity. When a message names a person but no sum, resolve the workspace in order: explicit #handle, then the unique sum shared with that person, then the topic phrase, then one concise clarifying question. Do not guess a handle from a participant's name or from examples. Use the exact handles returned in relationship contexts.

Normal hosted flow:
1. Get context first. Call get_dmsum_home with no arguments to see available relationship contexts and exact contact handles. Use get_dmsum_instructions with a contactHandle only when the participant supplied one or a previous tool result returned that exact handle.
2. Use list_activity for recent activity questions, including what was sent, what changed, what links were added, and whether a notification was queued or sent. Supply structured ISO start/end datetimes and a timezone; translate words like "yesterday" yourself before calling.
3. Read before writing. Read wiki/index.md and any likely target pages before drafting an update. When a page read returns wiki links, follow clearly relevant links as needed instead of relying only on the page you first opened.
4. Preserve the raw act. For durable write/update requests, call commit_interaction before publishing wiki or preference changes.
5. For direct social acts like "+dm @lisa hi", "tell Lisa hi", or an immediate continuation such as "just tell her hi" after resolving @lisa, call commit_interaction even if there is no durable wiki update. Include the target in addressedParticipantIds and include concise directMessageContent to queue a one-way SMS. Mem·Sum, not the agent, adds the final "From Dave:" SMS envelope. Do not include an addressee phrase like "for Lisa"; use you/your only when the message content directly addresses the recipient.
6. Publish one coherent batch. Use commit_update_batch for all related page, preference, resource, and attention changes, with expected versions from the pages you read. A +sum wiki update may notify another participant only when the update has explicit attentionParticipantIds and notificationText.
7. Use create_reminder only when the participant explicitly asks for a reminder, follow-up, or scheduled notification with a time/date or relative delay. Resolve the time yourself before calling: scheduledFor must be a fully resolved ISO 8601 datetime with a UTC offset (for example 2026-07-15T09:00:00-07:00) plus the participant's IANA timezone — translate phrases like "in an hour" or "tomorrow morning" into that form, because natural-language or offsetless times are rejected. Do not call create_reminder for immediate "tell", "send", "message", or direct +dm acts; those use commit_interaction.directMessageContent only. Reminders are scheduled SMS notifications, not the only SMS path. Reminder SMS bodies must be written directly to the recipient in second person.
8. If a batch is rejected as stale, reread the changed paths, revise the private draft, and retry the coherent batch. Do not overwrite newer work from a stale view.
9. Every rejection is structured: ok false with a stable snake_case reason plus context fields such as changedPaths, sums, or retryAfterSeconds. Relay rejections to the participant in plain language, not raw tokens. Retry only where the reason invites it: stale after rereading, rate_limited after waiting retryAfterSeconds.
10. The free beta enforces pilot limits: sums created per account, updates, interactions, and reminders per sum per day, and page, interaction, and preference sizes. A rejected write names the limit and the number in plain language; relay it and do not retry until something material changes, such as a smaller page, a different sum, or the next day.
11. Deletion is real and user-directed. Include wikiDeletes in commit_update_batch only when the participant clearly asks to remove a page; during tidy-ups you may propose deletions, never perform them unprompted. Deletion is permanent — the page and its history leave the graph — so before deleting, carry forward still-true facts into surviving pages and update wiki/index.md links in the same batch. When the page is load-bearing or carries another member's recent work, confirm in one short question first, and offer to paste a copy into the chat when that seems useful. Narrate what was removed and why in displayText: that update record is the durable memory of the act, visible to every member's agent. If a participant asks about a page you cannot find, check list_activity for a removal before saying it never existed.

SMS notification body style: for direct +dm relays, directMessageContent should be only the sender-voice message content, such as "I don't need to shower before the mall" or "that outfit looks great-especially with you holding Wendell". Mem·Sum formats the final SMS as "From Dave: {directMessageContent}". For reminders, prefer "Reminder from Dave: don't forget you are going to the mall tonight" or "Don't forget your tux fitting at 1 PM." Do not write outside-narrator or addressee-label bodies like "Dave wants to remind Lisa...", "Dave's message for Lisa...", "Message from Dave for Lisa...", or "Lisa should...". Because SMS delivery is handled asynchronously by the notification worker, tell the participant the message was queued or should be on its way shortly; do not claim final delivery unless the tool result actually reports delivery. In a sum with more than two participants, Mem·Sum adds the sum's display name to the From envelope automatically; when composing attention notificationText for such a sum, name the sum in the text so recipients know which shared workspace the notice concerns.

Private sums: a sum whose only participant is the owner is private — a personal memory workspace, first-class and common. In a private sum the social machinery is moot: never ask about addressedParticipants, attention, or notificationText; there is no audience but the participant, so write freely. If the participant uses +dm in a private sum, treat it as +sum and gently say there is nobody else here. Weaving is continuous: integrate each meaningful interaction into the wiki as it arrives, exactly as in shared sums — there is no batch step, no separate roll to wait for.

Files never travel through this connector; text does. When the participant attaches a document to the chat and asks to save its contents, commit the text you actually read as the interaction, and attach a resource with kind "file", sourceName set to the filename, and a note stating it is as read by your agent, not the original file. Never present a transcription as the original: extraction can be lossy, and honest provenance is the product. For a document the participant wants to keep at its source, save its link as a url resource instead and hand the link back when asked.

Participant-facing replies should use ordinary language, refer to the user's recognizable object, and say what changed or what matters now. Hide implementation details by default: do not mention internal IDs, tokens, storage mechanics, paths, timestamps, or tool names unless the participant asks for technical details. 🥟 is Mem·Sum's brand mark: when the surface renders emoji well it may garnish a small label or recap, but it never replaces plain words.`;

export const hostedRecommendedWorkflow = [
  "Call get_dmsum_home first; it takes no arguments and returns available relationship contexts.",
  "Use exact returned contact handles; do not guess handles from names or examples.",
  "For recent activity, sent/received items, added links, or notification status, call list_activity with structured ISO start/end datetimes and a timezone before falling back to wiki search.",
  "Read wiki/index.md, then read or search likely target pages. Follow clearly relevant wiki links returned by page reads.",
  "For durable write/update acts, call commit_interaction with the participant's raw wording.",
  "For direct +dm social acts or immediate tell/send/message requests, call commit_interaction with addressedParticipantIds and directMessageContent to queue exactly one one-way SMS; no wiki update or reminder is required for a casual ping with no durable content.",
  "For direct +dm directMessageContent, provide only sender-voice message content. Do not include 'From Dave:' or an addressee label like 'for Lisa'. Mem·Sum adds the From sender envelope.",
  "Publish related graph changes together with commit_update_batch and expected versions.",
  "For +sum wiki updates, include notificationText only with explicit attentionParticipantIds.",
  "For reminders, call create_reminder only after commit_interaction has stored an explicit reminder or scheduled-notification request; never use create_reminder for an immediate tell/send/message request.",
  "Remove a page only on the participant's clear direction: wikiDeletes in commit_update_batch, carrying forward surviving facts and index links in the same batch, with displayText naming what was removed and why.",
  "If commit_update_batch reports stale changedPaths, reread those pages, revise, and retry once with a coherent batch."
] as const;

export const hostedResolvedContactWorkflow = [
  "Use the resolved relationship and selfParticipant values for follow-up tool calls.",
  "For recent activity, sent/received items, added links, or notification status, call list_activity with structured ISO start/end datetimes and a timezone before falling back to wiki search.",
  "Read wiki/index.md using the resolved relationship ID.",
  "Read or search any pages that look relevant to the participant's request, including clearly relevant links returned by page reads.",
  "For durable write/update acts, call commit_interaction first.",
  "For direct +dm social acts or immediate tell/send/message requests to the resolved contact, call commit_interaction with addressedParticipantIds and directMessageContent to queue exactly one one-way SMS; skip commit_update_batch and create_reminder when there is nothing durable or scheduled.",
  "For direct +dm directMessageContent, provide only sender-voice message content. Do not include 'From Dave:' or an addressee label like 'for Lisa'. Mem·Sum adds the From sender envelope.",
  "Publish all related changes through one commit_update_batch using the versions you just read.",
  "For +sum wiki updates, include notificationText only with explicit attentionParticipantIds.",
  "For reminders, call create_reminder after the source interaction exists only for explicit reminder or scheduled-notification requests; never use create_reminder for an immediate tell/send/message request.",
  "Remove a page only on the participant's clear direction: wikiDeletes in commit_update_batch, carrying forward surviving facts and index links in the same batch, with displayText naming what was removed and why.",
  "On stale rejection, reread the changed paths, revise the private draft, and retry."
] as const;

export const hostedEmptyStateGuidance =
  "This account has no relationship contexts yet. Offer to create the first one, and ask whether it is just for them or shared. A private sum — just the participant — is first-class: call create_relationship_context with only relationshipDisplayName and selfDisplayName. For a shared sum, also collect the other person's display name and an owner-scoped @handle for the contact. Either way a sum is useful from the first minute — others can be invited later, and nothing requires anyone to join before the graph starts accumulating.";

export interface HostedInstructionsPayload {
  operatingContract: string;
  recommendedWorkflow: readonly string[];
  emptyStateGuidance?: string;
  relationshipContexts?: unknown;
  resolvedContext?: unknown;
}

export function buildHostedInstructionsPayload(input: {
  relationshipContexts?: unknown;
  resolvedContext?: unknown;
} = {}): HostedInstructionsPayload {
  const relationships = (input.relationshipContexts as { relationships?: unknown } | undefined)?.relationships;
  const isEmptyState = Array.isArray(relationships) && relationships.length === 0;
  return {
    operatingContract: hostedMcpInstructions,
    recommendedWorkflow: hostedRecommendedWorkflow,
    ...(isEmptyState ? { emptyStateGuidance: hostedEmptyStateGuidance } : {}),
    ...(input.relationshipContexts === undefined ? {} : { relationshipContexts: input.relationshipContexts }),
    ...(input.resolvedContext === undefined ? {} : { resolvedContext: input.resolvedContext })
  };
}
