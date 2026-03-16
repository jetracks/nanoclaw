/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the OpenAI API.
 * The proxy injects real credentials so containers never see them.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const CREDENTIAL_PROXY_AUTH_HEADER = 'x-nanoclaw-proxy-token';
const credentialProxyAuthToken = randomBytes(32).toString('hex');

export function getCredentialProxyAuthToken(): string {
  return credentialProxyAuthToken;
}

function hasValidCredentialProxyAuth(
  headerValue: string | string[] | undefined,
): boolean {
  const provided = Array.isArray(headerValue)
    ? headerValue[0] || ''
    : headerValue || '';
  if (!provided) {
    return false;
  }
  const expected = Buffer.from(credentialProxyAuthToken, 'utf8');
  const candidate = Buffer.from(provided, 'utf8');
  if (candidate.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(candidate, expected);
}

function buildUpstreamPath(
  reqUrl: string | undefined,
  upstreamUrl: URL,
): string {
  const incomingUrl = new URL(reqUrl || '/', 'http://127.0.0.1');
  const upstreamBasePath = upstreamUrl.pathname.replace(/\/$/, '');

  let relativePath = incomingUrl.pathname;
  if (relativePath === '/v1') {
    relativePath = '';
  } else if (relativePath.startsWith('/v1/')) {
    relativePath = relativePath.slice('/v1'.length);
  }

  const pathname = `${upstreamBasePath}${relativePath}` || '/';
  return `${pathname}${incomingUrl.search}`;
}

const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 30_000;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === 'host.docker.internal'
  );
}

function validateUpstreamUrl(url: URL): void {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported OPENAI_BASE_URL protocol "${url.protocol}"`);
  }

  if (
    url.protocol === 'http:' &&
    !isLoopbackHost(url.hostname) &&
    process.env.ALLOW_INSECURE_OPENAI_BASE_URL !== 'true'
  ) {
    throw new Error(
      'Refusing to proxy secrets to a non-loopback HTTP OPENAI_BASE_URL. Use HTTPS or set ALLOW_INSECURE_OPENAI_BASE_URL=true to override.',
    );
  }
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT',
  ]);

  if (!secrets.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is required to start the NanoClaw credential proxy.',
    );
  }

  const upstreamUrl = new URL(
    secrets.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  );
  validateUpstreamUrl(upstreamUrl);
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (
        !hasValidCredentialProxyAuth(req.headers[CREDENTIAL_PROXY_AUTH_HEADER])
      ) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const chunks: Buffer[] = [];
      let bodyBytes = 0;
      let requestTooLarge = false;

      req.setTimeout(PROXY_TIMEOUT_MS, () => {
        req.destroy(new Error('Credential proxy request timeout'));
      });

      req.on('data', (c: Buffer) => {
        bodyBytes += c.length;
        if (bodyBytes > MAX_PROXY_BODY_BYTES) {
          requestTooLarge = true;
          chunks.length = 0;
          req.removeAllListeners('data');
          req.removeAllListeners('end');
          if (!res.headersSent) {
            res.writeHead(413);
            res.end('Payload Too Large');
          }
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on('error', (err) => {
        logger.warn({ err, url: req.url }, 'Credential proxy request error');
        if (!res.headersSent) {
          res.writeHead(requestTooLarge ? 413 : 400);
          res.end(requestTooLarge ? 'Payload Too Large' : 'Bad Request');
        }
      });
      req.on('end', () => {
        if (requestTooLarge) {
          if (!res.headersSent) {
            res.writeHead(413);
            res.end('Payload Too Large');
          }
          return;
        }

        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['proxy-authorization'];
        delete headers['proxy-connection'];
        delete headers['te'];
        delete headers['trailer'];
        delete headers['transfer-encoding'];
        delete headers['upgrade'];
        delete headers['authorization'];
        delete headers[CREDENTIAL_PROXY_AUTH_HEADER];
        headers['authorization'] = `Bearer ${secrets.OPENAI_API_KEY}`;
        if (secrets.OPENAI_ORGANIZATION) {
          headers['openai-organization'] = secrets.OPENAI_ORGANIZATION;
        }
        if (secrets.OPENAI_PROJECT) {
          headers['openai-project'] = secrets.OPENAI_PROJECT;
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: buildUpstreamPath(req.url, upstreamUrl),
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.setTimeout(PROXY_TIMEOUT_MS, () => {
          upstream.destroy(new Error('Credential proxy upstream timeout'));
        });

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            const statusCode =
              err instanceof Error &&
              err.message === 'Credential proxy upstream timeout'
                ? 504
                : 502;
            res.writeHead(statusCode);
            res.end(statusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
