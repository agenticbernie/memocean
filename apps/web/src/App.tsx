import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode } from 'react';
import {
  Anchor, ArrowDownRight, ArrowRight, BookOpen, Check, CheckCircle2, ChevronDown, CircleHelp,
  Clock3, Compass, ExternalLink, FileCheck2, FileText, Fingerprint, Fish, Globe2, Layers3,
  LoaderCircle, LockKeyhole, LogOut, MessageCircle, Search, ShieldCheck, Sparkles, Wallet, Waves,
  KeyRound, XCircle,
} from 'lucide-react';
import { useAccount, useConnect, usePublicClient, useSignMessage, useSwitchChain, useWriteContract } from 'wagmi';
import { TransactionReceiptNotFoundError } from 'viem';
import { api, API_BASE_URL, ApiError, userFacingError } from './api';
import { DeveloperConsole } from './DeveloperConsole';
import { dateBoundary, presentAnswer, purchasePresentation, remainingTrialQuestions, trialCanBeRequested } from './lib/domain';
import { FUJI_CHAIN_ID, marketplaceAbi, marketplaceAbiAvailable, marketplaceAddress, marketplaceChainId } from './wallet';
import type {
  CapsuleListing, ChatResponse, Citation, DistilledDraft, DraftRecord, Entitlement,
  JobStatus, Project, RecallItem, RecallResponse, Session,
} from './types';

type View = 'library' | 'distill' | 'ask' | 'capsules' | 'developer';
type HealthInfo = {
  status: 'ready' | 'not_ready';
  database?: boolean;
  missing_config?: string[];
  integrations?: { generation?: string; embeddings?: string; permanent_storage?: string; oauth?: string };
};
type CapsuleQueryResult = {
  kind: 'success';
  capsule_version_id: string;
  mode: 'trial' | 'purchased';
  answer: string;
  abstained: boolean;
  claims: ChatResponse['claims'];
  trials_remaining: number | null;
  quota_state: string;
};
type RecallMessage = { role: 'user'; text: string } | { role: 'assistant'; response: ChatResponse };

type Notice = { tone: 'error' | 'success' | 'info'; text: string };

const FUJI_CHAIN_ID_TEXT = String(FUJI_CHAIN_ID);

const viewInfo: Record<View, { label: string; title: string; description: string }> = {
  library: { label: 'Library', title: 'Your project memory', description: 'Rules and lessons, kept close to the work.' },
  distill: { label: 'Distill', title: 'Make the useful parts last', description: 'Review what leaves your machine and what becomes memory.' },
  ask: { label: 'Ask', title: 'Ask with receipts', description: 'Answers stay close to verified project evidence.' },
  capsules: { label: 'Capsules', title: 'A library, not a feed', description: 'Explore version-pinned knowledge with clear boundaries.' },
  developer: { label: 'Developer', title: 'Developer Console', description: 'Create scoped access, configure the controlled MCP pilot, and manage project context.' },
};

function short(value: string, lead = 7, trail = 5): string {
  if (value.length <= lead + trail + 3) return value;
  return `${value.slice(0, lead)}…${value.slice(-trail)}`;
}

function capsulePrice(wei: string): string {
  try {
    const value = BigInt(wei);
    const whole = value / 10n ** 18n;
    const fraction = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 5).replace(/0+$/, '');
    return `${whole.toString()}${fraction ? `.${fraction}` : ''}`;
  } catch {
    return '—';
  }
}

function ErrorNotice({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
  const Icon = notice.tone === 'success' ? CheckCircle2 : notice.tone === 'error' ? XCircle : CircleHelp;
  return (
    <div className={`alert ${notice.tone === 'error' ? 'error' : notice.tone === 'success' ? 'success' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <Icon size={15} aria-hidden="true" />
      <span>{notice.text}</span>
      {onDismiss && <button className="ml-auto rounded p-1 text-current" onClick={onDismiss} aria-label="Dismiss message"><XCircle size={14} /></button>}
    </div>
  );
}

function BusyButton({ children, busy, ...props }: { children: ReactNode; busy?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} disabled={props.disabled || busy}>
      {busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

function SourceChip({ source, index }: { source: Citation; index?: number }) {
  const label = index === undefined ? 'Verified source' : `Evidence ${index + 1}`;
  return (
    <a className="source-chip" href={source.gateway_ciphertext_url} target="_blank" rel="noreferrer noopener" title={`Ciphertext transaction ${source.irys_tx_id}`}>
      <ShieldCheck size={12} aria-hidden="true" />
      <span>{label} · {short(source.irys_tx_id, 6, 4)}</span>
      <ExternalLink size={10} aria-hidden="true" />
    </a>
  );
}

function AnswerBlock({ response }: { response: ChatResponse }) {
  const presentation = presentAnswer(response);
  if (presentation.abstained) {
    return (
      <div className="message answer">
        <div className="message-label"><CircleHelp size={12} /> Evidence check</div>
        <p>{presentation.text}</p>
        <div className="source-row"><span className="pill pill-warning">No verified evidence</span><span className="field-help">No citations were attached to this answer.</span></div>
      </div>
    );
  }
  return (
    <div className="message answer">
      <div className="message-label"><Sparkles size={12} /> Grounded response</div>
      {presentation.claims.map((claim, claimIndex) => (
        <div key={`${claimIndex}-${claim.text.slice(0, 24)}`} className="mb-3 last:mb-0">
          <p>{claim.text}</p>
          <div className="source-row">
            {claim.citations.map((source, index) => <SourceChip key={`${source.artifact_id}-${source.chunk_locator}-${index}`} source={source} index={index} />)}
          </div>
        </div>
      ))}
      <div className="field-help mt-3">Links open ciphertext. A public gateway link does not reveal private plaintext or prove the claim is true.</div>
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>('library');
  const [session, setSession] = useState<Session | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [capsules, setCapsules] = useState<CapsuleListing[]>([]);
  const [capsulesLoading, setCapsulesLoading] = useState(true);
  const [capsulesError, setCapsulesError] = useState('');
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [entitlementsError, setEntitlementsError] = useState('');
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthState, setHealthState] = useState<'checking' | 'reachable' | 'unreachable' | 'unconfigured'>('checking');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState('');
  const [authMenuOpen, setAuthMenuOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectCreateBusy, setProjectCreateBusy] = useState(false);
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [synced, setSynced] = useState<Record<string, boolean>>({});
  const [submittedPurchases, setSubmittedPurchases] = useState<Record<string, string>>({});
  const capsuleQuestionKeys = useRef(new Map<string, string>());
  const capsuleQuestionLatest = useRef(new Map<string, number>());
  const capsuleQuestionSequence = useRef(0);
  const sessionGeneration = useRef(0);
  const [queryResults, setQueryResults] = useState<Record<string, CapsuleQueryResult>>({});
  const [trialRemainingByRoot, setTrialRemainingByRoot] = useState<Record<string, number>>({});
  const [exhaustedTrialRoots, setExhaustedTrialRoots] = useState<Record<string, boolean>>({});
  const [pendingPurchasePoll, setPendingPurchasePoll] = useState(0);

  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending: connecting, error: connectError } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const primaryConnector = connectors[0];
  const walletMatchesSession = Boolean(session && isConnected && address && address.toLowerCase() === session.address.toLowerCase());
  const activeSession = walletMatchesSession ? session : null;
  const userScope = activeSession?.address.toLowerCase() ?? 'signed-out';
  const activeProject = projects.find((item) => item.id === selectedProject) ?? null;
  const page = viewInfo[view];

  const resetSessionState = useCallback(() => {
    sessionGeneration.current += 1;
    capsuleQuestionKeys.current.clear();
    capsuleQuestionLatest.current.clear();
    setProjects([]);
    setSelectedProject('');
    setProjectLoading(false);
    setProjectError('');
    setEntitlements([]);
    setEntitlementsError('');
    setQueryResults({});
    setTrialRemainingByRoot({});
    setExhaustedTrialRoots({});
    setSubmittedPurchases({});
    setPendingPurchasePoll(0);
    setSyncing({});
    setSynced({});
    setCreatingProject(false);
    setProjectName('');
    setProjectCreateBusy(false);
  }, []);

  const refreshEntitlements = useCallback(async (token: string, generation = sessionGeneration.current) => {
    try {
      const result = await api<{ items: Entitlement[] }>('/v1/entitlements', { token });
      if (generation !== sessionGeneration.current) return null;
      setEntitlements(result.items);
      setEntitlementsError('');
      return result.items;
    } catch (error) {
      if (generation !== sessionGeneration.current) return null;
      setEntitlementsError(userFacingError(error));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!API_BASE_URL) {
      setHealthState('unconfigured');
      return;
    }
    let active = true;
    const check = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/healthz`, { cache: 'no-store', credentials: 'omit' });
        const payload: HealthInfo = await response.json();
        if (active) {
          setHealth(payload);
          setHealthState('reachable');
        }
      } catch {
        if (active) setHealthState('unreachable');
      }
    };
    void check();
    const interval = window.setInterval(check, 45_000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    let active = true;
    setCapsulesLoading(true);
    void api<{ items: CapsuleListing[] }>('/v1/capsules')
      .then((result) => { if (active) { setCapsules(result.items); setCapsulesError(''); } })
      .catch((error) => { if (active) setCapsulesError(userFacingError(error)); })
      .finally(() => { if (active) setCapsulesLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!activeSession) return;
    const generation = sessionGeneration.current;
    const controller = new AbortController();
    setProjectLoading(true);
    setProjectError('');
    void api<{ items: Project[] }>('/v1/projects', { token: activeSession.token, signal: controller.signal })
      .then((result) => {
        if (generation !== sessionGeneration.current) return;
        setProjects(result.items);
        setSelectedProject((current) => result.items.some((item) => item.id === current) ? current : result.items.find((item) => item.id === activeSession.project_id)?.id ?? result.items[0]?.id ?? '');
      })
      .catch((error) => {
        if (generation !== sessionGeneration.current || (error instanceof DOMException && error.name === 'AbortError')) return;
        setProjectError(userFacingError(error));
      })
      .finally(() => { if (generation === sessionGeneration.current && !controller.signal.aborted) setProjectLoading(false); });
    void refreshEntitlements(activeSession.token, generation);
    return () => controller.abort();
  }, [activeSession, refreshEntitlements]);

  useLayoutEffect(() => {
    if (session && !walletMatchesSession) {
      resetSessionState();
      setSession(null);
      setNotice({ tone: 'info', text: 'Wallet account changed. The previous in-memory session was cleared; sign in again with the verified wallet.' });
    }
  }, [resetSessionState, session, walletMatchesSession]);

  useEffect(() => {
    const ids = Object.entries(submittedPurchases).filter(([versionId]) => !entitlements.some((item) => item.capsule_version_id === versionId && item.state === 'active' && item.access_current));
    if (!activeSession || !ids.length || pendingPurchasePoll >= 24) return;
    const generation = sessionGeneration.current;
    const timer = window.setTimeout(() => {
      void refreshEntitlements(activeSession.token, generation).finally(() => {
        if (generation === sessionGeneration.current) setPendingPurchasePoll((count) => count + 1);
      });
    }, pendingPurchasePoll ? 5000 : 1500);
    return () => window.clearTimeout(timer);
  }, [activeSession, submittedPurchases, entitlements, pendingPurchasePoll, refreshEntitlements]);

  async function handleConnect(connectorId?: string) {
    setSignInError('');
    const connector = connectors.find((item) => item.id === connectorId) ?? primaryConnector;
    if (!connector) {
      setSignInError('No wallet connector is available in this browser.');
      return;
    }
    try {
      await connect({ connector });
      setAuthMenuOpen(false);
    } catch (error) {
      setSignInError(userFacingError(error));
    }
  }

  async function handleSignIn() {
    if (!address) return;
    setSigningIn(true);
    setSignInError('');
    try {
      if (chainId !== FUJI_CHAIN_ID) await switchChainAsync({ chainId: FUJI_CHAIN_ID });
      const challenge = await api<{ message: string; expires_at: string }>('/v1/auth/challenge', { body: { address, chain_id: FUJI_CHAIN_ID } });
      const signature = await signMessageAsync({ message: challenge.message });
      const verified = await api<{ token: string; token_type: 'Bearer'; user_id: string; tenant_id: string; project_id: string; expires_at: string }>('/v1/auth/verify', {
        body: { message: challenge.message, signature },
      });
      sessionGeneration.current += 1;
      setSession({ token: verified.token, user_id: verified.user_id, tenant_id: verified.tenant_id, project_id: verified.project_id, address, expires_at: verified.expires_at });
      setNotice({ tone: 'success', text: `Signed in as ${short(address)}. Session token is held in memory only and expires at ${new Date(verified.expires_at).toLocaleTimeString()}.` });
    } catch (error) {
      setSignInError(userFacingError(error));
    } finally {
      setSigningIn(false);
    }
  }

  async function handleSignOut() {
    const token = session?.token;
    resetSessionState();
    setSession(null);
    setNotice({ tone: 'info', text: 'The in-memory wallet session was cleared.' });
    if (token) await api<void>('/v1/auth/session', { token, method: 'DELETE' }).catch(() => undefined);
  }

  async function createProjectWithName(name: string): Promise<boolean> {
    if (!session || !name.trim()) return false;
    const generation = sessionGeneration.current;
    setProjectCreateBusy(true);
    setProjectError('');
    try {
      const created = await api<Project>('/v1/projects', { token: session.token, body: { name: name.trim() } });
      if (generation !== sessionGeneration.current) return false;
      setProjects((current) => [...current, created]);
      setSelectedProject(created.id);
      return true;
    } catch (error) {
      if (generation === sessionGeneration.current) setProjectError(userFacingError(error));
      return false;
    } finally {
      if (generation === sessionGeneration.current) setProjectCreateBusy(false);
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await createProjectWithName(projectName)) {
      setCreatingProject(false);
      setProjectName('');
    }
  }

  async function syncCapsule(versionId: string) {
    if (!session || !selectedProject) return;
    const generation = sessionGeneration.current;
    setSyncing((current) => ({ ...current, [versionId]: true }));
    setNotice(null);
    try {
      const result = await api<{ capsule_version_id: string; project_id: string; synced: boolean; resource_uri: string }>(`/v1/capsules/${versionId}/sync`, {
        token: session.token,
        body: { project_id: selectedProject },
      });
      if (generation !== sessionGeneration.current) return;
      setSynced((current) => ({ ...current, [versionId]: result.synced }));
      setNotice({ tone: 'success', text: `The server synced version ${versionId.slice(0, 8)} to ${activeProject?.name ?? 'the selected project'}. Access remains tied to your wallet and this exact version.` });
      await refreshEntitlements(session.token, generation);
    } catch (error) {
      if (generation !== sessionGeneration.current) return;
      setNotice({ tone: 'error', text: userFacingError(error) });
    } finally {
      if (generation === sessionGeneration.current) setSyncing((current) => ({ ...current, [versionId]: false }));
    }
  }

  async function submitCapsuleQuestion(item: CapsuleListing, question: string, mode: 'trial' | 'purchased') {
    if (!session || !selectedProject || !question.trim()) return;
    const generation = sessionGeneration.current;
    const requestSequence = ++capsuleQuestionSequence.current;
    capsuleQuestionLatest.current.set(item.capsule_version_id, requestSequence);
    const normalizedQuestion = question.trim();
    const requestKey = JSON.stringify([session.user_id, mode, item.capsule_version_id, selectedProject, normalizedQuestion]);
    const idempotencyKey = capsuleQuestionKeys.current.get(requestKey) ?? crypto.randomUUID();
    capsuleQuestionKeys.current.set(requestKey, idempotencyKey);
    setQueryResults((current) => { const next = { ...current }; delete next[item.capsule_version_id]; return next; });
    setNotice(null);
    try {
      const result = await api<CapsuleQueryResult>('/v1/capsules/query', {
        token: session.token,
        body: {
          capsule_root_id: item.capsule_root_id,
          capsule_version_id: item.capsule_version_id,
          project_id: selectedProject,
          question: normalizedQuestion,
          mode,
          idempotency_key: idempotencyKey,
        },
      });
      if (generation !== sessionGeneration.current || capsuleQuestionLatest.current.get(item.capsule_version_id) !== requestSequence) return;
      capsuleQuestionKeys.current.delete(requestKey);
      setQueryResults((current) => ({ ...current, [item.capsule_version_id]: result }));
      if (mode === 'trial' && result.trials_remaining !== null) {
        setTrialRemainingByRoot((current) => ({ ...current, [item.capsule_root_id]: result.trials_remaining! }));
      }
    } catch (error) {
      if (generation !== sessionGeneration.current || capsuleQuestionLatest.current.get(item.capsule_version_id) !== requestSequence) return;
      if (!(error instanceof ApiError && (error.status === 0 || error.retryable || error.code === 'NOT_READY'))) {
        capsuleQuestionKeys.current.delete(requestKey);
      }
      if (mode === 'trial' && error instanceof ApiError && error.code === 'TRIAL_EXHAUSTED') {
        setTrialRemainingByRoot((current) => ({ ...current, [item.capsule_root_id]: 0 }));
        setExhaustedTrialRoots((current) => ({ ...current, [item.capsule_root_id]: true }));
      }
      setNotice({ tone: 'error', text: userFacingError(error) });
    } finally {
      if (capsuleQuestionLatest.current.get(item.capsule_version_id) === requestSequence) {
        capsuleQuestionLatest.current.delete(item.capsule_version_id);
      }
    }
  }

  const navItems = useMemo(() => [
    { id: 'library' as const, icon: BookOpen },
    { id: 'distill' as const, icon: Sparkles },
    { id: 'ask' as const, icon: MessageCircle },
    { id: 'capsules' as const, icon: Layers3 },
    { id: 'developer' as const, icon: KeyRound },
  ], []);

  const chainReady = marketplaceChainId === FUJI_CHAIN_ID;
  const purchaseConfigReady = marketplaceAbiAvailable && Boolean(marketplaceAddress) && chainReady;

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <div className="brand-mark"><Waves size={19} strokeWidth={2.5} aria-hidden="true" /></div>
          <div><div className="brand-name">MemOcean</div><div className="brand-tag">Memory, made useful</div></div>
        </div>
        <div className="nav-label">Workspace</div>
        <nav className="nav-list">
          {navItems.map(({ id, icon: Icon }) => (
            <button className={`nav-item ${view === id ? 'active' : ''}`} key={id} onClick={() => { setView(id); setNotice(null); }} aria-current={view === id ? 'page' : undefined}>
              <Icon size={16} aria-hidden="true" /><span>{viewInfo[id].label}</span>
              {id === 'capsules' && <span className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-[9px]">Fuji</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-note">
          <div className="sidebar-note-title"><LockKeyhole size={14} />Private by default</div>
          <p>Nothing leaves your browser for distillation until you review the exact sanitized text.</p>
        </div>
        <div className="sidebar-foot"><span className={`status-dot ${healthState === 'reachable' && health?.status === 'ready' ? '' : 'warn'}`} /><span>{healthState === 'reachable' ? `API · ${health?.status === 'ready' ? 'ready' : 'limited'}` : healthState === 'checking' ? 'Checking API…' : 'API not connected'}</span></div>
      </aside>

      <div className="main-wrap">
        <header className="topbar">
          <div className="topbar-copy">
            <div className="eyebrow">MemOcean / {page.label}</div>
            <h1 className="page-title">{page.title}</h1>
          </div>
          <div className="top-actions">
            <div className="network-chip"><span className="status-dot" /><span>Avalanche Fuji · 43113</span></div>
            {activeSession ? (
              <div className="flex items-center gap-2">
                <span className="hidden text-[10px] text-[#6a8380] sm:inline">{short(activeSession.address)}</span>
                <button className="button button-secondary button-small" onClick={() => void handleSignOut()}><LogOut size={13} /><span className="button-text">Sign out</span></button>
              </div>
            ) : isConnected && address ? (
              <BusyButton className="button button-primary button-small" onClick={() => void handleSignIn()} busy={signingIn}>
                <Fingerprint size={14} /><span className="button-text">{chainId === FUJI_CHAIN_ID ? 'Sign in' : 'Switch to Fuji'}</span>
              </BusyButton>
            ) : (
              <div className="relative">
                <button className="button button-primary button-small" onClick={() => setAuthMenuOpen((open) => !open)} aria-expanded={authMenuOpen}>
                  <Wallet size={14} /><span className="button-text">Connect wallet</span><ChevronDown size={12} />
                </button>
                {authMenuOpen && <div className="absolute right-0 top-11 z-30 min-w-48 rounded-xl border border-[#dce7e1] bg-white p-2 shadow-xl">
                  {connectors.map((connector) => <button key={connector.uid} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-[#385b5a] hover:bg-[#f1f7f0]" disabled={connecting} onClick={() => void handleConnect(connector.id)}><Wallet size={13} />{connector.name}</button>)}
                  {connectors.length === 0 && <p className="px-3 py-2 text-xs text-[#718583]">No wallet connector available.</p>}
                  <p className="px-3 pb-2 pt-1 text-[9px] leading-relaxed text-[#899894]">A wallet signature proves your address. It does not approve a purchase.</p>
                </div>}
              </div>
            )}
          </div>
        </header>

        <main className="page-content" key={userScope}>
          <ApiStatus health={health} state={healthState} />
          {notice && <div className="mb-4"><ErrorNotice notice={notice} onDismiss={() => setNotice(null)} /></div>}
          {connectError && !signInError && <div className="mb-4"><ErrorNotice notice={{ tone: 'error', text: userFacingError(connectError) }} /></div>}
          {signInError && <div className="mb-4"><ErrorNotice notice={{ tone: 'error', text: signInError }} onDismiss={() => setSignInError('')} /></div>}
          {projectError && <div className="mb-4"><ErrorNotice notice={{ tone: 'error', text: projectError }} onDismiss={() => setProjectError('')} /></div>}

          {!activeSession && (
            <section className="hero-grid" aria-label="Getting started">
              <div className="hero-card">
                <div className="hero-kicker"><Anchor size={14} /> A quieter place for hard-won lessons</div>
                <h2 className="hero-title">Keep what made the work better.</h2>
                <p className="hero-copy">Build a private memory from reviewed lessons, ask questions against cited evidence, and keep your own project context yours.</p>
                <div className="hero-actions">
                  {isConnected && address ? <button className="button button-primary" onClick={() => void handleSignIn()} disabled={signingIn}><Fingerprint size={14} />Sign in with wallet</button> : <button className="button button-primary" onClick={() => setAuthMenuOpen(true)}><Wallet size={14} />Connect wallet</button>}
                  <button className="button button-secondary" onClick={() => setView('capsules')}><Compass size={14} />Explore capsules</button>
                </div>
              </div>
              <div className="side-callout">
                <div>
                  <div className="callout-icon"><ShieldCheck size={19} /></div>
                  <h2>Human approval at both doors.</h2>
                  <p>Review the sanitized text before model egress, then approve the final digest before anything is staged for storage.</p>
                </div>
                <button className="link-button" onClick={() => setView('distill')}>See the review flow <ArrowRight size={13} /></button>
              </div>
            </section>
          )}

          <div className="section-heading">
            <div><h2>{page.label}</h2><p>{page.description}</p></div>
            {activeSession && <ProjectPicker projects={projects} value={selectedProject} busy={projectLoading} onChange={setSelectedProject} onCreate={() => setCreatingProject((value) => !value)} />}
          </div>
          {creatingProject && activeSession && <div className="card card-pad mb-4">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void createProject(event)}>
              <div className="field min-w-[220px] flex-1"><label htmlFor="new-project">New project name</label><input id="new-project" className="input" value={projectName} maxLength={120} onChange={(event) => setProjectName(event.target.value)} required /></div>
              <BusyButton className="button button-primary" type="submit" busy={projectCreateBusy}>Create project</BusyButton>
              <button className="button button-secondary" type="button" onClick={() => setCreatingProject(false)}>Cancel</button>
            </form>
          </div>}

          {view === 'library' && <LibraryPage session={activeSession} projectId={selectedProject} />}
          {view === 'distill' && <DistillPage session={activeSession} projectId={selectedProject} />}
          {view === 'ask' && <AskPage session={activeSession} projectId={selectedProject} />}
          {view === 'capsules' && <CapsulesPage
            session={activeSession}
            sessionGeneration={sessionGeneration}
            projectId={selectedProject}
            projectName={activeProject?.name ?? ''}
            capsules={capsules}
            loading={capsulesLoading}
            error={capsulesError}
            entitlements={entitlements}
            entitlementsError={entitlementsError}
            onRefreshEntitlements={() => {
              if (activeSession) {
                const generation = sessionGeneration.current;
                setPendingPurchasePoll(0);
                void refreshEntitlements(activeSession.token, generation);
              }
            }}
            onSync={syncCapsule}
            syncing={syncing}
            synced={synced}
            onQuery={submitCapsuleQuestion}
            queryResults={queryResults}
            trialRemainingByRoot={trialRemainingByRoot}
            exhaustedTrialRoots={exhaustedTrialRoots}
            purchaseConfigReady={purchaseConfigReady}
            submittedPurchases={submittedPurchases}
            onPendingTransaction={(versionId, hash) => { setSubmittedPurchases((current) => ({ ...current, [versionId]: hash })); setPendingPurchasePoll(0); }}
            onClearPendingTransaction={(versionId, hash) => {
              setSubmittedPurchases((current) => {
                if (current[versionId] !== hash) return current;
                const next = { ...current };
                delete next[versionId];
                return next;
              });
            }}
          />}
          {view === 'developer' && <DeveloperConsole
            session={activeSession}
            projects={projects}
            selectedProjectId={selectedProject}
            projectsLoading={projectLoading}
            onSelectProject={setSelectedProject}
            onCreateProject={createProjectWithName}
          />}

          {health?.integrations && <p className="footer-note">Generation: {humanIntegration(health.integrations.generation)} · Embeddings: {humanIntegration(health.integrations.embeddings)} · Permanent storage: {humanStorage(health.integrations.permanent_storage)}. “Configured” is not a live-service verification.</p>}
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.map(({ id, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? 'active' : ''}`} onClick={() => { setView(id); setNotice(null); }} aria-current={view === id ? 'page' : undefined}><Icon size={16} aria-hidden="true" /><span>{viewInfo[id].label}</span></button>)}
      </nav>
    </div>
  );
}

function humanIntegration(value?: string): string {
  if (!value) return 'not reported';
  if (value === 'configured_not_live_verified') return 'configured · not live-verified';
  if (value === 'unavailable') return 'not configured';
  return value.replaceAll('_', ' ');
}

function humanStorage(value?: string): string {
  if (value === 'blocked_supported_verifier_required') return 'blocked · supported verifier required';
  if (value === 'adapter_configured') return 'adapter configured';
  return humanIntegration(value);
}

function ApiStatus({ health, state }: { health: HealthInfo | null; state: 'checking' | 'reachable' | 'unreachable' | 'unconfigured' }) {
  if (state === 'checking') return <div className="api-banner"><LoaderCircle className="spin" size={14} />Checking API readiness. No backend state is assumed.</div>;
  if (state === 'unconfigured') return <div className="api-banner error"><CircleHelp size={14} /><span><strong>API URL is not configured.</strong> Set VITE_API_URL for this deployment. Live library, chat, login, and marketplace data are unavailable here.</span></div>;
  if (state === 'unreachable') return <div className="api-banner error"><XCircle size={14} /><span><strong>API is unreachable.</strong> Connect the configured backend before expecting saved data, answers, or entitlements.</span></div>;
  if (health?.status !== 'ready') {
    const missing = health?.missing_config?.length ? ` Missing readiness settings: ${health.missing_config.join(', ')}.` : '';
    return <div className="api-banner"><CircleHelp size={14} /><span><strong>API responds but is not ready.</strong> Authenticated requests may fail closed.{missing}</span></div>;
  }
  return <div className="api-banner ready"><CheckCircle2 size={14} /><span><strong>API responds and reports ready.</strong> Provider setup and live generation/storage evidence are reported separately below.</span></div>;
}

function ProjectPicker({ projects, value, busy, onChange, onCreate }: { projects: Project[]; value: string; busy: boolean; onChange: (value: string) => void; onCreate: () => void }) {
  if (busy) return <div className="workspace-select"><span className="field-label">Project</span><div className="input flex items-center gap-2"><LoaderCircle size={13} className="spin" />Loading your projects</div></div>;
  if (!projects.length) return <button className="button button-secondary button-small" onClick={onCreate}>Create a project</button>;
  return <div className="field workspace-select"><label htmlFor="project-select">Current project</label><select className="select" id="project-select" value={value} onChange={(event) => onChange(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>;
}

function SignInGate({ session, title, description }: { session: Session | null; title: string; description: string }) {
  if (session) return null;
  return <div className="card empty-state"><div className="empty-icon"><Wallet size={20} /></div><h3>{title}</h3><p>{description}</p><p>Connect a wallet, sign a one-time SIWE challenge on Fuji, and your short-lived bearer stays in memory only.</p></div>;
}

function TimeFilters({ from, to, onFrom, onTo }: { from: string; to: string; onFrom: (value: string) => void; onTo: (value: string) => void }) {
  return <>
    <div className="field"><label htmlFor="created-from">Created from</label><input id="created-from" className="input" type="date" value={from} onChange={(event) => onFrom(event.target.value)} /></div>
    <div className="field"><label htmlFor="created-to">Created through</label><input id="created-to" className="input" type="date" value={to} onChange={(event) => onTo(event.target.value)} /></div>
  </>;
}

function LibraryPage({ session, projectId }: { session: Session | null; projectId: string }) {
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [items, setItems] = useState<RecallItem[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);

  async function search(event?: FormEvent, next = false) {
    event?.preventDefault();
    if (!session || !projectId || !query.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<RecallResponse>('/v1/recall', {
        token: session.token,
        body: {
          query: query.trim(),
          project_id: projectId,
          ...(dateBoundary(from) ? { created_from: dateBoundary(from) } : {}),
          ...(dateBoundary(to, true) ? { created_to: dateBoundary(to, true) } : {}),
          limit: 10,
          ...(next && cursor ? { cursor } : {}),
        },
      });
      setItems((current) => next ? [...current, ...result.items] : result.items);
      setCursor(result.next_cursor);
      setSearched(true);
    } catch (failure) {
      setError(userFacingError(failure));
      if (!next) setItems([]);
      setSearched(true);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <SignInGate session={session} title="Your memory starts with you" description="Sign in to search the verified lessons your project has approved and indexed." />
    {session && !projectId && <div className="card empty-state"><div className="empty-icon"><BookOpen size={20} /></div><h3>No project is available yet</h3><p>Create a project before searching private memory.</p></div>}
    {session && projectId && <>
      <form className="card filter-card mb-4" onSubmit={(event) => void search(event, false)}>
        <div className="field"><label htmlFor="library-query">Search your memory</label><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8ba09b]" size={14} /><input id="library-query" className="input pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. How do we handle retries?" maxLength={2000} required /></div></div>
        <TimeFilters from={from} to={to} onFrom={setFrom} onTo={setTo} />
        <BusyButton className="button button-primary" type="submit" busy={busy}><Search size={14} />Search</BusyButton>
      </form>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[10px] text-[#788d89]"><span className="pill pill-muted"><Fingerprint size={11} />Project ACL applied before retrieval</span><span className="pill pill-muted"><Clock3 size={11} />Created-time filters use UTC</span></div>
      {error && <div className="mb-3"><ErrorNotice notice={{ tone: 'error', text: error }} onDismiss={() => setError('')} /></div>}
      {busy && !items.length && <LoadingCard label="Searching authorized, verified memory…" />}
      {searched && !busy && items.length === 0 && !error && <div className="card empty-state"><div className="empty-icon"><Search size={20} /></div><h3>No verified matches in this scope</h3><p>Try a different question or date range. Unverified and inaccessible material is not shown.</p></div>}
      {!searched && <div className="card empty-state"><div className="empty-icon"><Waves size={20} /></div><h3>Ask the memory, not a blank page</h3><p>Search is scoped to this project and the selected time range. Only ready, verified evidence can appear here.</p></div>}
      <div className="result-list">
        {items.map((item) => <article className="card memory-card" key={item.chunk_id}>
          <div className="memory-topline"><span className="pill"><FileCheck2 size={11} />Verified memory</span><div className="memory-meta"><span>Match {Math.round(item.score * 100)}%</span><span>·</span><span>{item.source.chunk_locator}</span></div></div>
          <p className="memory-text">{item.text}</p>
          <div className="source-row"><SourceChip source={item.source} /></div>
        </article>)}
      </div>
      {cursor && <div className="mt-4 flex justify-center"><BusyButton className="button button-secondary" busy={busy} onClick={() => void search(undefined, true)}><ArrowDownRight size={14} />Load more evidence</BusyButton></div>}
    </>}
  </>;
}

function DistillPage({ session, projectId }: { session: Session | null; projectId: string }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [localScan, setLocalScan] = useState(false);
  const [piiReview, setPiiReview] = useState(false);
  const [egressReview, setEgressReview] = useState(false);
  const [finalReview, setFinalReview] = useState(false);
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [distilled, setDistilled] = useState<DistilledDraft | null>(null);
  const [approvalToken, setApprovalToken] = useState('');
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<JobStatus | null>(null);
  const [busyStep, setBusyStep] = useState<'create' | 'egress' | 'distill' | 'approve' | 'remember' | null>(null);
  const [error, setError] = useState('');
  const [jobError, setJobError] = useState('');
  const [importance, setImportance] = useState('0.7');
  const [validFrom, setValidFrom] = useState(new Date().toISOString().slice(0, 10));
  const jobTimer = useRef<number | null>(null);
  const rememberRequest = useRef<{
    project_id: string;
    idempotency_key: string;
    approved_draft_id: string;
    approved_sha256: string;
    approval_token: string;
    importance: number;
    valid_from: string;
  } | null>(null);

  useEffect(() => {
    if (!session || !jobId || job?.ready || job?.state === 'failed') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await api<JobStatus>(`/v1/jobs/${jobId}`, { token: session.token });
        if (cancelled) return;
        setJob(status);
        setJobError('');
        if (!status.ready && status.state !== 'failed') jobTimer.current = window.setTimeout(poll, 3000);
      } catch (failure) {
        if (cancelled) return;
        setJobError(userFacingError(failure));
        if (failure instanceof ApiError && failure.retryable) jobTimer.current = window.setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => { cancelled = true; if (jobTimer.current !== null) window.clearTimeout(jobTimer.current); };
  }, [session, jobId, job?.ready, job?.state]);

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !projectId) return;
    setBusyStep('create'); setError('');
    try {
      const response = await api<DraftRecord>('/v1/drafts', {
        token: session.token,
        body: { project_id: projectId, title: title.trim(), sanitized_text: text.trim(), local_scan_passed: true, pii_review_passed: true },
      });
      setDraft(response); setDistilled(null); setApprovalToken(''); setJobId(''); setJob(null); setEgressReview(false); setFinalReview(false); rememberRequest.current = null;
    } catch (failure) { setError(userFacingError(failure)); }
    finally { setBusyStep(null); }
  }

  async function approveEgress() {
    if (!session || !draft) return;
    setBusyStep('egress'); setError('');
    try {
      await api(`/v1/drafts/${draft.id}/egress-approve`, { token: session.token, body: { approved_sha256: draft.candidate_sha256 } });
      setDraft({ ...draft, state: 'egress_approved' });
      setNoticeText('Exact candidate approved for external-model processing. No upload has happened.');
    } catch (failure) { setError(userFacingError(failure)); }
    finally { setBusyStep(null); }
  }

  const [stepNotice, setStepNotice] = useState('');
  function setNoticeText(value: string) { setStepNotice(value); }

  async function runDistill() {
    if (!session || !draft) return;
    setBusyStep('distill'); setError(''); setStepNotice('');
    try {
      const response = await api<DistilledDraft>(`/v1/drafts/${draft.id}/distill`, { token: session.token, body: {} });
      setDistilled(response); setDraft({ ...draft, state: response.state, candidate_sha256: response.candidate_sha256 });
    } catch {
      setDraft((current) => current ? { ...current, state: 'distilling' } : current);
      setError('The model request may have been sent. This egress approval will not be retried; create a new draft to try again.');
    }
    finally { setBusyStep(null); }
  }

  async function approveFinal() {
    if (!session || !distilled) return;
    setBusyStep('approve'); setError('');
    try {
      const response = await api<{ approval_token: string; expires_at: string; uploaded: false }>(`/v1/drafts/${distilled.id}/approve`, { token: session.token, body: { approved_sha256: distilled.candidate_sha256 } });
      setApprovalToken(response.approval_token);
      rememberRequest.current = null;
      setStepNotice(`Digest approval saved. It expires at ${new Date(response.expires_at).toLocaleTimeString()}. No content has been uploaded.`);
    } catch (failure) { setError(userFacingError(failure)); }
    finally { setBusyStep(null); }
  }

  async function remember() {
    if (!session || !draft || !distilled || !approvalToken || !projectId) return;
    setBusyStep('remember'); setError('');
    try {
      const request = rememberRequest.current ?? {
        project_id: draft.project_id,
        idempotency_key: draft.id,
        approved_draft_id: draft.id,
        approved_sha256: distilled.candidate_sha256,
        approval_token: approvalToken,
        importance: Number(importance),
        valid_from: new Date(`${validFrom}T00:00:00.000Z`).toISOString(),
      };
      rememberRequest.current = request;
      const response = await api<{ job_id: string; memory_id: string; state: string; resource_uri: string; ready: boolean }>('/v1/remember', {
        token: session.token,
        body: request,
      });
      rememberRequest.current = null;
      setJobId(response.job_id);
      setJob({ uri: response.resource_uri, kind: 'job', job_id: response.job_id, state: response.state as JobStatus['state'], artifact_state: 'staged', ready: response.ready, sources: [], error_code: null });
      setApprovalToken('');
      setStepNotice('Accepted by the API as a durable job. Storage and indexing are not complete until the job reports ready with verified sources.');
    } catch (failure) { setError(userFacingError(failure)); }
    finally { setBusyStep(null); }
  }

  const currentStep = jobId ? 5 : approvalToken ? 4 : distilled ? 3 : draft?.state === 'egress_approved' ? 2 : draft ? 1 : 0;
  const progress = [0, 1, 2, 3, 4].map((number) => number < currentStep || (currentStep === 0 && number === 0));

  return <>
    <SignInGate session={session} title="Keep the source in your hands" description="Sign in to create a private draft. Raw text is not sent until you approve the exact sanitized candidate." />
    {session && !projectId && <div className="card empty-state"><div className="empty-icon"><FileText size={20} /></div><h3>Create a project first</h3><p>Memory is scoped to a project you control.</p></div>}
    {session && projectId && <>
      <div className="progress-steps" aria-label={`Distillation step ${currentStep + 1} of 5`}>{progress.map((done, index) => <span key={index} className={`progress-step ${done ? 'done' : ''}`} />)}</div>
      <div className="workflow-grid">
        <section className="card workflow-card">
          <div className="workflow-heading"><span className="step-number">01</span><div><h2>Start with reviewed material</h2><p>Send only minimized, sanitized notes — never a raw transcript.</p></div></div>
          {error && <div className="mb-4"><ErrorNotice notice={{ tone: 'error', text: error }} onDismiss={() => setError('')} /></div>}
          <form className="form-stack" onSubmit={(event) => void createDraft(event)}>
            <div className="field"><label htmlFor="lesson-title">Working title</label><input id="lesson-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="e.g. Safer database migrations" required disabled={Boolean(draft)} /></div>
            <div className="field"><label htmlFor="sanitized-text">Sanitized notes</label><textarea id="sanitized-text" className="textarea" value={text} onChange={(event) => setText(event.target.value)} maxLength={65536} placeholder="Write the reusable lesson or short excerpt you want to distill…" required disabled={Boolean(draft)} /></div>
            <div className="alert"><ShieldCheck size={14} /><span>Do not paste secrets, personal identifiers, or unreviewed conversation dumps. The deterministic scanner is not a privacy certification and can miss sensitive content.</span></div>
            <label className="check-row"><input type="checkbox" checked={localScan} onChange={(event) => setLocalScan(event.target.checked)} disabled={Boolean(draft)} />I minimized this content and checked it locally for credentials and sensitive details.</label>
            <label className="check-row"><input type="checkbox" checked={piiReview} onChange={(event) => setPiiReview(event.target.checked)} disabled={Boolean(draft)} />I reviewed the text for personal or confidential information and have permission to use it.</label>
            <BusyButton className="button button-primary button-block" type="submit" busy={busyStep === 'create'} disabled={!localScan || !piiReview || !title.trim() || !text.trim() || Boolean(draft)}><FileText size={14} />Create encrypted review draft</BusyButton>
          </form>
        </section>

        <section className="card workflow-card">
          <div className="workflow-heading"><span className="step-number">02</span><div><h2>Review before each handoff</h2><p>The API enforces digest approvals; your consent is never inferred.</p></div></div>
          {!draft && <div className="empty-state !py-8"><div className="empty-icon"><Fingerprint size={20} /></div><h3>Nothing submitted yet</h3><p>Create a draft to inspect the exact candidate and approve external processing.</p></div>}
          {draft && <div className="form-stack">
            <div className="review-box">
              <h3>Exact candidate for outbound model processing</h3>
              <p>Candidate digest: <span className="digest">{draft.candidate_sha256}</span></p>
              <div className="review-content"><strong>{draft.candidate.title}</strong><br /><br />{draft.candidate.sanitized_text}</div>
              <p className="mt-3">Server scan: {draft.scan?.server_scan_passed ? 'passed deterministic checks' : 'not confirmed'} · {draft.scan?.pipeline_version ?? 'scanner version not reported'}</p>
              {draft.scan?.limitations?.map((limitation) => <p key={limitation} className="mt-1">Limit: {limitation}</p>)}
            </div>
            {draft.state !== 'egress_approved' && !distilled && <>
              <label className="check-row"><input type="checkbox" checked={egressReview} onChange={(event) => setEgressReview(event.target.checked)} />I reviewed this exact candidate and approve sending it to the configured generation provider. This is separate from final storage approval.</label>
              <BusyButton className="button button-secondary button-block" onClick={() => void approveEgress()} busy={busyStep === 'egress'} disabled={!egressReview}><Fingerprint size={14} />Approve exact text for model egress</BusyButton>
            </>}
            {draft.state === 'egress_approved' && !distilled && <>
              {stepNotice && <ErrorNotice notice={{ tone: 'success', text: stepNotice }} />}
              <div className="alert"><ArrowRight size={14} /><span>Only the approved candidate may now be sent for generation. A provider that is not configured will fail closed.</span></div>
              <BusyButton className="button button-primary button-block" onClick={() => void runDistill()} busy={busyStep === 'distill'}><Sparkles size={14} />Generate a lesson draft</BusyButton>
            </>}
            {draft.state === 'distilling' && !distilled && <div className="alert"><Clock3 size={14} /><span>Distillation is awaiting a definitive result. The model request may have been sent, so this egress approval cannot be retried. Create a new draft to try again.</span></div>}
            {distilled && <>
              <div className="review-box">
                <h3>Distilled lesson — inspect before storage</h3>
                <p>New digest: <span className="digest">{distilled.candidate_sha256}</span></p>
                <pre className="code-block mt-3">{JSON.stringify(distilled.content, null, 2)}</pre>
              </div>
              {!approvalToken && <>
                <label className="check-row"><input type="checkbox" checked={finalReview} onChange={(event) => setFinalReview(event.target.checked)} />I reviewed this final lesson and approve only this digest for encrypted staging. I understand permanent upload is a separate, asynchronous job.</label>
                <BusyButton className="button button-secondary button-block" onClick={() => void approveFinal()} busy={busyStep === 'approve'} disabled={!finalReview}><CheckCircle2 size={14} />Approve final lesson digest</BusyButton>
              </>}
              {approvalToken && <div className="form-stack">
                {stepNotice && <ErrorNotice notice={{ tone: 'success', text: stepNotice }} />}
                <div className="field-row">
                  <div className="field"><label htmlFor="importance">Importance</label><select className="select" id="importance" value={importance} onChange={(event) => setImportance(event.target.value)}><option value="0.5">Useful</option><option value="0.7">Important</option><option value="0.9">Critical</option></select></div>
                  <div className="field"><label htmlFor="valid-from">Effective from</label><input className="input" id="valid-from" type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /></div>
                </div>
                <div className="alert"><Clock3 size={14} /><span>Approval token is short-lived, single-use, and bound to the reviewed digest. Submitting queues work; it does not claim a successful upload.</span></div>
                <BusyButton className="button button-primary button-block" onClick={() => void remember()} busy={busyStep === 'remember'}><Anchor size={14} />Queue encrypted memory job</BusyButton>
              </div>}
            </>}
          </div>}
        </section>
      </div>

      {jobId && <section className="card card-pad mt-4 job-card" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><div className="eyebrow">Durable job</div><h2 className="mt-1 font-serif text-xl font-medium text-[#2b5050]">Storage and indexing status</h2></div><span className={`pill ${job?.ready ? '' : job?.state === 'failed' ? 'pill-coral' : 'pill-warning'}`}>{job?.ready ? 'Verified and indexed' : job?.state === 'failed' ? 'Failed' : job?.state ?? 'Queued'}</span></div>
        <div className="job-track"><div className="job-track-fill" style={{ width: job?.ready ? '100%' : job?.state === 'running' ? '55%' : job?.state === 'failed' ? '100%' : '22%' }} /></div>
        <div className="job-status">{job?.ready ? <CheckCircle2 size={14} /> : job?.state === 'failed' ? <XCircle size={14} /> : <LoaderCircle size={14} className="spin" />}<span>{job?.ready ? 'Ready with backend-verified sources.' : job?.state === 'failed' ? `Job ended with ${job.error_code ?? 'an error'}.` : 'Accepted; waiting for backend worker verification.'}</span></div>
        {job?.ready && <div className="source-row">{job.sources.map((source, index) => <SourceChip key={`${source.irys_tx_id}-${index}`} source={source} index={index} />)}</div>}
        {jobError && <ErrorNotice notice={{ tone: 'error', text: jobError }} />}
        {job?.state === 'failed' && <div className="alert error"><CircleHelp size={14} /><span>The API did not report this memory as ready. Check the integration status; an accepted job is not proof of permanent storage.</span></div>}
        <div className="field-help">Job {short(jobId, 10, 6)} · source links expose ciphertext only.</div>
      </section>}
      <p className="footer-note">Private memory is encrypted for staging, but model egress and server-side retrieval are not zero-knowledge. Never submit information you are not comfortable processing with the configured provider.</p>
    </>}
  </>;
}

function LoadingCard({ label }: { label: string }) {
  return <div className="card empty-state"><div className="empty-icon"><LoaderCircle className="spin" size={20} /></div><h3>{label}</h3><p>The app waits for an API response; no local sample result is substituted.</p></div>;
}

function AskPage({ session, projectId }: { session: Session | null; projectId: string }) {
  const [question, setQuestion] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [messages, setMessages] = useState<RecallMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, busy]);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !projectId || !question.trim()) return;
    const prompt = question.trim();
    setQuestion(''); setError(''); setMessages((current) => [...current, { role: 'user', text: prompt }]); setBusy(true);
    try {
      const response = await api<ChatResponse>('/v1/chat', {
        token: session.token,
        body: {
          project_id: projectId,
          question: prompt,
          ...(dateBoundary(from) ? { created_from: dateBoundary(from) } : {}),
          ...(dateBoundary(to, true) ? { created_to: dateBoundary(to, true) } : {}),
        },
      });
      setMessages((current) => [...current, { role: 'assistant', response }]);
    } catch (failure) {
      setError(userFacingError(failure));
    } finally { setBusy(false); }
  }

  return <>
    <SignInGate session={session} title="Ask your own project" description="Sign in to search your authorized memories and build answers only from verified evidence." />
    {session && !projectId && <div className="card empty-state"><div className="empty-icon"><MessageCircle size={20} /></div><h3>Choose a project first</h3><p>Every answer is bounded to the selected project’s access controls.</p></div>}
    {session && projectId && <div className="chat-layout">
      <section className="card chat-box" aria-label="Cited project chat">
        <div className="chat-head"><div><h2>Project conversation</h2><div className="field-help mt-1">Evidence is retrieved under live project access and time filters.</div></div><span className="pill"><ShieldCheck size={11} />Citations required</span></div>
        <div className="chat-transcript" ref={transcriptRef} aria-live="polite">
          {!messages.length && !busy && <div className="chat-intro"><div className="mb-3 flex justify-center"><div className="empty-icon"><MessageCircle size={20} /></div></div>Ask about a decision, a rule, or a lesson. If the project has no verified evidence, MemOcean will say so instead of making up an answer.</div>}
          {messages.map((message, index) => message.role === 'user'
            ? <div key={`user-${index}`} className="message user"><div className="message-label"><Fingerprint size={12} />You</div><p>{message.text}</p></div>
            : <div key={`assistant-${index}`}><AnswerBlock response={message.response} /></div>)}
          {busy && <div className="message answer"><div className="message-label"><LoaderCircle className="spin" size={12} />Checking authorized evidence</div><p>Retrieving project sources…</p></div>}
        </div>
        {error && <div className="px-4 pb-3"><ErrorNotice notice={{ tone: 'error', text: error }} onDismiss={() => setError('')} /></div>}
        <form className="chat-compose" onSubmit={(event) => void ask(event)}>
          <label className="sr-only" htmlFor="chat-question">Ask a question</label>
          <input id="chat-question" className="input" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2000} placeholder="Ask a question about your project…" disabled={busy} required />
          <BusyButton className="button button-primary" type="submit" busy={busy} disabled={!question.trim()}><ArrowRight size={14} />Ask</BusyButton>
        </form>
      </section>
      <aside className="chat-aside">
        <div className="card info-card"><h3><Clock3 size={14} />Time window</h3><p>Optional creation-date filters apply before evidence reaches generation. “Created through” includes that whole UTC day.</p><div className="field-row mt-3">
          <div className="field"><label htmlFor="chat-from">From</label><input id="chat-from" className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></div>
          <div className="field"><label htmlFor="chat-to">Through</label><input id="chat-to" className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></div>
        </div></div>
        <div className="card info-card"><h3><LockKeyhole size={14} />No evidence, no claim</h3><p>Unverified chunks stay out. An abstention has no source chips. Model-generated IDs cannot create citations.</p></div>
        <div className="card info-card"><h3><Globe2 size={14} />Source links</h3><p>Links point to ciphertext and storage evidence, not publicly readable plaintext. Hashes do not prove factual truth.</p></div>
      </aside>
    </div>}
  </>;
}

function CapsulesPage({
  session, sessionGeneration, projectId, projectName, capsules, loading, error, entitlements, entitlementsError,
  onRefreshEntitlements, onSync, syncing, synced, onQuery, queryResults, trialRemainingByRoot, exhaustedTrialRoots, purchaseConfigReady,
  submittedPurchases, onPendingTransaction, onClearPendingTransaction,
}: {
  session: Session | null;
  sessionGeneration: { current: number };
  projectId: string;
  projectName: string;
  capsules: CapsuleListing[];
  loading: boolean;
  error: string;
  entitlements: Entitlement[];
  entitlementsError: string;
  onRefreshEntitlements: () => void;
  onSync: (versionId: string) => void;
  syncing: Record<string, boolean>;
  synced: Record<string, boolean>;
  onQuery: (item: CapsuleListing, question: string, mode: 'trial' | 'purchased') => void;
  queryResults: Record<string, CapsuleQueryResult>;
  trialRemainingByRoot: Record<string, number>;
  exhaustedTrialRoots: Record<string, boolean>;
  purchaseConfigReady: boolean;
  submittedPurchases: Record<string, string>;
  onPendingTransaction: (versionId: string, hash: string) => void;
  onClearPendingTransaction: (versionId: string, hash: string) => void;
}) {
  return <>
    <SignInGate session={session} title="Explore the public catalog" description="Capsule descriptions are loaded from the real catalog API. Sign in for trial questions, purchases, and private project sync." />
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#dfe9e2] bg-[#edf4ed] px-4 py-3 text-[10px] leading-relaxed text-[#59716c]">
      <div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 shrink-0 text-[#438477]" size={14} /><span>Each trial question runs against a separate, reviewed safe preview. The server enforces three lifetime questions per user and capsule root. A paid purchase unlocks only one exact version after backend reconciliation.</span></div>
      {session && <button className="button button-secondary button-small" onClick={onRefreshEntitlements}><Fingerprint size={12} />Refresh access</button>}
    </div>
    {entitlementsError && <div className="mb-3"><ErrorNotice notice={{ tone: 'error', text: entitlementsError }} /></div>}
    {loading && <LoadingCard label="Loading the live capsule catalog…" />}
    {!loading && error && <div className="card empty-state"><div className="empty-icon"><CircleHelp size={20} /></div><h3>Catalog not available</h3><p>{error}</p><p>No sample listings are shown in place of the backend catalog.</p></div>}
    {!loading && !error && capsules.length === 0 && <div className="card empty-state"><div className="empty-icon"><Layers3 size={20} /></div><h3>No capsules are currently listed</h3><p>The catalog API returned no eligible, verified listings. New items only appear after review, indexing, and storage verification.</p></div>}
    {!loading && !error && capsules.length > 0 && <div className="capsule-grid">
      {capsules.map((item) => {
        const access = purchasePresentation(item.capsule_version_id, entitlements, submittedPurchases[item.capsule_version_id]);
        const remaining = remainingTrialQuestions(trialRemainingByRoot[item.capsule_root_id]);
        return <CapsuleCard
          key={`${item.capsule_root_id}-${item.capsule_version_id}`}
          item={item}
          session={session}
          sessionGeneration={sessionGeneration}
          projectId={projectId}
          projectName={projectName}
          access={access}
          remaining={remaining}
          trialExhausted={Boolean(exhaustedTrialRoots[item.capsule_root_id])}
          result={queryResults[item.capsule_version_id]}
          purchaseConfigReady={purchaseConfigReady}
          transactionHash={submittedPurchases[item.capsule_version_id]}
          syncing={Boolean(syncing[item.capsule_version_id])}
          synced={Boolean(synced[item.capsule_version_id])}
          onSync={() => onSync(item.capsule_version_id)}
          onQuery={onQuery}
          onPendingTransaction={onPendingTransaction}
          onClearPendingTransaction={onClearPendingTransaction}
        />;
      })}
    </div>}
    <p className="footer-note">A purchase is a version-specific license, not an NFT or transfer of copyright. Fuji AVAX is test value. Client transaction receipts never unlock access; the backend must confirm the exact buyer and version.</p>
  </>;
}

function CapsuleCard({ item, session, sessionGeneration, projectId, projectName, access, remaining, trialExhausted, result, purchaseConfigReady, transactionHash, syncing, synced, onSync, onQuery, onPendingTransaction, onClearPendingTransaction }: {
  item: CapsuleListing;
  session: Session | null;
  sessionGeneration: { current: number };
  projectId: string;
  projectName: string;
  access: 'idle' | 'pending_server_confirmation' | 'unlocked';
  remaining: number | null;
  trialExhausted: boolean;
  result?: CapsuleQueryResult;
  purchaseConfigReady: boolean;
  transactionHash?: string;
  syncing: boolean;
  synced: boolean;
  onSync: () => void;
  onQuery: (item: CapsuleListing, question: string, mode: 'trial' | 'purchased') => void;
  onPendingTransaction: (versionId: string, hash: string) => void;
  onClearPendingTransaction: (versionId: string, hash: string) => void;
}) {
  const [trialQuestion, setTrialQuestion] = useState('');
  const [paidQuestion, setPaidQuestion] = useState('');
  const [purchaseError, setPurchaseError] = useState('');
  const [receiptStatusError, setReceiptStatusError] = useState('');
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const { address: connectedAddress, chainId: connectedChainId } = useAccount();
  const connectedAddressRef = useRef(connectedAddress?.toLowerCase());
  connectedAddressRef.current = connectedAddress?.toLowerCase();
  const fujiPublicClient = usePublicClient({ chainId: FUJI_CHAIN_ID });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync, isPending: walletTransactionPending } = useWriteContract();
  const answer = result ? presentAnswer(result) : null;
  const formattedPrice = capsulePrice(item.price_wei);
  const configuredForListing = purchaseConfigReady && Boolean(marketplaceAddress) && marketplaceAddress?.toLowerCase() === item.contract_address.toLowerCase();
  const walletMatchesSession = Boolean(session && connectedAddress && connectedAddress.toLowerCase() === session.address.toLowerCase());

  useEffect(() => {
    if (!transactionHash) return;
    if (!fujiPublicClient) {
      setReceiptStatusError('Receipt status is unavailable. Your submitted transaction remains pending; no failure was assumed.');
      return;
    }
    let active = true;
    let retryTimer: number | undefined;
    const checkReceipt = async () => {
      try {
        const receipt = await fujiPublicClient.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
        if (!active) return;
        if (receipt.status === 'reverted') {
          onClearPendingTransaction(item.capsule_version_id, transactionHash);
          setReceiptStatusError('');
          setPurchaseError('The transaction reverted on Fuji. No entitlement was granted. You can retry this purchase.');
          return;
        }
        setReceiptStatusError('');
      } catch (failure) {
        if (!active) return;
        if (!(failure instanceof TransactionReceiptNotFoundError)) {
          setReceiptStatusError('Receipt status is unavailable. Your submitted transaction remains pending; no failure was assumed.');
        }
        retryTimer = window.setTimeout(() => { void checkReceipt(); }, 5000);
      }
    };
    void checkReceipt();
    return () => { active = false; if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
  }, [fujiPublicClient, item.capsule_version_id, onClearPendingTransaction, transactionHash]);

  async function submitPurchase() {
    setPurchaseError('');
    if (!session || !configuredForListing || item.chain_id !== FUJI_CHAIN_ID_TEXT) return;
    const generation = sessionGeneration.current;
    const expectedAddress = session.address.toLowerCase();
    if (!walletMatchesSession) {
      setPurchaseError('The connected wallet does not match the wallet that signed in. No transaction was sent.');
      return;
    }
    setPurchaseBusy(true);
    try {
      if (connectedChainId !== FUJI_CHAIN_ID) {
        await switchChainAsync({ chainId: FUJI_CHAIN_ID });
        if (generation !== sessionGeneration.current || connectedAddressRef.current !== expectedAddress) {
          setPurchaseError('The wallet account changed before purchase submission. No transaction was sent.');
          return;
        }
      }
      if (generation !== sessionGeneration.current || connectedAddressRef.current !== expectedAddress) {
        setPurchaseError('The wallet account changed before purchase submission. No transaction was sent.');
        return;
      }
      const price = BigInt(item.price_wei);
      const hash = await writeContractAsync({
        account: session.address,
        address: item.contract_address,
        abi: marketplaceAbi,
        functionName: 'purchase',
        args: [BigInt(item.listing_id), price],
        value: price,
        chainId: FUJI_CHAIN_ID,
      });
      if (generation !== sessionGeneration.current || connectedAddressRef.current !== expectedAddress) return;
      onPendingTransaction(item.capsule_version_id, hash);
    } catch (failure) {
      setPurchaseError(`${userFacingError(failure)} No entitlement was granted by the browser.`);
    } finally {
      setPurchaseBusy(false);
    }
  }

  return <article className="card capsule-card">
    <div className="capsule-top">
      <div className="capsule-art"><Fish size={20} aria-hidden="true" /></div>
      <span className={`pill ${access === 'unlocked' ? '' : access === 'pending_server_confirmation' ? 'pill-warning' : 'pill-muted'}`}>
        {access === 'unlocked' ? <><Check size={11} />Access confirmed</> : access === 'pending_server_confirmation' ? <><Clock3 size={11} />Pending server check</> : <><Layers3 size={11} />Version {String(item.version)}</>}
      </span>
    </div>
    <h3>{item.title}</h3>
    <p className="license">License · {item.license}</p>
    <div className="capsule-detail">
      <div><span className="detail-label">Price</span><span className="capsule-price">{formattedPrice} <small>AVAX</small></span></div>
      <div><span className="detail-label">Seller</span><span className="detail-value">{short(item.seller, 7, 5)}</span></div>
      <div><span className="detail-label">Listing</span><span className="detail-value">#{item.listing_id}</span></div>
      <div><span className="detail-label">Chain</span><span className="detail-value">{item.chain_id === FUJI_CHAIN_ID_TEXT ? 'Avalanche Fuji' : `Chain ${item.chain_id}`}</span></div>
      <div className="col-span-2"><span className="detail-label">Pinned version</span><span className="detail-value">{item.capsule_version_id}</span></div>
    </div>

    {access === 'idle' && <div className="purchase-box">
      <BusyButton className="button button-primary button-block" busy={purchaseBusy || walletTransactionPending} disabled={!session || !configuredForListing || !walletMatchesSession || item.chain_id !== FUJI_CHAIN_ID_TEXT} onClick={() => void submitPurchase()}>
        <Wallet size={13} />Buy exact version · {formattedPrice} AVAX
      </BusyButton>
      {!purchaseConfigReady && <p className="field-help mt-2">Purchase is disabled until the compiled marketplace ABI, verified contract address, and Fuji chain configuration are available. No transaction is sent.</p>}
      {purchaseConfigReady && marketplaceAddress?.toLowerCase() !== item.contract_address.toLowerCase() && <p className="field-help mt-2">This listing’s contract does not match the configured marketplace deployment; purchase is disabled.</p>}
      {session && !walletMatchesSession && <p className="field-help mt-2">Connect the wallet that signed in before purchasing.</p>}
      {connectedChainId !== undefined && connectedChainId !== FUJI_CHAIN_ID && <p className="field-help mt-2">Your wallet will ask to switch to Avalanche Fuji before this purchase.</p>}
      {item.chain_id !== FUJI_CHAIN_ID_TEXT && <p className="field-help mt-2">This listing is not on the configured Fuji chain, so it cannot be purchased here.</p>}
      <p className="field-help mt-2">The exact listed wei amount is sent as AVAX. Network gas is separate.</p>
      {purchaseError && <div className="mt-2"><ErrorNotice notice={{ tone: 'error', text: purchaseError }} /></div>}
    </div>}

    {access === 'pending_server_confirmation' && <div className="pending-box">
      <div className="flex items-center gap-2"><LoaderCircle className="spin" size={13} /><strong>Submitted · awaiting backend reconciliation</strong></div>
      <p className="mb-0 mt-2">{transactionHash ? `Transaction ${short(transactionHash, 9, 7)} was submitted. The browser receipt is not proof of entitlement.` : 'Waiting for the chain transaction.'} Access and sync stay locked until the API reports an active, current entitlement for this version.</p>
      {receiptStatusError && <div className="mt-2"><ErrorNotice notice={{ tone: 'error', text: receiptStatusError }} /></div>}
    </div>}

    {access === 'unlocked' && <div className="purchase-box">
      <div className="alert success"><CheckCircle2 size={14} /><span>Backend confirms an active entitlement for this exact capsule version.</span></div>
      <BusyButton className="button button-secondary button-block mt-2" busy={syncing} disabled={!projectId} onClick={onSync}><ArrowRight size={13} />{synced ? `Synced to ${projectName || 'project'}` : 'Sync this version to project'}</BusyButton>
      {!projectId && <p className="field-help mt-2">Select a project before syncing.</p>}
      {synced && <div className="mt-3"><div className="field"><label htmlFor={`paid-question-${item.capsule_version_id}`}>Ask this purchased version</label><form className="mt-1 flex gap-2" onSubmit={(event) => { event.preventDefault(); onQuery(item, paidQuestion, 'purchased'); }}><input id={`paid-question-${item.capsule_version_id}`} className="input" value={paidQuestion} onChange={(event) => setPaidQuestion(event.target.value)} placeholder="Ask using your authorized version…" required maxLength={2000} /><button className="button button-primary button-small" type="submit" disabled={!session || !paidQuestion.trim()} aria-label="Ask purchased capsule"><ArrowRight size={13} /></button></form></div></div>}
    </div>}

    <details className="trial-panel">
      <summary>Ask the safe preview · up to 3 lifetime questions</summary>
      {session ? <form onSubmit={(event) => { event.preventDefault(); onQuery(item, trialQuestion, 'trial'); }}>
        <label className="field-label" htmlFor={`trial-question-${item.capsule_version_id}`}>Your question</label>
        <input id={`trial-question-${item.capsule_version_id}`} className="input" value={trialQuestion} onChange={(event) => setTrialQuestion(event.target.value)} placeholder="What kind of decisions does this help with?" maxLength={2000} required />
        <div className="field-help">The server uses an independently reviewed preview artifact — never paid corpus chunks. Requests may consume quota once inference is dispatched.</div>
        {remaining !== null && <span className="pill pill-muted w-fit">{remaining} trial {remaining === 1 ? 'question' : 'questions'} remaining · server-reported</span>}
        {trialExhausted && <span className="pill pill-warning w-fit">Lifetime quota exhausted for this capsule root</span>}
        <BusyButton className="button button-quiet button-small w-fit" type="submit" disabled={!trialQuestion.trim() || trialExhausted || !trialCanBeRequested(remaining)}><MessageCircle size={13} />Ask preview</BusyButton>
      </form> : <p className="mt-3 text-[10px] leading-relaxed text-[#788d89]">Sign in to ask a trial question. The server applies one lifetime quota across your keys, sessions, and versions.</p>}
      {result && <div className="trial-result">
        {result.trials_remaining !== null && <div className="mb-3"><span className="pill pill-muted">{result.trials_remaining} server-reported trial questions remain</span></div>}
        {answer && <AnswerBlock response={{ kind: 'success', answer_id: undefined, answer: answer.text, abstained: answer.abstained, claims: answer.claims }} />}
      </div>}
    </details>
  </article>;
}

export default App;
