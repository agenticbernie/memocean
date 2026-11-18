import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, FolderKanban, KeyRound, Plus, Terminal, Trash2 } from 'lucide-react';
import { API_BASE_URL, api, userFacingError } from './api';
import type { ApiToken, Project, Session, TokenScope } from './types';

type ConsoleTab = 'keys' | 'setup' | 'projects';
type CopyTarget = 'token' | 'project' | 'claude' | 'cursor' | 'codex' | null;

const scopeOptions: Array<{ value: TokenScope; label: string }> = [
  { value: 'memory:read', label: 'Read project memory' },
  { value: 'memory:write', label: 'Create reviewed memories' },
  { value: 'capsule:query', label: 'Query entitled capsules' },
  { value: 'provenance:read', label: 'Verify provenance' },
];

function mcpUrl(): string {
  return `${API_BASE_URL}/mcp`;
}

function projectLabel(project: Project | undefined): string {
  return project ? `${project.name} · ${project.id}` : 'Select a project to scope your setup';
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function DeveloperConsole({
  session, projects, selectedProjectId, projectsLoading, onSelectProject, onCreateProject,
}: {
  session: Session | null;
  projects: Project[];
  selectedProjectId: string;
  projectsLoading: boolean;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string) => Promise<boolean>;
}) {
  const [tab, setTab] = useState<ConsoleTab>('keys');
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>(['memory:read']);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState('');
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [projectName, setProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const sessionTokenRef = useRef(session?.token);
  sessionTokenRef.current = session?.token;
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  const snippets = useMemo(() => {
    const url = mcpUrl();
    return {
      claude: JSON.stringify({ mcpServers: { memocean: { type: 'http', url, headers: { Authorization: 'Bearer ${MEMOCEAN_TOKEN}' } } } }, null, 2),
      cursor: JSON.stringify({ mcpServers: { memocean: { url, headers: { Authorization: 'Bearer ${MEMOCEAN_TOKEN}' } } } }, null, 2),
      codex: `[mcp_servers.memocean]\nurl = "${url}"\nbearer_token_env_var = "MEMOCEAN_TOKEN"`,
    };
  }, []);

  const refreshTokens = async () => {
    if (!session) return;
    const token = session.token;
    setLoadingTokens(true);
    try {
      const result = await api<{ items: ApiToken[] }>('/v1/tokens', { token });
      if (sessionTokenRef.current !== token) return;
      setTokens(result.items);
      setTokenError('');
    } catch (error) {
      if (sessionTokenRef.current === token) setTokenError(userFacingError(error));
    } finally {
      if (sessionTokenRef.current === token) setLoadingTokens(false);
    }
  };

  useEffect(() => {
    setCreatedToken('');
    setCopied(null);
    setTokens([]);
    setTokenError('');
    if (session) void refreshTokens();
  // PAT plaintext and metadata must not follow a sign-out or wallet-account change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user_id, session?.address, session?.token]);

  useEffect(() => {
    if (selectedProjectId && !projectIds.length) setProjectIds([selectedProjectId]);
  }, [projectIds.length, selectedProjectId]);

  async function handleCopy(value: string, target: Exclude<CopyTarget, null>) {
    if (await copyText(value)) {
      setCopied(target);
      window.setTimeout(() => setCopied((current) => current === target ? null : current), 1800);
    }
  }

  async function createToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !name.trim() || !scopes.length) return;
    setCreating(true);
    setTokenError('');
    try {
      const result = await api<ApiToken & { token: string; displayed_once: true }>('/v1/tokens', {
        token: session.token,
        body: { name: name.trim(), scopes, project_ids: projectIds, ...(expiresAt ? { expires_at: new Date(`${expiresAt}T23:59:59.999Z`).toISOString() } : {}) },
      });
      setTokens((current) => [result, ...current]);
      setCreatedToken(result.token);
      setCreateOpen(false);
      setName('');
      setExpiresAt('');
    } catch (error) {
      setTokenError(userFacingError(error));
    } finally {
      setCreating(false);
    }
  }

  async function revokeToken(token: ApiToken) {
    if (!session || !window.confirm(`Revoke ${token.name}? It will immediately stop working and cannot be restored.`)) return;
    setTokenError('');
    try {
      await api<void>(`/v1/tokens/${token.id}`, { token: session.token, method: 'DELETE' });
      setTokens((current) => current.map((item) => item.id === token.id ? { ...item, revoked_at: new Date().toISOString() } : item));
    } catch (error) {
      setTokenError(userFacingError(error));
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectName.trim()) return;
    setCreatingProject(true);
    const created = await onCreateProject(projectName.trim());
    if (created) setProjectName('');
    setCreatingProject(false);
  }

  function toggleScope(scope: TokenScope) {
    setScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]);
  }

  function toggleProject(id: string) {
    setProjectIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  if (!session) return <div className="card empty-state"><div className="empty-icon"><KeyRound size={20} /></div><h3>Sign in to manage developer access</h3><p>Create scoped, expiring personal access tokens only after a wallet session is active. Tokens are never stored in this browser.</p></div>;

  return <section className="developer-console" aria-label="Developer Console">
    <div className="console-tabs" role="tablist" aria-label="Developer Console sections">
      <button className={tab === 'keys' ? 'active' : ''} role="tab" aria-selected={tab === 'keys'} onClick={() => setTab('keys')}><KeyRound size={14} />API Keys</button>
      <button className={tab === 'setup' ? 'active' : ''} role="tab" aria-selected={tab === 'setup'} onClick={() => setTab('setup')}><Terminal size={14} />MCP &amp; CLI Setup</button>
      <button className={tab === 'projects' ? 'active' : ''} role="tab" aria-selected={tab === 'projects'} onClick={() => setTab('projects')}><FolderKanban size={14} />Projects</button>
    </div>

    {tab === 'keys' && <div className="console-grid">
      <div className="card console-card">
        <div className="console-heading"><div><div className="eyebrow">Scoped bearer tokens</div><h3>API keys</h3><p>Create tokens limited to specific scopes and projects. Plaintext is shown once.</p></div><div className="console-actions"><button className="button button-secondary button-small" onClick={() => void refreshTokens()} disabled={loadingTokens}>{loadingTokens ? 'Refreshing…' : 'Refresh'}</button><button className="button button-primary button-small" onClick={() => setCreateOpen(true)}><Plus size={13} />Create token</button></div></div>
        {tokenError && <div className="alert error">{tokenError}</div>}
        <div className="token-list">{!loadingTokens && !tokens.length && <p className="field-help">No API keys have been created for this account.</p>}{tokens.map((token) => <article className="token-row" key={token.id}><div><strong>{token.name}</strong><span>{token.prefix}… · created {new Date(token.created_at).toLocaleDateString()}</span><span>Last used {token.last_used_at ? new Date(token.last_used_at).toLocaleString() : 'never'} · expires {new Date(token.expires_at).toLocaleDateString()}</span><span>{token.scopes.join(', ')}</span></div>{token.revoked_at ? <span className="pill pill-coral">Revoked</span> : <button className="button button-danger button-small" onClick={() => void revokeToken(token)}><Trash2 size={13} />Revoke</button>}</article>)}</div>
        {loadingTokens && <p className="field-help">Loading API keys…</p>}
      </div>
    </div>}

    {createOpen && <div className="console-dialog-backdrop"><section className="console-dialog card" role="dialog" aria-modal="true" aria-labelledby="create-token-title"><div className="console-heading"><div><div className="eyebrow">Scoped bearer token</div><h3 id="create-token-title">Create an API key</h3><p>Choose only the scopes and projects this client needs.</p></div><button className="button button-secondary button-small" onClick={() => setCreateOpen(false)}>Cancel</button></div>
      {tokenError && <div className="alert error">{tokenError}</div>}
      <form className="form-stack" onSubmit={(event) => void createToken(event)}>
        <div className="field"><label htmlFor="token-name">Token name</label><input className="input" id="token-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="e.g. local Claude Code" required /></div>
        <fieldset className="console-fieldset"><legend>Scopes</legend>{scopeOptions.map((scope) => <label className="check-row" key={scope.value}><input type="checkbox" checked={scopes.includes(scope.value)} onChange={() => toggleScope(scope.value)} />{scope.label}<span className="scope-code">{scope.value}</span></label>)}</fieldset>
        <fieldset className="console-fieldset"><legend>Project restrictions <span className="field-help">Optional; empty grants no project selection restriction.</span></legend>{projects.length ? projects.map((project) => <label className="check-row" key={project.id}><input type="checkbox" checked={projectIds.includes(project.id)} onChange={() => toggleProject(project.id)} />{project.name}<span className="scope-code">{project.id}</span></label>) : <p className="field-help">Create a project before restricting a token.</p>}</fieldset>
        <div className="field"><label htmlFor="token-expiry">Expires on <span className="field-help">Optional; the API defaults to 30 days.</span></label><input className="input" id="token-expiry" type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></div>
        <button className="button button-primary" type="submit" disabled={creating || !scopes.length}>{creating ? 'Creating…' : 'Create token'}</button>
      </form>
    </section></div>}

    {createdToken && <div className="console-dialog-backdrop"><section className="console-dialog card" role="dialog" aria-modal="true" aria-labelledby="created-token-title"><div className="console-heading"><div><div className="eyebrow">Shown once</div><h3 id="created-token-title">Copy your API key</h3><p>MemOcean cannot show this plaintext again after you dismiss this dialog.</p></div></div><div className="token-reveal"><code>{createdToken}</code><div className="console-actions"><button className="button button-primary button-small" onClick={() => void handleCopy(createdToken, 'token')}>{copied === 'token' ? <Check size={13} /> : <Copy size={13} />}{copied === 'token' ? 'Copied' : 'Copy token'}</button><button className="button button-secondary button-small" onClick={() => setCreatedToken('')}>Dismiss and clear</button></div></div></section></div>}

    {tab === 'setup' && <div className="console-grid">
      <div className="card console-card setup-card"><div className="console-heading"><div><div className="eyebrow">Selected project</div><h3>Use this UUID in tool arguments</h3><p>Choose a project in the Projects tab; configs never include a personal access token.</p></div></div><div className="project-id"><span>{projectLabel(selectedProject)}</span>{selectedProject && <button className="button button-secondary button-small" onClick={() => void handleCopy(selectedProject.id, 'project')}>{copied === 'project' ? <Check size={13} /> : <Copy size={13} />}{copied === 'project' ? 'Copied' : 'Copy UUID'}</button>}</div><div className="alert"><Terminal size={14} /><span>Controlled pilot: use <code>export MEMOCEAN_TOKEN="…"</code> in your shell, then configure your client. Environment interpolation has not been integration-certified for these clients.</span></div></div>
      <SetupSnippet title="Claude Code · .mcp.json" value={snippets.claude} target="claude" copied={copied} onCopy={handleCopy} />
      <SetupSnippet title="Cursor · MCP configuration" value={snippets.cursor} target="cursor" copied={copied} onCopy={handleCopy} />
      <SetupSnippet title="Codex CLI · config.toml" value={snippets.codex} target="codex" copied={copied} onCopy={handleCopy} />
    </div>}

    {tab === 'projects' && <div className="console-grid">
      <div className="card console-card"><div className="console-heading"><div><div className="eyebrow">Project context</div><h3>Choose the active project</h3><p>The current project determines the UUID shown in setup guidance and defaults new token restrictions.</p></div></div>{projectsLoading ? <p className="field-help">Loading your projects…</p> : projects.length ? <div className="project-list">{projects.map((project) => <button type="button" className={`project-option ${selectedProjectId === project.id ? 'active' : ''}`} onClick={() => onSelectProject(project.id)} key={project.id}><span><strong>{project.name}</strong><small>{project.id}</small></span>{selectedProjectId === project.id && <Check size={15} />}</button>)}</div> : <p className="field-help">No projects yet.</p>}</div>
      <div className="card console-card"><div className="console-heading"><div><div className="eyebrow">New project</div><h3>Create a project</h3><p>This uses the same account and project state as the rest of the workspace.</p></div></div><form className="form-stack" onSubmit={(event) => void createProject(event)}><div className="field"><label htmlFor="console-project-name">Project name</label><input className="input" id="console-project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={120} required /></div><button className="button button-primary" disabled={creatingProject} type="submit"><Plus size={14} />{creatingProject ? 'Creating…' : 'Create project'}</button></form></div>
    </div>}
  </section>;
}

function SetupSnippet({ title, value, target, copied, onCopy }: { title: string; value: string; target: Exclude<CopyTarget, null>; copied: CopyTarget; onCopy: (value: string, target: Exclude<CopyTarget, null>) => Promise<void> }) {
  return <article className="card console-card setup-snippet"><div className="console-heading"><h3>{title}</h3><button className="button button-secondary button-small" onClick={() => void onCopy(value, target)}>{copied === target ? <Check size={13} /> : <Copy size={13} />}{copied === target ? 'Copied' : 'Copy'}</button></div><pre className="code-block">{value}</pre></article>;
}
