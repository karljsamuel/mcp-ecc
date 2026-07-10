import axios from 'axios';
import { TokenStorage, AccountCredentials } from './storage.js';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export class HeadlessAuthManager {
  static async initiateDeviceFlow(
    provider: 'google' | 'microsoft',
    clientId: string,
    tenantId = 'common'
  ): Promise<DeviceCodeResponse> {
    if (!clientId) {
      throw new Error(`clientId is required to initiate ${provider} device flow.`);
    }

    if (provider === 'google') {
      const response = await axios.post(
        'https://oauth2.googleapis.com/device/code',
        new URLSearchParams({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/contacts'
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      
      return response.data;
    } else {
      const tenant = tenantId || 'common';
      const response = await axios.post(
        `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`,
        new URLSearchParams({
          client_id: clientId,
          scope: 'offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Contacts.ReadWrite'
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      
      return response.data;
    }
  }

  static async pollForTokens(
    provider: 'google' | 'microsoft',
    deviceCode: string,
    interval: number,
    clientId: string,
    clientSecret?: string,
    tenantId = 'common'
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }> {
    const tokenUrl =
      provider === 'google'
        ? 'https://oauth2.googleapis.com/token'
        : `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/token`;

    const checkInterval = interval * 1000 || 5000;
    
    return new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const body: Record<string, string> = {
            client_id: clientId,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          };
          if (clientSecret) {
            body.client_secret = clientSecret;
          }

          const response = await axios.post(
            tokenUrl,
            new URLSearchParams(body).toString(),
            {
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              validateStatus: () => true // Handle 400 errors like 'authorization_pending' manually
            }
          );

          if (response.status === 200) {
            clearInterval(timer);
            const data = response.data;
            resolve({
              accessToken: data.access_token,
              refreshToken: data.refresh_token,
              expiresAt: Date.now() + data.expires_in * 1000
            });
          } else if (response.data && response.data.error) {
            const err = response.data.error;
            if (err === 'authorization_pending') {
              // Still waiting, continue polling
              return;
            }
            clearInterval(timer);
            reject(new Error(`OAuth Provider Error: ${err} - ${response.data.error_description}`));
          } else {
            clearInterval(timer);
            reject(new Error(`Unexpected status code: ${response.status}`));
          }
        } catch (error: any) {
          clearInterval(timer);
          reject(error);
        }
      }, checkInterval);
    });
  }

  static async refreshAccessToken(account: AccountCredentials): Promise<string> {
    const { provider, tokens } = account;
    if (!tokens.refreshToken) {
      throw new Error(`No refresh token available for account ${account.accountId}`);
    }
    if (!tokens.clientId) {
      throw new Error(`No clientId configured in storage for account ${account.accountId}`);
    }

    if (provider === 'google') {
      const response = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          client_id: tokens.clientId,
          client_secret: tokens.clientSecret || '',
          refresh_token: tokens.refreshToken,
          grant_type: 'refresh_token'
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      
      const newTokens = {
        ...tokens,
        accessToken: response.data.access_token,
        expiryDate: Date.now() + response.data.expires_in * 1000
      };
      
      TokenStorage.saveAccount({
        ...account,
        tokens: newTokens
      });
      return response.data.access_token;
    } else if (provider === 'microsoft') {
      const tenant = tokens.tenantId || 'common';
      const body: Record<string, string> = {
        client_id: tokens.clientId,
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token'
      };
      if (tokens.clientSecret) {
        body.client_secret = tokens.clientSecret;
      }

      const response = await axios.post(
        `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        new URLSearchParams(body).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const newTokens = {
        ...tokens,
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token || tokens.refreshToken,
        expiryDate: Date.now() + response.data.expires_in * 1000
      };
      
      TokenStorage.saveAccount({
        ...account,
        tokens: newTokens
      });
      return response.data.access_token;
    } else if (provider === 'zoho') {
      const body: Record<string, string> = {
        client_id: tokens.clientId,
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token'
      };
      if (tokens.clientSecret) {
        body.client_secret = tokens.clientSecret;
      }

      const response = await axios.post(
        'https://accounts.zoho.com/oauth/v2/token',
        new URLSearchParams(body).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const newTokens = {
        ...tokens,
        accessToken: response.data.access_token,
        expiryDate: Date.now() + response.data.expires_in * 1000
      };

      TokenStorage.saveAccount({
        ...account,
        tokens: newTokens
      });
      return response.data.access_token;
    }

    throw new Error(`Auto-refresh not implemented or unsupported for provider: ${provider}`);
  }
}
