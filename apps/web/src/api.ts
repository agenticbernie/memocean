import type { ApiErrorBody } from './types';

const configuredApi = import.meta.env.VITE_API_URL?.trim();
export const API_BASE_URL = configuredApi ? configuredApi.replace(/\/$/, '') : import.meta.env.DEV ? 'http://localhost:3000' : '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly operationId: string | null;
  readonly resourceUri: string | null;
  readonly requestId: string | null;

  constructor(status: number, body: ApiErrorBody = {}) {
    super(body.message ?? (status ? `The service returned ${status}.` : 'The API could not be reached.'));
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code ?? 'UPSTREAM_UNAVAILABLE';
    this.retryable = body.retryable ?? status >= 500;
    this.operationId = body.operation_id ?? null;
    this.resourceUri = body.resource_uri ?? null;
    this.requestId = body.request_id ?? null;
  }
}

export interface ApiOptions {
  token?: string | null;
  body?: unknown;
  signal?: AbortSignal;
  method?: 'GET' | 'POST' | 'DELETE';
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  if (!API_BASE_URL) throw new ApiError(0, { code: 'API_NOT_CONFIGURED', message: 'The API URL is not configured for this deployment.' });
  const headers = new Headers({ Accept: 'application/json' });
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, { code: 'UPSTREAM_UNAVAILABLE', message: 'The API could not be reached. Your work has not been reported as saved.' });
  }
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, isApiError(payload) ? payload : {});
  return payload as T;
}

function isApiError(value: unknown): value is ApiErrorBody {
  return Boolean(value && typeof value === 'object');
}

export function userFacingError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'INTEGRATION_UNAVAILABLE') return `${error.message} No content was stored or answered.`;
    if (error.code === 'TRIAL_EXHAUSTED') return 'The three lifetime preview questions for this capsule root have been used.';
    if (error.code === 'UNAUTHENTICATED' || error.status === 401) return 'Your wallet session expired or was revoked. Sign in again to continue.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong. No success has been assumed.';
}
