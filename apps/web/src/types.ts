export interface Session {
  token: string;
  user_id: string;
  tenant_id: string;
  project_id: string;
  address: `0x${string}`;
  expires_at: string;
}

export interface Project {
  id: string;
  name: string;
  created_at: string;
}

export interface Citation {
  artifact_id: string;
  irys_tx_id: string;
  cipher_sha256: string;
  chunk_locator: string;
  excerpt_sha256: string;
  gateway_ciphertext_url: string;
  capsule_version_id: string | null;
}

export interface Claim {
  text: string;
  citations: Citation[];
}

export interface ChatResponse {
  kind: 'success';
  answer_id?: string;
  answer: string;
  abstained: boolean;
  claims: Claim[];
}

export interface RecallItem {
  chunk_id: string;
  text: string;
  importance: number;
  score: number;
  source: Citation;
}

export interface RecallResponse {
  kind: 'success';
  items: RecallItem[];
  next_cursor: string | null;
}

export interface CapsuleListing {
  capsule_root_id: string;
  capsule_version_id: string;
  version: string | number;
  title: string;
  license: string;
  listing_id: string;
  price_wei: string;
  seller: `0x${string}`;
  contract_address: `0x${string}`;
  chain_id: string;
}

export interface Entitlement {
  id: string;
  capsule_version_id: string;
  state: 'active' | 'suspended';
  last_chain_check_at: string;
  access_current: boolean;
}

export interface JobStatus {
  uri: string;
  kind: 'job';
  job_id: string;
  state: 'queued' | 'running' | 'retry' | 'succeeded' | 'failed';
  artifact_state: 'staged' | 'uploading' | 'uploaded' | 'verified' | 'indexed' | 'failed' | 'quarantined';
  ready: boolean;
  sources: Citation[];
  error_code: string | null;
}

export interface ApiErrorBody {
  kind?: 'error';
  code?: string;
  message?: string;
  retryable?: boolean;
  operation_id?: string | null;
  resource_uri?: string | null;
  request_id?: string;
}

export interface DraftRecord {
  id: string;
  project_id: string;
  state: string;
  expires_at: string;
  candidate: { title: string; sanitized_text: string };
  candidate_sha256: string;
  scan: { server_scan_passed: boolean; pipeline_version: string; limitations: string[] };
}

export interface DistilledDraft {
  id: string;
  state: 'distilled';
  content: {
    schema_version: '1.0';
    title: string;
    rules: Array<{ statement: string; scope: string; confidence: number; exceptions: string[] }>;
    anti_patterns: Array<{ symptom: string; correction: string }>;
    few_shot_examples: Array<{ input: string; good_output: string; explanation: string }>;
    limitations: string[];
  };
  candidate_sha256: string;
  requires_final_approval: true;
}
