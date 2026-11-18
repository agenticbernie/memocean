import type { ChatResponse, Entitlement } from '../types';

export interface AnswerPresentation {
  abstained: boolean;
  text: string;
  claims: ChatResponse['claims'];
}

export function presentAnswer(response: ChatResponse): AnswerPresentation {
  if (response.abstained) {
    return { abstained: true, text: response.answer || 'Not enough verified evidence to answer.', claims: [] };
  }
  return { abstained: false, text: response.answer, claims: response.claims };
}

export type PurchasePresentation = 'idle' | 'pending_server_confirmation' | 'unlocked';

export function purchasePresentation(
  versionId: string,
  entitlements: Entitlement[],
  submittedTransactionHash?: string | null,
): PurchasePresentation {
  const confirmed = entitlements.some(
    (item) => item.capsule_version_id === versionId && item.state === 'active' && item.access_current === true,
  );
  if (confirmed) return 'unlocked';
  if (submittedTransactionHash) return 'pending_server_confirmation';
  return 'idle';
}

export function remainingTrialQuestions(remaining: number | null | undefined): number | null {
  if (remaining === null || remaining === undefined || !Number.isFinite(remaining)) return null;
  return Math.max(0, Math.min(3, Math.trunc(remaining)));
}

export function trialCanBeRequested(remaining: number | null | undefined): boolean {
  const count = remainingTrialQuestions(remaining);
  return count === null || count > 0;
}

export function dateBoundary(value: string, endExclusive = false): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (endExclusive) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}
