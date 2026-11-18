import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpConfig, scanSensitiveText } from '../src/index.js';

test('local scan passes ordinary text and blocks known secret/PII patterns without revealing matches', () => {
  assert.deepEqual(scanSensitiveText('A reviewed note about deployment checks.'), { ok: true, reasons: [] });
  const result = scanSensitiveText('password=not-a-real-secret-value-12345');
  assert.equal(result.ok, false);
  assert.equal(result.reasons.includes('possible-secret-or-pii'), true);
  assert.equal(result.reasons.join(' ').includes('not-a-real-secret-value'), false);
});

test('MCP config is emitted with an environment placeholder, never an actual credential', () => {
  assert.deepEqual(buildMcpConfig('https://api.example.test'), {
    mcpServers: {
      memocean: {
        type: 'http',
        url: 'https://api.example.test/mcp',
        headers: { Authorization: 'Bearer ${MEMOCEAN_TOKEN}' },
      },
    },
  });
});

test('MCP config rejects non-TLS public URLs and embedded credentials', () => {
  assert.throws(() => buildMcpConfig('http://api.example.test'), /HTTPS origin/);
  assert.throws(() => buildMcpConfig('https://name:password@api.example.test'), /HTTPS origin/);
  assert.doesNotThrow(() => buildMcpConfig('http://localhost:3000'));
});
