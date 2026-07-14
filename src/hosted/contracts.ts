import * as z from "zod/v4";
import { isSafeGraphLocator, isSafeGraphPath } from "./paths.js";

export const hostedToolNames = [
  "get_dmsum_home",
  "get_dmsum_instructions",
  "create_relationship_context",
  "list_relationship_contexts",
  "resolve_contact",
  "commit_interaction",
  "read_page",
  "list_pages",
  "search_pages",
  "list_activity",
  "commit_update_batch",
  "create_reminder",
  "get_relationship_context"
] as const;

export type HostedToolName = (typeof hostedToolNames)[number];

export const uuidSchema = z.string().uuid();

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Expected a normalized email address");

export const phoneE164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected an E.164 phone number");

export const contactHandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^@[a-z0-9][a-z0-9_-]{0,63}$/, "Expected an owner-scoped handle like @lisa");

export const graphPathSchema = z.string().refine(isSafeGraphPath, "Expected a relative markdown graph path");
export const graphLocatorSchema = z.string().refine(isSafeGraphLocator, "Expected a safe markdown graph path or wiki link");

export const contactMethodSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("email"),
    valueNormalized: emailSchema
  }),
  z.object({
    kind: z.literal("phone"),
    valueNormalized: phoneE164Schema
  })
]);

export const resourceMetadataSchema = z.object({
  canonicalUrl: z.string().url().optional(),
  siteName: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  imageUrl: z.string().url().optional()
});

export const hostedResourceSchema = z.object({
  kind: z.enum(["url", "excerpt", "url_with_excerpt", "file"]),
  url: z.string().url().optional(),
  title: z.string().min(1).optional(),
  sourceName: z.string().min(1).optional(),
  quotedText: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  metadata: resourceMetadataSchema.optional()
});

export const commitInteractionSchema = z.object({
  relationshipId: uuidSchema.describe("Relationship receiving the raw +sum, +dm, or +dmsum act."),
  participantId: uuidSchema.describe("Participant who authored the raw act."),
  agent: z.string().min(1).describe("Name of the agent preserving the interaction."),
  rawText: z.string().min(1).describe("Participant's exact raw wording."),
  addressedParticipantIds: z
    .array(uuidSchema)
    .optional()
    .describe("Known participants directly addressed by this act. Required when queuing an immediate +dm SMS notification."),
  resources: z.array(hostedResourceSchema).optional(),
  directMessageContent: z
    .string()
    .trim()
    .min(1)
    .max(320)
    .optional()
    .describe(
      "Sender-voice message content for immediate +dm or tell/send/message requests. Do not include 'From Dave:' or any addressee label. Mem·Sum formats the final SMS envelope."
    ),
  notificationText: z
    .string()
    .optional()
    .describe(
      "Legacy immediate SMS body. Do not use for direct +dm or tell/send/message requests; use directMessageContent so Mem·Sum can format the final SMS envelope."
    )
}).refine((input) => !input.directMessageContent || Boolean(input.addressedParticipantIds?.length), {
  message: "directMessageContent requires addressedParticipantIds",
  path: ["addressedParticipantIds"]
});

export const readPageSchema = z.object({
  relationshipId: uuidSchema,
  path: graphLocatorSchema
});

export const listPagesSchema = z.object({
  relationshipId: uuidSchema,
  prefix: z.string().optional()
});

export const searchPagesSchema = z.object({
  relationshipId: uuidSchema,
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional()
});

export const listActivitySchema = z
  .object({
    relationshipId: uuidSchema,
    start: z.string().datetime({ offset: true }).describe("Inclusive ISO datetime with offset for the activity window start."),
    end: z.string().datetime({ offset: true }).describe("Exclusive ISO datetime with offset for the activity window end."),
    timezone: z.string().trim().min(1).max(64).describe("IANA timezone used only for participant-facing display times."),
    actorParticipantId: uuidSchema.optional(),
    targetParticipantId: uuidSchema.optional(),
    limit: z.number().int().positive().max(100).optional().default(50)
  })
  .refine((input) => Date.parse(input.start) < Date.parse(input.end), {
    message: "end must be after start",
    path: ["end"]
  });

export const getRelationshipContextSchema = z.object({
  relationshipId: uuidSchema,
  contactHandle: contactHandleSchema.optional()
});

export const createRelationshipContextSchema = z.object({
  relationshipDisplayName: z.string().trim().min(1),
  selfDisplayName: z.string().trim().min(1),
  peerDisplayName: z.string().trim().min(1).optional(),
  contactHandle: contactHandleSchema.optional(),
  contactDisplayName: z.string().trim().min(1).optional()
});

export const listRelationshipContextsSchema = z.object({
  contactHandle: contactHandleSchema.optional()
});

export const resolveContactSchema = z.object({
  contactHandle: contactHandleSchema
});

export const getDmsumInstructionsSchema = z.object({
  contactHandle: contactHandleSchema.optional()
});

export const getDmsumHomeSchema = z.object({});

export const readSetItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("wiki_page"),
    path: graphPathSchema,
    expectedVersion: z.number().int().min(0),
    hash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
  }),
  z.object({
    kind: z.literal("preference"),
    participantId: uuidSchema,
    expectedVersion: z.number().int().min(0),
    hash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
  })
]);

export const hostedWikiWriteSchema = z.object({
  path: graphPathSchema,
  title: z.string().min(1),
  expectedVersion: z.number().int().min(0),
  content: z.string().min(1)
});

export const hostedPreferenceWriteSchema = z.object({
  participantId: uuidSchema,
  expectedVersion: z.number().int().min(0),
  content: z.string().min(1)
});

export const commitUpdateBatchSchema = z
  .object({
    relationshipId: uuidSchema,
    participantId: uuidSchema,
    actorKind: z.enum(["participant_agent", "workspace_agent"]).optional(),
    agent: z.string().min(1),
    sourceInteractionIds: z.array(uuidSchema).min(1),
    displayText: z.string().min(1),
    readSet: z.array(readSetItemSchema),
    wikiWrites: z.array(hostedWikiWriteSchema).optional(),
    preferenceWrites: z.array(hostedPreferenceWriteSchema).optional(),
    resources: z.array(hostedResourceSchema).optional(),
    attentionParticipantIds: z.array(uuidSchema).optional(),
    notificationText: z
      .string()
      .optional()
      .describe(
        "Concise one-way SMS body for explicitly attended update recipients. Write directly to the recipient: use you/your for the recipient, not the recipient display name or addressee labels like 'for Lisa'."
      )
  })
  .refine(
    (input) =>
      Boolean(input.wikiWrites?.length) ||
      Boolean(input.preferenceWrites?.length) ||
      Boolean(input.resources?.length) ||
      Boolean(input.attentionParticipantIds?.length),
    "Expected at least one hosted update effect"
  );

export const createReminderSchema = z.object({
  relationshipId: uuidSchema,
  participantId: uuidSchema,
  sourceInteractionId: uuidSchema,
  recipientParticipantId: uuidSchema,
  agent: z.string().min(1),
  body: z
    .string()
    .trim()
    .min(1)
    .max(320)
    .describe(
      "Concise reminder SMS body written directly to the recipient in second person: use you/your, not the recipient display name or addressee labels like 'for Lisa'. Use create_reminder only for explicit reminder or scheduled-notification requests, never for immediate tell/send/message requests."
    ),
  scheduledFor: z
    .string()
    .datetime({ offset: true })
    .describe(
      "When to send it: a fully resolved ISO 8601 datetime with a UTC offset, for example 2026-07-15T09:00:00-07:00. Translate relative phrases like 'in an hour' into this form before calling; natural-language or offsetless times are rejected."
    ),
  timezone: z.string().trim().min(1).max(64)
});

export const hostedOperationSchemas = {
  get_dmsum_home: getDmsumHomeSchema,
  get_dmsum_instructions: getDmsumInstructionsSchema,
  create_relationship_context: createRelationshipContextSchema,
  list_relationship_contexts: listRelationshipContextsSchema,
  resolve_contact: resolveContactSchema,
  commit_interaction: commitInteractionSchema,
  read_page: readPageSchema,
  list_pages: listPagesSchema,
  search_pages: searchPagesSchema,
  list_activity: listActivitySchema,
  commit_update_batch: commitUpdateBatchSchema,
  create_reminder: createReminderSchema,
  get_relationship_context: getRelationshipContextSchema
} satisfies Record<HostedToolName, z.ZodType>;

export type CommitInteractionInput = z.infer<typeof commitInteractionSchema>;
export type ReadPageInput = z.infer<typeof readPageSchema>;
export type ListPagesInput = z.infer<typeof listPagesSchema>;
export type SearchPagesInput = z.infer<typeof searchPagesSchema>;
export type ListActivityInput = z.infer<typeof listActivitySchema>;
export type GetRelationshipContextInput = z.infer<typeof getRelationshipContextSchema>;
export type GetDmsumInstructionsInput = z.infer<typeof getDmsumInstructionsSchema>;
export type GetDmsumHomeInput = z.infer<typeof getDmsumHomeSchema>;
export type CreateRelationshipContextInput = z.infer<typeof createRelationshipContextSchema>;
export type ListRelationshipContextsInput = z.infer<typeof listRelationshipContextsSchema>;
export type ResolveContactInput = z.infer<typeof resolveContactSchema>;
export type CommitUpdateBatchInput = z.infer<typeof commitUpdateBatchSchema>;
export type CreateReminderInput = z.infer<typeof createReminderSchema>;
export type HostedResourceSchema = z.infer<typeof hostedResourceSchema>;

export interface StaleBatchResult {
  ok: false;
  reason: "stale";
  changedPaths: string[];
}

export interface SuccessfulBatchResult {
  ok: true;
  updateId: string;
  changedPaths: [];
}

export type CommitUpdateBatchResult = StaleBatchResult | SuccessfulBatchResult;
