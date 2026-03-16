import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  getCredentialProxyAuthToken,
  startCredentialProxy,
} from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let lastUpstreamUrl = '';

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamUrl = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('injects Authorization and strips placeholder credentials', async () => {
    proxyPort = await startProxy({ OPENAI_API_KEY: 'sk-openai-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/responses',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
          'x-nanoclaw-proxy-token': getCredentialProxyAuthToken(),
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer sk-openai-real-key',
    );
  });

  it('injects organization and project headers when configured', async () => {
    proxyPort = await startProxy({
      OPENAI_API_KEY: 'sk-openai-real-key',
      OPENAI_ORGANIZATION: 'org_123',
      OPENAI_PROJECT: 'proj_456',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/responses',
        headers: {
          'content-type': 'application/json',
          'x-nanoclaw-proxy-token': getCredentialProxyAuthToken(),
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['openai-organization']).toBe('org_123');
    expect(lastUpstreamHeaders['openai-project']).toBe('proj_456');
  });

  it('forwards request path relative to the configured base URL', async () => {
    proxyPort = await startProxy({
      OPENAI_API_KEY: 'sk-openai-real-key',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/responses',
        headers: {
          'content-type': 'application/json',
          'x-nanoclaw-proxy-token': getCredentialProxyAuthToken(),
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['host']).toBe(`127.0.0.1:${upstreamPort}`);
    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer sk-openai-real-key',
    );
    expect(lastUpstreamUrl).toBe('/v1/responses');
  });

  it('preserves custom upstream path prefixes', async () => {
    Object.assign(mockEnv, {
      OPENAI_API_KEY: 'sk-openai-real-key',
      OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/custom/prefix/v1`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/responses',
        headers: {
          'content-type': 'application/json',
          'x-nanoclaw-proxy-token': getCredentialProxyAuthToken(),
        },
      },
      '{}',
    );

    expect(lastUpstreamUrl).toBe('/custom/prefix/v1/responses');
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ OPENAI_API_KEY: 'sk-openai-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/responses',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
          'x-nanoclaw-proxy-token': getCredentialProxyAuthToken(),
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      OPENAI_API_KEY: 'sk-openai-real-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:59999/v1',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/responses',
        headers: {
          'content-type': 'application/json',
          'x-nanoclaw-proxy-token': getCredentialProxyAuthToken(),
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('rejects requests without the internal proxy token', async () => {
    proxyPort = await startProxy({ OPENAI_API_KEY: 'sk-openai-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/responses',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('Forbidden');
  });

  it('requires OPENAI_API_KEY', async () => {
    await expect(startProxy({})).rejects.toThrow(/OPENAI_API_KEY is required/);
  });
});
