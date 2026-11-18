import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeveloperConsole } from '../src/DeveloperConsole';
import type { Project, Session } from '../src/types';

const session: Session = {
  token: `mo_session_${'s'.repeat(43)}`,
  user_id: 'user-1',
  tenant_id: 'tenant-1',
  project_id: 'project-1',
  address: '0x1111111111111111111111111111111111111111',
  expires_at: '2026-12-01T00:00:00.000Z',
};
const project: Project = { id: 'project-1', name: 'Console project', created_at: '2026-11-19T00:00:00.000Z' };

function renderConsole() {
  return render(<DeveloperConsole
    session={session}
    projects={[project]}
    selectedProjectId={project.id}
    projectsLoading={false}
    onSelectProject={vi.fn()}
    onCreateProject={vi.fn().mockResolvedValue(true)}
  />);
}

afterEach(cleanup);

describe('DeveloperConsole', () => {
  it('shows a newly created PAT once and clears plaintext on dismiss', async () => {
    const plainToken = `mo_pat_${'p'.repeat(43)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'key-1', name: 'local client', prefix: 'mo_pat_example', scopes: ['memory:read'], project_ids: ['project-1'],
        created_at: '2026-11-19T00:00:00.000Z', expires_at: '2026-12-19T00:00:00.000Z', last_used_at: null, revoked_at: null,
        token: plainToken, displayed_once: true,
      }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    renderConsole();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(screen.getByRole('dialog', { name: 'Create an API key' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'local client' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Create an API key' })).getByRole('button', { name: 'Create token' }));

    expect(await screen.findByText(plainToken)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss and clear' }));
    expect(screen.queryByText(plainToken)).not.toBeInTheDocument();
  });

  it('renders pilot MCP setup without placing a PAT in client snippets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 })));
    renderConsole();
    fireEvent.click(screen.getByRole('tab', { name: 'MCP & CLI Setup' }));

    expect(await screen.findByText('Claude Code · .mcp.json')).toBeInTheDocument();
    expect(screen.getByText(/Controlled pilot: use/)).toBeInTheDocument();
    expect(screen.getAllByText(/http:\/\/localhost:3000\/mcp/).length).toBe(3);
    expect(screen.getAllByText(/MEMOCEAN_TOKEN/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/mo_pat_pppp/)).not.toBeInTheDocument();
  });
});
