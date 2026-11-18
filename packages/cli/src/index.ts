#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { canonicalizeJson, draftSchema, sha256Hex, uuid } from '@memocean/core';

const MAX_INPUT_BYTES = 64 * 1024;
const prohibitedPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:sk-ant-|sk-proj-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/,
  /\b(?:seed[_ -]?phrase|mnemonic)\s*[:=][^\n]{10,}/i,
  /\b(?:abandon\s+){3,}/i,
  /https?:\/\/[^\s/]*(?:\.internal|\.local)(?:[/:]|\b)/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:private[_ -]?key|api[_ -]?key|password|secret|seed[_ -]?phrase|mnemonic)\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\b(?:0x)?[a-fA-F0-9]{64}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /https?:\/\/(?:[^\s/@]+:[^\s/@]+@|localhost\b|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/i,
  /\b(?:Bearer|Authorization:)\s+[A-Za-z0-9_.-]{16,}/i,
];

export function scanSensitiveText(text: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) reasons.push('over-64-kib');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) reasons.push('control-character');
  if (prohibitedPatterns.some((pattern) => pattern.test(text))) reasons.push('possible-secret-or-pii');
  return { ok: reasons.length === 0, reasons };
}

export function buildMcpConfig(apiUrl: string): object {
  const url = parseApiUrl(apiUrl);
  return {
    mcpServers: {
      memocean: {
        type: 'http',
        url: new URL('/mcp', url).toString(),
        headers: { Authorization: 'Bearer ${MEMOCEAN_TOKEN}' },
      },
    },
  };
}

function parseApiUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error('API URL must be a valid absolute HTTPS URL (HTTP is allowed for localhost)', { cause });
  }
  const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('API URL must be an HTTPS origin (or localhost HTTP) without credentials, path, query or fragment');
  }
  return url;
}

type Options = Record<string, string>;
interface ApiErrorBody { code?: string; message?: string }

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h') return printHelp();
  const { positional, options } = parseArgs(rest);
  if (command === 'mcp-config') {
    const api = options.api ?? process.env.MEMOCEAN_API_URL;
    if (!api) throw new Error('Set MEMOCEAN_API_URL or pass --api <https://api-origin>');
    console.log(JSON.stringify(buildMcpConfig(api), null, 2));
    console.error('Config emitted only to stdout; no token or local file was written. Set MEMOCEAN_TOKEN in the MCP client environment.');
    return;
  }
  if (command === 'scan') {
    requirePositional(positional, 1, 'scan <file>');
    const text = await readLocalText(positional[0]!);
    const result = scanSensitiveText(text);
    if (!result.ok) throw new Error(`Local scan blocked this file (${result.reasons.join(', ')}). Match details are intentionally withheld; redact locally and rescan.`);
    console.log(`Local scan passed for ${positional[0]}. Pattern scanning can miss secrets and PII; inspect the text yourself before sharing.`);
    return;
  }
  if (command === 'draft') {
    requirePositional(positional, 1, 'draft <file> --project <uuid> --title <title>');
    const projectId = uuid.parse(requiredOption(options, 'project'));
    const title = requiredOption(options, 'title');
    const text = await readLocalText(positional[0]!);
    const localScan = scanSensitiveText(`${title}\n${text}`);
    if (!localScan.ok) throw new Error(`Local scan blocked this draft (${localScan.reasons.join(', ')}). Match details are intentionally withheld; redact locally and rescan.`);
    const candidate = { title, sanitized_text: text };
    const digest = sha256Hex(canonicalizeJson(candidate));
    console.log('\nExact text to stage (still no LLM call or permanent upload):');
    console.log(`Title: ${title}\n\n${text}`);
    await requireApproval(`Type "stage ${digest}" to send this scanned text to the API for encrypted staging` , `stage ${digest}`);
    const value = draftSchema.parse({ project_id: projectId, title, sanitized_text: text, local_scan_passed: true, pii_review_passed: true });
    const response = await apiRequest(options, '/v1/drafts', { method: 'POST', body: JSON.stringify(value) });
    if (response.candidate_sha256 !== digest) throw new Error('API candidate digest did not match the locally reviewed candidate; do not approve egress.');
    console.log(`Draft staged: ${response.id}\nState: ${response.state}\nDigest: ${response.candidate_sha256}\nNext: memocean approve-egress ${response.id}`);
    return;
  }
  if (command === 'approve-egress') {
    requirePositional(positional, 1, 'approve-egress <draft-id>');
    const draftId = uuid.parse(positional[0]!);
    const draft = await apiRequest(options, `/v1/drafts/${draftId}`);
    const content = asRecord(draft.content);
    const title = requireString(content.title, 'draft title');
    const text = requireString(content.sanitized_text, 'draft text');
    const scan = scanSensitiveText(`${title}\n${text}`);
    if (!scan.ok) throw new Error(`Local scan blocked this draft (${scan.reasons.join(', ')}); no egress approval was sent.`);
    const digest = sha256Hex(canonicalizeJson({ title, sanitized_text: text }));
    if (draft.candidate_sha256 !== digest) throw new Error('Stored draft digest does not match the reviewed text; no egress approval was sent.');
    console.log(`Exact candidate that would be sent to the configured model:\nTitle: ${title}\n\n${text}`);
    await requireApproval(`Type "egress ${digest}" to approve external model egress for this exact text`, `egress ${digest}`);
    const result = await apiRequest(options, `/v1/drafts/${draftId}/egress-approve`, { method: 'POST', body: JSON.stringify({ approved_sha256: digest }) });
    if (result.external_call_made !== false) throw new Error('Unexpected API response; verify draft state before continuing.');
    console.log(`Egress approval recorded for digest ${digest}. No model call was made. Run "memocean distill ${draftId}" only when you want to send it to the configured model.`);
    return;
  }
  if (command === 'distill') {
    requirePositional(positional, 1, 'distill <draft-id>');
    const draftId = uuid.parse(positional[0]!);
    const draft = await apiRequest(options, `/v1/drafts/${draftId}`);
    if (draft.state !== 'egress_approved') throw new Error('Draft is not egress-approved; run approve-egress and review the exact digest first.');
    const content = asRecord(draft.content);
    const title = requireString(content.title, 'draft title');
    const text = requireString(content.sanitized_text, 'draft text');
    const scan = scanSensitiveText(`${title}\n${text}`);
    if (!scan.ok) throw new Error(`Local scan blocked this draft (${scan.reasons.join(', ')}); no model call was made.`);
    const digest = sha256Hex(canonicalizeJson({ title, sanitized_text: text }));
    if (draft.candidate_sha256 !== digest) throw new Error('Stored draft digest mismatch; no model call was made.');
    console.log(`The API will send this exact approved candidate to its configured model:\nTitle: ${title}\n\n${text}`);
    await requireApproval(`Type "distill ${digest}" to make the model call`, `distill ${digest}`);
    const result = await apiRequest(options, `/v1/drafts/${draftId}/distill`, { method: 'POST', body: '{}' });
    console.log(`Distilled draft ${draftId}, digest ${result.candidate_sha256}. Review the exact output before permanent upload approval:`);
    console.log(JSON.stringify(result.content, null, 2));
    console.log(`Next: memocean remember ${draftId} --project ${requireString(draft.project_id, 'project id')}`);
    return;
  }
  if (command === 'remember') {
    requirePositional(positional, 1, 'remember <draft-id> --project <uuid> [--importance 0.5]');
    const draftId = uuid.parse(positional[0]!);
    const projectId = uuid.parse(requiredOption(options, 'project'));
    const importance = options.importance === undefined ? 0.5 : Number(options.importance);
    if (!Number.isFinite(importance) || importance < 0 || importance > 1) throw new Error('--importance must be a number between 0 and 1');
    const draft = await apiRequest(options, `/v1/drafts/${draftId}`);
    if (draft.state !== 'distilled' && draft.state !== 'approved') throw new Error('Draft must be distilled before final review and upload approval.');
    if (draft.project_id !== projectId) throw new Error("Project must match the project's approved draft.");
    const digest = requireString(draft.candidate_sha256, 'candidate digest');
    const canonicalLesson = canonicalizeJson(draft.content as never);
    const computedDigest = sha256Hex(canonicalLesson);
    if (computedDigest !== digest) throw new Error('Stored lesson digest did not match its exact contents; no upload approval was sent.');
    const scan = scanSensitiveText(canonicalLesson);
    if (!scan.ok) throw new Error(`Local scan blocked this distilled content (${scan.reasons.join(', ')}); no upload approval was sent.`);
    console.log('Exact distilled content to be approved for encrypted storage and an upload job:');
    console.log(JSON.stringify(draft.content, null, 2));
    await requireApproval(`Type "upload ${digest}" to approve this exact content for the storage workflow`, `upload ${digest}`);
    const approval = await apiRequest(options, `/v1/drafts/${draftId}/approve`, { method: 'POST', body: JSON.stringify({ approved_sha256: digest }) });
    const token = requireString(approval.approval_token, 'approval token');
    const now = new Date().toISOString();
    const remember = await apiRequest(options, '/v1/remember', {
      method: 'POST',
      body: JSON.stringify({
        project_id: projectId,
        idempotency_key: draftId,
        approved_draft_id: draftId,
        approved_sha256: digest,
        approval_token: token,
        importance,
        valid_from: now,
      }),
    });
    console.log(`Upload job accepted: ${remember.job_id ?? remember.id ?? 'see API response'}; state=${remember.state ?? 'queued'}; ready=${remember.ready ?? false}. Accepted is not evidence of Irys permanence.`);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
}

async function readLocalText(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error('Input exceeds 64 KiB; select a smaller excerpt locally.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error('Input must be valid UTF-8 text', { cause });
  }
  return text;
}

async function apiRequest(options: Options, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const api = options.api ?? process.env.MEMOCEAN_API_URL;
  if (!api) throw new Error('Set MEMOCEAN_API_URL or pass --api <https://api-origin>');
  const token = process.env.MEMOCEAN_TOKEN;
  if (!token) throw new Error('Set MEMOCEAN_TOKEN in the process environment; the CLI never stores it or accepts it as a command argument.');
  const url = new URL(path, parseApiUrl(api));
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body) headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(url, {
      ...init,
      method: init.method ?? 'GET',
      headers,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  const raw = await response.text();
  let body: unknown;
  try { body = raw ? JSON.parse(raw) as unknown : {}; } catch { throw new Error(`API returned a non-JSON response (HTTP ${response.status}); response body withheld.`); }
  if (!response.ok) {
    const error = isRecord(body) ? body as ApiErrorBody : {};
    throw new Error(`API rejected the request (HTTP ${response.status}${error.code ? `, ${error.code}` : ''}): ${error.message ?? 'safe error detail unavailable'}`);
  }
  if (!isRecord(body)) throw new Error('API response was not a JSON object; response body withheld.');
  return body;
}

async function requireApproval(prompt: string, expected: string): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive human review is required; rerun from a terminal. No request was sent.');
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(`\n${prompt}\n> `);
    if (answer !== expected) throw new Error('Approval did not match; no next step was taken.');
  } finally {
    readline.close();
  }
}

function parseArgs(args: string[]): { positional: string[]; options: Options } {
  const positional: string[] = [];
  const options: Options = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!;
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const name = item.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option --${name} requires a value`);
    if (!new Set(['api', 'project', 'title', 'importance']).has(name)) throw new Error(`Unknown option: --${name}`);
    options[name] = value;
    index += 1;
  }
  return { positional, options };
}

function requiredOption(options: Options, name: string): string {
  const value = options[name];
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function requirePositional(values: string[], count: number, usage: string): void {
  if (values.length !== count) throw new Error(`Usage: memocean ${usage}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`API response is missing ${label}; response body withheld.`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('API response has an unexpected content shape; response body withheld.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const helpText = () => `Commands:\n  memocean scan <file>\n  memocean draft <file> --project <uuid> --title <title>\n  memocean approve-egress <draft-id>\n  memocean distill <draft-id>\n  memocean remember <draft-id> --project <uuid> [--importance 0.5]\n  memocean mcp-config [--api <https://api-origin>]\n\nAPI credentials are read only from MEMOCEAN_TOKEN; no token/config is persisted. Scans are conservative pattern checks, not privacy certification.`;

function printHelp(): void { console.log(helpText()); }

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'CLI operation failed');
    process.exitCode = 1;
  });
}
