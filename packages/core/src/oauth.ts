import type {
  ProviderName,
  OAuthConfig,
  OAuthTokens,
  DeviceCodeResponse,
  OAuthStateData,
  OAuthFlowType,
} from './types.js';
import { StorageAdapter } from './storage.js';
import { AuthError, ProviderError } from './types.js';

export class OAuthManager {
  constructor(private storage: StorageAdapter) {}

  // Convert a stored per-account OAuthClient into an OAuthConfig for flows.
  static clientToConfig(client: { provider: ProviderName; clientId: string; clientSecret: string; scopes: string[]; tenantId?: string; accountsServer?: string }, redirectUri: string): OAuthConfig {
    return {
      provider: client.provider,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri,
      scopes: client.scopes,
      tenantId: client.tenantId,
      accountsServer: client.accountsServer,
    };
  }

  async startFlow(
    provider: ProviderName,
    flowType: OAuthFlowType,
    config: OAuthConfig
  ): Promise<DeviceCodeResponse & { state: string; codeVerifier: string }> {
    const state = crypto.randomUUID();
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = await this.generateCodeChallenge(codeVerifier);

    const oauthState: OAuthStateData = {
      provider,
      flowType,
      codeVerifier,
      redirectUri: config.redirectUri,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tenantId: config.tenantId,
      accountsServer: config.accountsServer,
      createdAt: Date.now(),
    };

    await this.storage.saveOAuthState(state, oauthState);

    switch (provider) {
      case 'google':
        return this.startGoogleFlow(config, flowType, state, codeChallenge);
      case 'microsoft':
        return this.startMicrosoftFlow(config, flowType, state, codeChallenge);
      case 'zoho':
        return this.startZohoFlow(config, flowType, state, codeChallenge);
      default:
        throw new AuthError(`Unsupported provider for OAuth: ${provider}`);
    }
  }

  async completeFlow(state: string, code: string): Promise<OAuthTokens> {
    const saved = await this.storage.getOAuthState(state);
    if (!saved) {
      throw new AuthError('Invalid or expired OAuth state');
    }

    const config: OAuthConfig = {
      provider: saved.provider,
      clientId: saved.clientId,
      clientSecret: saved.clientSecret || '',
      redirectUri: saved.redirectUri || '',
      scopes: this.getDefaultScopes(saved.provider),
      tenantId: saved.tenantId,
      accountsServer: saved.accountsServer,
    };

    const tokens = await this.exchangeCode(config, saved, code);

    await this.storage.deleteOAuthState(state);
    return tokens;
  }

  async refreshToken(provider: ProviderName, accountId: string, clientId: string, clientSecret?: string): Promise<OAuthTokens> {
    const credentials = await this.storage.getCredentials(accountId);
    if (!credentials?.refreshToken) {
      throw new AuthError('No refresh token available');
    }

    const config: OAuthConfig = {
      provider,
      clientId,
      clientSecret: clientSecret || '',
      redirectUri: '',
      scopes: this.getDefaultScopes(provider),
    };

    return this.exchangeRefreshToken(config, credentials.refreshToken);
  }

  async pollDeviceCode(
    deviceCode: string,
    interval: number,
    config: OAuthConfig,
    maxAttempts = 60
  ): Promise<OAuthTokens> {
    const tokenUrl = this.getTokenUrl(config.provider, config.tenantId);
    const checkInterval = Math.max(interval * 1000, 5000);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const body: Record<string, string> = {
          client_id: config.clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        };
        if (config.clientSecret) {
          body.client_secret = config.clientSecret;
        }

        const response = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(body).toString(),
        });

        const data: any = await response.json();

        if (response.ok) {
          return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: Date.now() + data.expires_in * 1000,
            scope: data.scope || config.scopes.join(' '),
            idToken: data.id_token,
            tokenType: data.token_type || 'Bearer',
          };
        }

        if (data.error === 'authorization_pending') {
          await this.sleep(checkInterval);
          continue;
        }
        if (data.error === 'slow_down') {
          await this.sleep(checkInterval * 2);
          continue;
        }

        throw new AuthError(`OAuth error: ${data.error} - ${data.error_description || ''}`);
      } catch (error) {
        if (error instanceof AuthError) throw error;
        await this.sleep(checkInterval);
      }
    }

    throw new AuthError('Device code flow timed out');
  }

  private async startGoogleFlow(
    config: OAuthConfig,
    flowType: OAuthFlowType,
    state: string,
    codeChallenge: string
  ): Promise<DeviceCodeResponse & { state: string; codeVerifier: string }> {
    if (flowType === 'device_code') {
      const response = await fetch('https://oauth2.googleapis.com/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          scope: config.scopes.join(' '),
        }).toString(),
      });

      if (!response.ok) {
        throw new AuthError('Failed to initiate Google device flow');
      }

      const data: any = await response.json();
      return { ...data, state, codeVerifier: '' };
    }

    // Authorization code flow
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', config.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', config.scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    return {
      deviceCode: '',
      userCode: '',
      verificationUri: authUrl.toString(),
      expiresIn: 0,
      interval: 0,
      state,
      codeVerifier: '',
    };
  }

  private async startMicrosoftFlow(
    config: OAuthConfig,
    flowType: OAuthFlowType,
    state: string,
    codeChallenge: string
  ): Promise<DeviceCodeResponse & { state: string; codeVerifier: string }> {
    const tenant = config.tenantId || 'common';

    if (flowType === 'device_code') {
      const response = await fetch(
        `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.clientId,
            scope: config.scopes.join(' '),
          }).toString(),
        }
      );

      if (!response.ok) {
        throw new AuthError('Failed to initiate Microsoft device flow');
      }

      const data: any = await response.json();
      return { ...data, state, codeVerifier: '' };
    }

    // Authorization code flow
    const authUrl = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', config.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', config.scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('prompt', 'consent');

    return {
      deviceCode: '',
      userCode: '',
      verificationUri: authUrl.toString(),
      expiresIn: 0,
      interval: 0,
      state,
      codeVerifier: '',
    };
  }

  private async startZohoFlow(
    config: OAuthConfig,
    flowType: OAuthFlowType,
    state: string,
    codeChallenge: string
  ): Promise<DeviceCodeResponse & { state: string; codeVerifier: string }> {
    const accountsServer = config.accountsServer || 'accounts.zoho.com';

    if (flowType === 'device_code') {
      throw new AuthError('Zoho does not support device code flow');
    }

    const authUrl = new URL(`https://${accountsServer}/oauth/v2/auth`);
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', config.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', config.scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    return {
      deviceCode: '',
      userCode: '',
      verificationUri: authUrl.toString(),
      expiresIn: 0,
      interval: 0,
      state,
      codeVerifier: '',
    };
  }

  private async exchangeCode(config: OAuthConfig, saved: OAuthStateData, code: string): Promise<OAuthTokens> {
    const tokenUrl = this.getTokenUrl(config.provider, config.tenantId);
    const body: Record<string, string> = {
      client_id: config.clientId,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code_verifier: saved.codeVerifier,
    };
    if (config.clientSecret) {
      body.client_secret = config.clientSecret;
    }

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });

    const data: any = await response.json();

    if (!response.ok) {
      throw new AuthError(`Token exchange failed: ${data.error} - ${data.error_description || ''}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope || config.scopes.join(' '),
      idToken: data.id_token,
      tokenType: data.token_type || 'Bearer',
    };
  }

  private async exchangeRefreshToken(config: OAuthConfig, refreshToken: string): Promise<OAuthTokens> {
    const tokenUrl = this.getTokenUrl(config.provider, config.tenantId);
    const body: Record<string, string> = {
      client_id: config.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    };
    if (config.clientSecret) {
      body.client_secret = config.clientSecret;
    }

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });

    const data: any = await response.json();

    if (!response.ok) {
      throw new AuthError(`Token refresh failed: ${data.error} - ${data.error_description || ''}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope || config.scopes.join(' '),
      idToken: data.id_token,
      tokenType: data.token_type || 'Bearer',
    };
  }

  private getTokenUrl(provider: ProviderName, tenantId?: string): string {
    switch (provider) {
      case 'google':
        return 'https://oauth2.googleapis.com/token';
      case 'microsoft':
        return `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/token`;
      case 'zoho':
        return `https://${zohoOAuthConfig.accountsServer || 'accounts.zoho.com'}/oauth/v2/token`;
      default:
        throw new ProviderError(`Unknown provider: ${provider}`, provider);
    }
  }

  private getDefaultScopes(provider: ProviderName): string[] {
    switch (provider) {
      case 'google':
        return [
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/contacts',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
        ];
      case 'microsoft':
        return [
          'offline_access',
          'https://graph.microsoft.com/Mail.ReadWrite',
          'https://graph.microsoft.com/Mail.Send',
          'https://graph.microsoft.com/Calendars.ReadWrite',
          'https://graph.microsoft.com/Contacts.ReadWrite',
          'https://graph.microsoft.com/User.Read',
        ];
      case 'zoho':
        return [
          'ZohoMail.messages.ALL',
          'ZohoCalendar.events.ALL',
          'ZohoContacts.contacts.ALL',
          'ZohoMail.accounts.READ',
        ];
      default:
        return [];
    }
  }

  private generateCodeVerifier(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return this.base64URLEncode(array);
  }

  private async generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return this.base64URLEncode(new Uint8Array(digest));
  }

  private base64URLEncode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Config for Zoho token URL
const zohoOAuthConfig: OAuthConfig = { provider: 'zoho', clientId: '', clientSecret: '', redirectUri: '', scopes: [], accountsServer: 'accounts.zoho.com' };