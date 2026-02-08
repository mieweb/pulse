import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import * as Application from 'expo-application';
import axios from 'axios';

/**
 * AuthService - Handles OAuth 2.0 authentication with PKCE (Proof Key for Code Exchange)
 * 
 * PKCE Flow:
 * 1. Generate code_verifier (random string)
 * 2. Create code_challenge (SHA256 hash of code_verifier)
 * 3. Send code_challenge to authorization server
 * 4. Exchange authorization code + code_verifier for tokens
 */
class AuthService {
  constructor() {
    // Secure storage keys
    this.VAULT_URL_KEY = 'vaultUrl';
    this.CODE_VERIFIER_KEY = 'codeVerifier';
    this.STATE_KEY = 'authState';
    this.ACCESS_TOKEN_KEY = 'accessToken';
    this.REFRESH_TOKEN_KEY = 'refreshToken';
    this.TOKEN_EXPIRY_KEY = 'tokenExpiry';
    this.DEVICE_ID_KEY = 'deviceId';
    
    // OAuth configuration
    this.CLIENT_ID = 'pulse-mobile';
    this.REDIRECT_URI = 'pulsecam://auth/callback';
  }
  /**
   * Convert ArrayBuffer or base64 string to base64url format
   * Base64url is like base64 but URL-safe (no +, /, or = characters)
   * 
   * @param {ArrayBuffer|string} input - The data to encode
   * @returns {string} Base64url encoded string
   */
  base64URLEncode(input) {
    let base64String;
    
    // If input is ArrayBuffer, convert to base64 first
    if (input instanceof ArrayBuffer) {
      const uint8Array = new Uint8Array(input);
      const binaryString = String.fromCharCode(...uint8Array);
      base64String = btoa(binaryString);
    } else {
      // Input is already a base64 string
      base64String = input;
    }
    
    // Convert base64 to base64url format
    return base64String
      .replace(/\+/g, '-')  // Replace + with -
      .replace(/\//g, '_')  // Replace / with _
      .replace(/=/g, '');   // Remove padding =
  }

  /**
   * Generate a cryptographically secure random code verifier
   * Code verifier is a random string of 43-128 characters
   * We use 32 bytes which becomes 43 characters after base64url encoding
   * 
   * @returns {Promise<string>} Base64url encoded code verifier
   */
  async generateCodeVerifier() {
    try {
      // Generate 32 cryptographically secure random bytes
      const randomBytes = await Crypto.getRandomBytesAsync(32);
      
      // Convert to base64url format
      const codeVerifier = this.base64URLEncode(randomBytes);
      
      console.log('✅ Generated code_verifier:', codeVerifier.substring(0, 20) + '...');
      
      return codeVerifier;
    } catch (error) {
      console.error('❌ Failed to generate code verifier:', error);
      throw new Error('Failed to generate code verifier: ' + error.message);
    }
  }

  /**
   * Generate code challenge from code verifier
   * Code challenge is the SHA256 hash of the code verifier, base64url encoded
   * 
   * @param {string} codeVerifier - The code verifier string
   * @returns {Promise<string>} Base64url encoded code challenge
   */
  async generateCodeChallenge(codeVerifier) {
    try {
      // Hash the code verifier using SHA256
      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        codeVerifier,
        { encoding: Crypto.CryptoEncoding.BASE64 }
      );
      
      // Convert base64 hash to base64url format
      const codeChallenge = this.base64URLEncode(hash);
      
      console.log('✅ Generated code_challenge:', codeChallenge.substring(0, 20) + '...');
      
      return codeChallenge;
    } catch (error) {
      console.error('❌ Failed to generate code challenge:', error);
      throw new Error('Failed to generate code challenge: ' + error.message);
    }
  }

  /**
   * Generate both code verifier and code challenge
   * Convenience method that generates both values needed for PKCE flow
   * 
   * @returns {Promise<{codeVerifier: string, codeChallenge: string}>} Object containing both codes
   */
  async generatePKCEPair() {
    try {
      console.log('🔐 Generating PKCE pair...');
      
      // Generate code verifier
      const codeVerifier = await this.generateCodeVerifier();
      
      // Generate code challenge from verifier
      const codeChallenge = await this.generateCodeChallenge(codeVerifier);
      
      console.log('✅ PKCE pair generated successfully');
      
      return {
        codeVerifier,
        codeChallenge,
        codeChallengeMethod: 'S256' // SHA256 method
      };
    } catch (error) {
      console.error('❌ Failed to generate PKCE pair:', error);
      throw new Error('Failed to generate PKCE pair: ' + error.message);
    }
  }

  /**
   * Verify PKCE implementation (for testing)
   * Generates a PKCE pair and logs the results
   * 
   * @returns {Promise<boolean>} True if verification succeeds
   */
  async verifyPKCEImplementation() {
    try {
      console.log('🧪 Testing PKCE implementation...');
      
      const { codeVerifier, codeChallenge, codeChallengeMethod } = await this.generatePKCEPair();
      
      console.log('📋 PKCE Test Results:');
      console.log('  code_verifier length:', codeVerifier.length);
      console.log('  code_challenge length:', codeChallenge.length);
      console.log('  code_challenge_method:', codeChallengeMethod);
      console.log('  code_verifier:', codeVerifier);
      console.log('  code_challenge:', codeChallenge);
      
      // Verify lengths are within spec
      const verifierValid = codeVerifier.length >= 43 && codeVerifier.length <= 128;
      const challengeValid = codeChallenge.length === 43; // SHA256 always produces 43 chars in base64url
      
      if (verifierValid && challengeValid) {
        console.log('✅ PKCE implementation verified successfully!');
        return true;
      } else {
        console.error('❌ PKCE verification failed - invalid lengths');
        return false;
      }
    } catch (error) {
      console.error('❌ PKCE verification failed:', error);
      return false;
    }
  }

  /**
   * Generate a random state parameter for OAuth
   * Used to prevent CSRF attacks
   * 
   * @returns {Promise<string>} Random state string
   */
  async generateState() {
    try {
      const randomBytes = await Crypto.getRandomBytesAsync(16);
      return this.base64URLEncode(randomBytes);
    } catch (error) {
      console.error('❌ Failed to generate state:', error);
      throw new Error('Failed to generate state: ' + error.message);
    }
  }

  /**
   * Store data securely using expo-secure-store
   * 
   * @param {string} key - Storage key
   * @param {string} value - Value to store
   */
  async securelyStore(key, value) {
    try {
      await SecureStore.setItemAsync(key, value);
      console.log(`✅ Securely stored: ${key}`);
    } catch (error) {
      console.error(`❌ Failed to store ${key}:`, error);
      throw new Error(`Failed to store ${key}: ` + error.message);
    }
  }

  /**
   * Retrieve data from secure storage
   * 
   * @param {string} key - Storage key
   * @returns {Promise<string|null>} Stored value or null
   */
  async securelyRetrieve(key) {
    try {
      const value = await SecureStore.getItemAsync(key);
      return value;
    } catch (error) {
      console.error(`❌ Failed to retrieve ${key}:`, error);
      return null;
    }
  }

  /**
   * Start OAuth 2.0 login flow with PKCE
   * 
   * @param {string} vaultUrl - The vault/backend URL (e.g., https://vault.example.com)
   * @returns {Promise<{success: boolean, code?: string, state?: string, error?: string}>}
   */
  async startLogin(vaultUrl) {
    try {
      console.log('🔐 Starting OAuth login flow...');
      console.log('📍 Vault URL:', vaultUrl);

      // Validate and normalize vault URL
      let normalizedUrl = vaultUrl.trim();
      if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
        normalizedUrl = 'https://' + normalizedUrl;
      }
      // Remove trailing slash
      normalizedUrl = normalizedUrl.replace(/\/$/, '');

      // Store vault URL securely
      await this.securelyStore(this.VAULT_URL_KEY, normalizedUrl);

      // Generate PKCE pair
      const { codeVerifier, codeChallenge } = await this.generatePKCEPair();
      
      // Store code verifier securely (needed later for token exchange)
      await this.securelyStore(this.CODE_VERIFIER_KEY, codeVerifier);

      // Generate random state parameter
      const state = await this.generateState();
      await this.securelyStore(this.STATE_KEY, state);

      // Build authorization URL
      const authorizationUrl = this.buildAuthorizationUrl(
        normalizedUrl,
        codeChallenge,
        state
      );

      console.log('🌐 Opening authorization URL...');
      console.log('🔗 URL:', authorizationUrl);

      // Open browser for OAuth authorization
      const result = await WebBrowser.openAuthSessionAsync(
        authorizationUrl,
        this.REDIRECT_URI
      );

      console.log('📱 Browser result:', result.type);

      // Handle browser result
      return await this.handleBrowserResult(result, state);

    } catch (error) {
      console.error('❌ Login failed:', error);
      return {
        success: false,
        error: error.message || 'Login failed'
      };
    }
  }

  /**
   * Build OAuth authorization URL with all required parameters
   * 
   * @param {string} vaultUrl - The vault/backend URL
   * @param {string} codeChallenge - The PKCE code challenge
   * @param {string} state - Random state parameter
   * @returns {string} Complete authorization URL
   */
  buildAuthorizationUrl(vaultUrl, codeChallenge, state) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.CLIENT_ID,
      redirect_uri: this.REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: state,
      // Optional: Add scope if needed
      // scope: 'openid profile email'
    });

    return `${vaultUrl}/oauth/authorize?${params.toString()}`;
  }

  /**
   * Handle the result from the browser OAuth flow
   * 
   * @param {object} result - Result from WebBrowser.openAuthSessionAsync
   * @param {string} expectedState - The state we sent with the request
   * @returns {Promise<{success: boolean, code?: string, state?: string, error?: string}>}
   */
  async handleBrowserResult(result, expectedState) {
    try {
      // Check if user cancelled
      if (result.type === 'cancel') {
        console.log('⚠️ User cancelled login');
        return {
          success: false,
          error: 'User cancelled login'
        };
      }

      // Check if login was dismissed
      if (result.type === 'dismiss') {
        console.log('⚠️ Login dismissed');
        return {
          success: false,
          error: 'Login dismissed'
        };
      }

      // Check for successful callback
      if (result.type === 'success' && result.url) {
        console.log('✅ Received callback URL');
        
        // Parse the callback URL
        const url = new URL(result.url);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        const errorDescription = url.searchParams.get('error_description');

        // Check for OAuth errors
        if (error) {
          console.error('❌ OAuth error:', error, errorDescription);
          return {
            success: false,
            error: errorDescription || error
          };
        }

        // Verify state to prevent CSRF
        if (state !== expectedState) {
          console.error('❌ State mismatch - possible CSRF attack');
          return {
            success: false,
            error: 'Invalid state parameter'
          };
        }

        // Verify we received the authorization code
        if (!code) {
          console.error('❌ No authorization code received');
          return {
            success: false,
            error: 'No authorization code received'
          };
        }

        console.log('✅ Authorization code received');
        return {
          success: true,
          code,
          state
        };
      }

      // Unexpected result type
      console.error('❌ Unexpected browser result:', result.type);
      return {
        success: false,
        error: 'Unexpected browser result: ' + result.type
      };

    } catch (error) {
      console.error('❌ Failed to handle browser result:', error);
      return {
        success: false,
        error: 'Failed to parse callback: ' + error.message
      };
    }
  }

  /**
   * Get the stored vault URL
   * 
   * @returns {Promise<string|null>} Vault URL or null
   */
  async getVaultUrl() {
    return await this.securelyRetrieve(this.VAULT_URL_KEY);
  }

  /**
   * Get or generate device ID
   * Uses a persistent unique identifier for this device
   * 
   * @returns {Promise<string>} Device ID
   */
  async getDeviceId() {
    try {
      // Check if we already have a stored device ID
      let deviceId = await this.securelyRetrieve(this.DEVICE_ID_KEY);
      
      if (deviceId) {
        return deviceId;
      }

      // Try to get native device ID
      deviceId = Application.androidId || Application.getIosIdForVendorAsync?.() || null;
      
      // If no native ID available, generate a random one
      if (!deviceId) {
        const randomBytes = await Crypto.getRandomBytesAsync(16);
        deviceId = this.base64URLEncode(randomBytes);
      }

      // Store for future use
      await this.securelyStore(this.DEVICE_ID_KEY, deviceId);
      
      return deviceId;
    } catch (error) {
      console.error('❌ Failed to get device ID:', error);
      // Generate fallback ID
      const randomBytes = await Crypto.getRandomBytesAsync(16);
      return this.base64URLEncode(randomBytes);
    }
  }

  /**
   * Handle OAuth callback URL and parse parameters
   * Verifies state and extracts authorization code
   * 
   * @param {string} callbackUrl - The callback URL from OAuth redirect
   * @returns {Promise<{success: boolean, code?: string, error?: string}>}
   */
  async handleCallback(callbackUrl) {
    try {
      console.log('🔗 Handling callback URL...');
      
      // Parse the callback URL
      const url = new URL(callbackUrl);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');

      // Check for OAuth errors
      if (error) {
        console.error('❌ OAuth error:', error, errorDescription);
        return {
          success: false,
          error: errorDescription || error
        };
      }

      // Retrieve stored state
      const storedState = await this.securelyRetrieve(this.STATE_KEY);
      
      // Verify state to prevent CSRF
      if (!storedState || state !== storedState) {
        console.error('❌ State mismatch - possible CSRF attack');
        console.log('  Expected:', storedState);
        console.log('  Received:', state);
        return {
          success: false,
          error: 'Invalid state parameter - security check failed'
        };
      }

      // Verify we received the authorization code
      if (!code) {
        console.error('❌ No authorization code received');
        return {
          success: false,
          error: 'No authorization code received'
        };
      }

      console.log('✅ Callback validated successfully');
      console.log('📝 Authorization code received');
      
      return {
        success: true,
        code
      };

    } catch (error) {
      console.error('❌ Failed to handle callback:', error);
      return {
        success: false,
        error: 'Failed to parse callback: ' + error.message
      };
    }
  }

  /**
   * Exchange authorization code for access token
   * 
   * @param {string} code - Authorization code from OAuth callback
   * @returns {Promise<{success: boolean, tokens?: object, error?: string}>}
   */
  async exchangeCodeForToken(code) {
    try {
      console.log('🔄 Exchanging code for token...');

      // Retrieve stored values
      const vaultUrl = await this.securelyRetrieve(this.VAULT_URL_KEY);
      const codeVerifier = await this.securelyRetrieve(this.CODE_VERIFIER_KEY);
      const deviceId = await this.getDeviceId();

      if (!vaultUrl) {
        throw new Error('Vault URL not found in storage');
      }

      if (!codeVerifier) {
        throw new Error('Code verifier not found in storage');
      }

      // Build token endpoint URL
      const tokenUrl = `${vaultUrl}/oauth/token`;
      
      console.log('📍 Token endpoint:', tokenUrl);
      console.log('🔑 Device ID:', deviceId);

      // Prepare request body
      const requestBody = {
        grant_type: 'authorization_code',
        code: code,
        code_verifier: codeVerifier,
        redirect_uri: this.REDIRECT_URI,
        client_id: this.CLIENT_ID,
        device_id: deviceId
      };

      console.log('📤 Sending token request...');

      // Make token exchange request
      const response = await axios.post(tokenUrl, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      });

      console.log('✅ Token exchange successful');
      console.log('📦 Response status:', response.status);

      const tokens = response.data;

      // Validate token response
      if (!tokens.access_token) {
        throw new Error('No access token in response');
      }

      // Store tokens securely
      await this.storeTokens(tokens);

      return {
        success: true,
        tokens
      };

    } catch (error) {
      console.error('❌ Token exchange failed:', error);
      
      let errorMessage = 'Token exchange failed';
      
      if (error.response) {
        // Server responded with error
        console.error('  Status:', error.response.status);
        console.error('  Data:', error.response.data);
        errorMessage = error.response.data?.error_description || 
                      error.response.data?.error || 
                      `Server error: ${error.response.status}`;
      } else if (error.request) {
        // Request made but no response
        console.error('  No response from server');
        errorMessage = 'No response from server - check network connection';
      } else {
        // Error in request setup
        errorMessage = error.message;
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Store OAuth tokens securely
   * 
   * @param {object} tokens - Token response object
   * @param {string} tokens.access_token - Access token
   * @param {string} tokens.refresh_token - Refresh token (optional)
   * @param {number} tokens.expires_in - Token expiry in seconds
   */
  async storeTokens(tokens) {
    try {
      console.log('💾 Storing tokens securely...');

      // Store access token
      await this.securelyStore(this.ACCESS_TOKEN_KEY, tokens.access_token);

      // Store refresh token if provided
      if (tokens.refresh_token) {
        await this.securelyStore(this.REFRESH_TOKEN_KEY, tokens.refresh_token);
      }

      // Calculate and store expiry timestamp
      if (tokens.expires_in) {
        const expiryTime = Date.now() + (tokens.expires_in * 1000);
        await this.securelyStore(this.TOKEN_EXPIRY_KEY, expiryTime.toString());
        console.log('⏰ Token expires at:', new Date(expiryTime).toISOString());
      }

      console.log('✅ Tokens stored successfully');

      // Clean up temporary OAuth data
      await SecureStore.deleteItemAsync(this.CODE_VERIFIER_KEY);
      await SecureStore.deleteItemAsync(this.STATE_KEY);
      console.log('🧹 Cleaned up temporary OAuth data');

    } catch (error) {
      console.error('❌ Failed to store tokens:', error);
      throw new Error('Failed to store tokens: ' + error.message);
    }
  }

  /**
   * Get the stored access token with auto-refresh
   * Automatically refreshes the token if it's expired
   * 
   * @param {boolean} autoRefresh - Whether to auto-refresh if expired (default: true)
   * @returns {Promise<string|null>} Access token or null
   */
  async getAccessToken(autoRefresh = true) {
    try {
      const token = await this.securelyRetrieve(this.ACCESS_TOKEN_KEY);
      
      if (!token) {
        console.log('⚠️ No access token found');
        return null;
      }

      // Check if token is expired
      const expired = await this.isTokenExpired();
      
      if (expired && autoRefresh) {
        console.log('🔄 Access token expired, attempting refresh...');
        
        const refreshResult = await this.refreshAccessToken();
        
        if (refreshResult.success) {
          console.log('✅ Token refreshed successfully');
          return refreshResult.accessToken;
        } else {
          console.error('❌ Token refresh failed:', refreshResult.error);
          return null;
        }
      }

      return token;
    } catch (error) {
      console.error('❌ Failed to get access token:', error);
      return null;
    }
  }

  /**
   * Get the stored refresh token
   * 
   * @returns {Promise<string|null>} Refresh token or null
   */
  async getRefreshToken() {
    return await this.securelyRetrieve(this.REFRESH_TOKEN_KEY);
  }

  /**
   * Refresh the access token using the refresh token
   * POST to /oauth/token/refresh endpoint
   * 
   * @returns {Promise<{success: boolean, accessToken?: string, error?: string}>}
   */
  async refreshAccessToken() {
    try {
      console.log('🔄 Refreshing access token...');

      // Retrieve stored values
      const vaultUrl = await this.securelyRetrieve(this.VAULT_URL_KEY);
      const refreshToken = await this.securelyRetrieve(this.REFRESH_TOKEN_KEY);
      const deviceId = await this.getDeviceId();

      if (!vaultUrl) {
        throw new Error('Vault URL not found in storage');
      }

      if (!refreshToken) {
        throw new Error('Refresh token not found in storage');
      }

      // Build token refresh endpoint URL
      const refreshUrl = `${vaultUrl}/oauth/token/refresh`;
      
      console.log('📍 Refresh endpoint:', refreshUrl);

      // Prepare request body
      const requestBody = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.CLIENT_ID,
        device_id: deviceId
      };

      console.log('📤 Sending refresh request...');

      // Make token refresh request
      const response = await axios.post(refreshUrl, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      });

      console.log('✅ Token refresh successful');
      console.log('📦 Response status:', response.status);

      const tokens = response.data;

      // Validate token response
      if (!tokens.access_token) {
        throw new Error('No access token in response');
      }

      // Store new tokens
      await this.storeTokens(tokens);

      return {
        success: true,
        accessToken: tokens.access_token
      };

    } catch (error) {
      console.error('❌ Token refresh failed:', error);
      
      let errorMessage = 'Token refresh failed';
      
      if (error.response) {
        // Server responded with error
        console.error('  Status:', error.response.status);
        console.error('  Data:', error.response.data);
        errorMessage = error.response.data?.error_description || 
                      error.response.data?.error || 
                      `Server error: ${error.response.status}`;
        
        // If refresh token is invalid, clear all tokens
        if (error.response.status === 401 || error.response.status === 400) {
          console.log('🧹 Refresh token invalid, clearing stored tokens');
          await this.clearStoredData();
        }
      } else if (error.request) {
        // Request made but no response
        console.error('  No response from server');
        errorMessage = 'No response from server - check network connection';
      } else {
        // Error in request setup
        errorMessage = error.message;
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Check if access token is expired
   * 
   * @returns {Promise<boolean>} True if token is expired
   */
  async isTokenExpired() {
    try {
      const expiryStr = await this.securelyRetrieve(this.TOKEN_EXPIRY_KEY);
      
      if (!expiryStr) {
        return true; // No expiry stored, consider expired
      }

      const expiryTime = parseInt(expiryStr);
      const now = Date.now();
      
      // Add 5 minute buffer before actual expiry
      const bufferMs = 5 * 60 * 1000;
      
      return now >= (expiryTime - bufferMs);
    } catch (error) {
      console.error('❌ Failed to check token expiry:', error);
      return true; // Assume expired on error
    }
  }

  /**
   * Check if user is authenticated (has valid token)
   * 
   * @returns {Promise<boolean>} True if authenticated
   */
  async isAuthenticated() {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return false;
    }

    const expired = await this.isTokenExpired();
    return !expired;
  }

  /**
   * Complete OAuth login flow - handles callback and exchanges code for token
   * 
   * @param {string} callbackUrl - The callback URL from OAuth redirect
   * @returns {Promise<{success: boolean, tokens?: object, error?: string}>}
   */
  async completeLogin(callbackUrl) {
    try {
      console.log('🔐 Completing login flow...');

      // Step 1: Handle and validate callback
      const callbackResult = await this.handleCallback(callbackUrl);
      
      if (!callbackResult.success) {
        return callbackResult;
      }

      // Step 2: Exchange code for token
      const tokenResult = await this.exchangeCodeForToken(callbackResult.code);
      
      return tokenResult;

    } catch (error) {
      console.error('❌ Failed to complete login:', error);
      return {
        success: false,
        error: error.message || 'Failed to complete login'
      };
    }
  }

  /**
   * Clear all stored OAuth data including tokens
   */
  async clearStoredData() {
    try {
      await SecureStore.deleteItemAsync(this.VAULT_URL_KEY);
      await SecureStore.deleteItemAsync(this.CODE_VERIFIER_KEY);
      await SecureStore.deleteItemAsync(this.STATE_KEY);
      await SecureStore.deleteItemAsync(this.ACCESS_TOKEN_KEY);
      await SecureStore.deleteItemAsync(this.REFRESH_TOKEN_KEY);
      await SecureStore.deleteItemAsync(this.TOKEN_EXPIRY_KEY);
      console.log('✅ Cleared all stored OAuth data');
    } catch (error) {
      console.error('❌ Failed to clear stored data:', error);
    }
  }

  /**
   * Logout - clear all tokens and OAuth data
   */
  async logout() {
    console.log('👋 Logging out...');
    await this.clearStoredData();
    console.log('✅ Logout complete');
  }
}

// Export singleton instance
export default new AuthService();
