import { z } from 'zod';

export const uuid = z.string().uuid();
export const hexDigest = z.string().regex(/^0x[0-9a-f]{64}$/);
export const timestamp = z.string().datetime({ offset: true });
export const challengeSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chain_id: z.number().int().positive(),
}).strict();
export const verifySchema = z.object({
  message: z.string().min(50).max(4096),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(512),
}).strict();
export const createPatSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(['memory:read', 'memory:write', 'capsule:query', 'provenance:read'])).min(1).max(4),
  project_ids: z.array(uuid).max(100).default([]),
  expires_at: timestamp.optional(),
}).strict();
export const draftSchema = z.object({
  project_id: uuid,
  title: z.string().min(1).max(160),
  sanitized_text: z.string().min(1).max(65536),
  local_scan_passed: z.literal(true),
  pii_review_passed: z.literal(true),
}).strict();
export const approveSchema = z.object({ approved_sha256: hexDigest }).strict();
export const rememberSchema = z.object({
  project_id: uuid,
  idempotency_key: uuid,
  approved_draft_id: uuid,
  approved_sha256: hexDigest,
  approval_token: z.string().min(32).max(2048),
  importance: z.number().min(0).max(1),
  valid_from: timestamp,
  valid_to: timestamp.optional(),
}).strict().refine((value) => !value.valid_to || Date.parse(value.valid_to) > Date.parse(value.valid_from), 'valid_to must be after valid_from');
export const recallSchema = z.object({
  query: z.string().min(1).max(2000),
  project_id: uuid,
  created_from: timestamp.optional(),
  created_to: timestamp.optional(),
  effective_at: timestamp.optional(),
  limit: z.number().int().min(1).max(20).default(10),
  cursor: z.string().min(1).max(2048).optional(),
}).strict().superRefine((value, context) => {
  if (value.created_from && value.created_to && (
    Date.parse(value.created_from) >= Date.parse(value.created_to)
    || Date.parse(value.created_to) - Date.parse(value.created_from) > 365 * 86_400_000
  )) {
    context.addIssue({ code: 'custom', message: 'Invalid date range; maximum is 365 days' });
  }
});
export const queryCapsuleSchema = z.object({
  capsule_root_id: uuid,
  capsule_version_id: uuid,
  project_id: uuid,
  question: z.string().min(1).max(2000),
  mode: z.enum(['trial', 'purchased']),
  idempotency_key: uuid,
}).strict();
export const provenanceSchema = z.object({
  artifact_id: uuid,
  capsule_version_id: uuid.optional(),
  refresh: z.boolean().default(false),
}).strict();
export const lessonSchema = z.object({
  schema_version: z.literal('1.0'),
  title: z.string().min(1).max(160),
  rules: z.array(z.object({
    statement: z.string().min(1).max(2000),
    scope: z.string().max(300),
    confidence: z.number().min(0).max(1),
    exceptions: z.array(z.string().max(300)).max(10),
  }).strict()).max(100),
  anti_patterns: z.array(z.object({
    symptom: z.string().min(1).max(2000),
    correction: z.string().min(1).max(2000),
  }).strict()).max(50),
  few_shot_examples: z.array(z.object({
    input: z.string().min(1).max(2000),
    good_output: z.string().min(1).max(2000),
    explanation: z.string().max(2000),
  }).strict()).max(30),
  limitations: z.array(z.string().min(1).max(2000)).min(1).max(10),
}).strict();
export const generatedAnswerSchema = z.object({
  abstained: z.boolean(),
  claims: z.array(z.object({
    text: z.string().min(1).max(2000),
    chunk_ids: z.array(uuid).min(1).max(5),
  }).strict()).max(12),
}).strict();

const evidenceIds = z.array(uuid).min(1);
export const capsuleContentSchema = z.object({
  schema_version: z.literal('1.0'),
  capsule_root_id: uuid,
  version: z.number().int().min(1).max(4_294_967_295),
  title: z.string().min(1).max(160),
  language: z.enum(['vi', 'en']),
  rules: z.array(z.object({
    id: uuid,
    statement: z.string().min(1).max(2000),
    scope: z.string().min(1).max(300),
    importance: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    evidence_ids: evidenceIds.max(10),
    exceptions: z.array(z.string().min(1).max(300)).max(10),
  }).strict()).max(100),
  anti_patterns: z.array(z.object({
    id: uuid,
    symptom: z.string().min(1).max(2000),
    why_wrong: z.string().min(1).max(2000),
    correction: z.string().min(1).max(2000),
    scope: z.string().min(1).max(300),
    evidence_ids: evidenceIds,
  }).strict()).max(100),
  few_shot_examples: z.array(z.object({
    id: uuid,
    input: z.string().min(1).max(2000),
    bad_output: z.string().min(1).max(2000),
    good_output: z.string().min(1).max(2000),
    explanation: z.string().min(1).max(2000),
    evidence_ids: evidenceIds,
  }).strict()).max(50),
  provenance: z.array(z.object({
    id: uuid,
    source_kind: z.enum(['code', 'documentation', 'experiment', 'session_lesson']),
    locator: z.string().min(1).max(300),
    observed_at: timestamp,
    source_verified: z.boolean(),
    license_or_consent: z.string().min(1).max(300),
  }).strict()).min(1).max(200),
  quality: z.object({
    reviewer_user_id: uuid,
    reviewed_at: timestamp,
    evaluation_summary: z.string().min(1).max(2000),
    known_limitations: z.array(z.string().min(1).max(2000)).min(1),
  }).strict(),
  sanitization: z.object({
    pipeline_version: z.string().min(1).max(300),
    local_scan_passed: z.literal(true),
    server_scan_passed: z.literal(true),
    pii_review_passed: z.literal(true),
    human_approved: z.literal(true),
  }).strict(),
  license: z.object({
    identifier: z.string().min(1).max(300),
    terms: z.string().min(1).max(2000),
    redistribution_allowed: z.boolean(),
  }).strict(),
}).strict();

export type ChallengeInput = z.infer<typeof challengeSchema>;
export type VerifyInput = z.infer<typeof verifySchema>;
export type CreatePatInput = z.infer<typeof createPatSchema>;
export type DraftInput = z.infer<typeof draftSchema>;
export type ApproveInput = z.infer<typeof approveSchema>;
export type RememberInput = z.infer<typeof rememberSchema>;
export type RecallInput = z.infer<typeof recallSchema>;
export type QueryCapsuleInput = z.infer<typeof queryCapsuleSchema>;
export type ProvenanceInput = z.infer<typeof provenanceSchema>;
export type Lesson = z.infer<typeof lessonSchema>;
export type GeneratedAnswer = z.infer<typeof generatedAnswerSchema>;
export type CapsuleContent = z.infer<typeof capsuleContentSchema>;
