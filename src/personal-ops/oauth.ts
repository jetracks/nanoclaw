import { createHash, randomBytes } from 'crypto';

import { PersonalOpsProvider } from '../types.js';
import { PersonalOpsSecrets } from './secrets.js';

export interface OAuthProviderConfig {
  provider: PersonalOpsProvider;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  audience?: string;
  scopeParam?: 'scope' | 'user_scope';
  scopeSeparator?: ' ' | ',';
  tokenResponseMode?: 'standard' | 'slack_user';
}

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string[];
  raw: Record<string, unknown>;
}

export function getOAuthProviderConfig(
  provider: PersonalOpsProvider,
  secrets: PersonalOpsSecrets,
): OAuthProviderConfig {
  switch (provider) {
    case 'google':
      return {
        provider,
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: [
          'openid',
          'email',
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
      };
    case 'microsoft':
      return {
        provider,
        authorizeUrl: `https://login.microsoftonline.com/${secrets.MICROSOFT_TENANT_ID || 'common'}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${secrets.MICROSOFT_TENANT_ID || 'common'}/oauth2/v2.0/token`,
        scopes: [
          'openid',
          'profile',
          'email',
          'offline_access',
          'User.Read',
          'Mail.Read',
          'Calendars.Read',
        ],
      };
    case 'jira':
      return {
        provider,
        authorizeUrl: 'https://auth.atlassian.com/authorize',
        tokenUrl: 'https://auth.atlassian.com/oauth/token',
        audience: 'api.atlassian.com',
        scopes: ['offline_access', 'read:jira-user', 'read:jira-work'],
      };
    case 'slack':
      return {
        provider,
        authorizeUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        scopeParam: 'user_scope',
        scopeSeparator: ',',
        tokenResponseMode: 'slack_user',
        scopes: [
          'channels:read',
          'groups:read',
          'im:read',
          'mpim:read',
          'channels:history',
          'groups:history',
          'im:history',
          'mpim:history',
          'users:read',
          'team:read',
        ],
      };
  }
}

export function buildOAuthRedirectUri(
  appBaseUrl: string,
  provider: PersonalOpsProvider,
): string {
  const url = new URL(`/oauth/${provider}/callback`, appBaseUrl);
  return url.toString();
}

export function createPkcePair(): {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
} {
  const state = randomBytes(24).toString('hex');
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { state, codeVerifier, codeChallenge };
}

function getProviderClientId(
  provider: PersonalOpsProvider,
  secrets: PersonalOpsSecrets,
): string {
  switch (provider) {
    case 'google':
      return secrets.GOOGLE_CLIENT_ID || '';
    case 'microsoft':
      return secrets.MICROSOFT_CLIENT_ID || '';
    case 'jira':
      return secrets.JIRA_CLIENT_ID || '';
    case 'slack':
      return secrets.SLACK_CLIENT_ID || '';
  }
}

function getProviderClientSecret(
  provider: PersonalOpsProvider,
  secrets: PersonalOpsSecrets,
): string {
  switch (provider) {
    case 'google':
      return secrets.GOOGLE_CLIENT_SECRET || '';
    case 'microsoft':
      return secrets.MICROSOFT_CLIENT_SECRET || '';
    case 'jira':
      return secrets.JIRA_CLIENT_SECRET || '';
    case 'slack':
      return secrets.SLACK_CLIENT_SECRET || '';
  }
}

function parseScopeList(
  value: unknown,
  fallback: string[],
  separator: ' ' | ',' = ' ',
): string[] {
  if (typeof value !== 'string') return fallback;
  const pattern = separator === ',' ? /[\s,]+/ : /\s+/;
  return value
    .split(pattern)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function buildAuthorizeUrl(input: {
  provider: PersonalOpsProvider;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  secrets: PersonalOpsSecrets;
}): string {
  const config = getOAuthProviderConfig(input.provider, input.secrets);
  const clientId = getProviderClientId(input.provider, input.secrets);
  if (!clientId) {
    throw new Error(`Missing client id for ${input.provider}.`);
  }

  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set(
    config.scopeParam || 'scope',
    config.scopes.join(config.scopeSeparator || ' '),
  );
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  if (input.provider === 'google') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
  } else if (input.provider === 'jira') {
    url.searchParams.set('audience', config.audience || 'api.atlassian.com');
    url.searchParams.set('prompt', 'consent');
  }

  return url.toString();
}

export async function exchangeAuthCode(input: {
  provider: PersonalOpsProvider;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  secrets: PersonalOpsSecrets;
}): Promise<OAuthTokenResponse> {
  const config = getOAuthProviderConfig(input.provider, input.secrets);
  const clientId = getProviderClientId(input.provider, input.secrets);
  const clientSecret = getProviderClientSecret(input.provider, input.secrets);

  const body = new URLSearchParams();
  body.set('code', input.code);
  body.set('redirect_uri', input.redirectUri);
  body.set('client_id', clientId);
  if (input.provider !== 'slack') {
    body.set('grant_type', 'authorization_code');
  }
  body.set('code_verifier', input.codeVerifier);
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `OAuth token exchange failed for ${input.provider}: ${response.status} ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  if (config.tokenResponseMode === 'slack_user') {
    if (payload.ok === false) {
      throw new Error(
        `OAuth token exchange failed for ${input.provider}: ${String(payload.error || 'unknown_error')}`,
      );
    }
    const authedUser =
      payload.authed_user && typeof payload.authed_user === 'object'
        ? (payload.authed_user as Record<string, unknown>)
        : null;
    const expiresIn =
      typeof authedUser?.expires_in === 'number'
        ? authedUser.expires_in
        : typeof authedUser?.expires_in === 'string'
          ? parseInt(authedUser.expires_in, 10)
          : null;
    return {
      accessToken:
        typeof authedUser?.access_token === 'string'
          ? authedUser.access_token
          : '',
      refreshToken:
        typeof authedUser?.refresh_token === 'string'
          ? authedUser.refresh_token
          : null,
      expiresAt:
        expiresIn && !Number.isNaN(expiresIn)
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : null,
      scope: parseScopeList(
        authedUser?.scope,
        config.scopes,
        config.scopeSeparator || ' ',
      ),
      raw: payload,
    };
  }
  const expiresIn =
    typeof payload.expires_in === 'number'
      ? payload.expires_in
      : typeof payload.expires_in === 'string'
        ? parseInt(payload.expires_in, 10)
        : null;
  return {
    accessToken: String(payload.access_token || ''),
    refreshToken:
      typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    expiresAt:
      expiresIn && !Number.isNaN(expiresIn)
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null,
    scope:
      parseScopeList(payload.scope, config.scopes, config.scopeSeparator || ' '),
    raw: payload,
  };
}

export async function refreshAccessToken(input: {
  provider: PersonalOpsProvider;
  refreshToken: string;
  secrets: PersonalOpsSecrets;
}): Promise<OAuthTokenResponse> {
  const config = getOAuthProviderConfig(input.provider, input.secrets);
  const clientId = getProviderClientId(input.provider, input.secrets);
  const clientSecret = getProviderClientSecret(input.provider, input.secrets);

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', input.refreshToken);
  body.set('client_id', clientId);
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `OAuth token refresh failed for ${input.provider}: ${response.status} ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  if (config.tokenResponseMode === 'slack_user') {
    if (payload.ok === false) {
      throw new Error(
        `OAuth token refresh failed for ${input.provider}: ${String(payload.error || 'unknown_error')}`,
      );
    }
    const authedUser =
      payload.authed_user && typeof payload.authed_user === 'object'
        ? (payload.authed_user as Record<string, unknown>)
        : payload;
    const expiresIn =
      typeof authedUser.expires_in === 'number'
        ? authedUser.expires_in
        : typeof authedUser.expires_in === 'string'
          ? parseInt(authedUser.expires_in, 10)
          : null;
    return {
      accessToken:
        typeof authedUser.access_token === 'string'
          ? authedUser.access_token
          : '',
      refreshToken:
        typeof authedUser.refresh_token === 'string'
          ? authedUser.refresh_token
          : input.refreshToken,
      expiresAt:
        expiresIn && !Number.isNaN(expiresIn)
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : null,
      scope: parseScopeList(
        authedUser.scope,
        config.scopes,
        config.scopeSeparator || ' ',
      ),
      raw: payload,
    };
  }
  const expiresIn =
    typeof payload.expires_in === 'number'
      ? payload.expires_in
      : typeof payload.expires_in === 'string'
        ? parseInt(payload.expires_in, 10)
        : null;
  return {
    accessToken: String(payload.access_token || ''),
    refreshToken:
      typeof payload.refresh_token === 'string'
        ? payload.refresh_token
        : input.refreshToken,
    expiresAt:
      expiresIn && !Number.isNaN(expiresIn)
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null,
    scope:
      parseScopeList(payload.scope, config.scopes, config.scopeSeparator || ' '),
    raw: payload,
  };
}
