import { describe, expect, it } from 'vitest';
import { ApiError, userFacingError } from '../src/api';
import { dateBoundary, presentAnswer, purchasePresentation, remainingTrialQuestions, trialCanBeRequested } from '../src/lib/domain';
import type { ChatResponse, Entitlement } from '../src/types';

const source = {
  artifact_id: 'artifact-a',
  irys_tx_id: 'opaque-transaction-id',
  cipher_sha256: `0x${'a'.repeat(64)}`,
  chunk_locator: '/rules/0/statement',
  excerpt_sha256: `0x${'b'.repeat(64)}`,
  gateway_ciphertext_url: 'https://gateway.example/opaque-transaction-id',
  capsule_version_id: null,
};

describe('evidence presentation', () => {
  it('renders an abstention without leaking any citation chips', () => {
    const response: ChatResponse = {
      kind: 'success',
      answer: 'Not enough verified evidence to answer.',
      abstained: true,
      claims: [{ text: 'Unverified statement', citations: [source] }],
    };
    expect(presentAnswer(response)).toEqual({
      abstained: true,
      text: 'Not enough verified evidence to answer.',
      claims: [],
    });
  });

  it('preserves claim-level citations for a grounded response', () => {
    const response: ChatResponse = { kind: 'success', answer: 'Supported.', abstained: false, claims: [{ text: 'Supported.', citations: [source] }] };
    expect(presentAnswer(response).claims[0]?.citations).toEqual([source]);
  });
});

describe('purchase unlock gate', () => {
  const active: Entitlement = {
    id: 'entitlement-1',
    capsule_version_id: 'version-1',
    state: 'active',
    last_chain_check_at: '2026-11-18T00:00:00.000Z',
    access_current: true,
  };

  it('keeps access pending when only a client transaction hash exists', () => {
    expect(purchasePresentation('version-1', [], '0xsubmitted')).toBe('pending_server_confirmation');
  });

  it('does not unlock a stale or suspended backend entitlement', () => {
    expect(purchasePresentation('version-1', [{ ...active, access_current: false }], '0xsubmitted')).toBe('pending_server_confirmation');
    expect(purchasePresentation('version-1', [{ ...active, state: 'suspended' }], '0xsubmitted')).toBe('pending_server_confirmation');
  });

  it('unlocks only for the exact version with an active current backend entitlement', () => {
    expect(purchasePresentation('version-1', [{ ...active, capsule_version_id: 'another-version' }], '0xsubmitted')).toBe('pending_server_confirmation');
    expect(purchasePresentation('version-1', [active], '0xsubmitted')).toBe('unlocked');
  });
});

describe('trial quota and errors', () => {
  it('does not invent a remaining count before the server reports one', () => {
    expect(remainingTrialQuestions(undefined)).toBeNull();
    expect(trialCanBeRequested(undefined)).toBe(true);
  });

  it('disables new questions when the server reports the lifetime quota exhausted', () => {
    expect(remainingTrialQuestions(0)).toBe(0);
    expect(trialCanBeRequested(0)).toBe(false);
    expect(remainingTrialQuestions(4)).toBe(3);
  });

  it('communicates auth and unavailable-provider failures without claiming success', () => {
    expect(userFacingError(new ApiError(401, { code: 'UNAUTHENTICATED', message: 'Expired session' }))).toContain('Sign in again');
    expect(userFacingError(new ApiError(503, { code: 'INTEGRATION_UNAVAILABLE', message: 'Generation is not configured' }))).toContain('No content was stored or answered');
    expect(userFacingError(new ApiError(429, { code: 'TRIAL_EXHAUSTED' }))).toContain('three lifetime preview questions');
  });
});

describe('date filters', () => {
  it('uses an exclusive UTC boundary for the selected end date', () => {
    expect(dateBoundary('2026-11-18')).toBe('2026-11-18T00:00:00.000Z');
    expect(dateBoundary('2026-11-18', true)).toBe('2026-11-19T00:00:00.000Z');
  });
});
