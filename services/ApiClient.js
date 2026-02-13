import axios from 'axios';
import AuthService from './AuthService';

/**
 * ApiClient - Axios instance with automatic token management
 * 
 * Features:
 * - Automatically attaches auth tokens to requests
 * - Auto-refreshes expired tokens
 * - Handles authentication errors
 * - Uses vault URL as base URL
 */
class ApiClient {
  constructor() {
    // Create axios instance
    this.client = axios.create({
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    // Track if we're currently refreshing to avoid multiple refresh calls
    this.isRefreshing = false;
    this.failedQueue = [];

    // Setup interceptors
    this.setupRequestInterceptor();
    this.setupResponseInterceptor();
  }

  /**
   * Process queued requests after token refresh
   * 
   * @param {Error|null} error - Error if refresh failed
   * @param {string|null} token - New access token if refresh succeeded
   */
  processQueue(error, token = null) {
    this.failedQueue.forEach(promise => {
      if (error) {
        promise.reject(error);
      } else {
        promise.resolve(token);
      }
    });

    this.failedQueue = [];
  }

  /**
   * Setup request interceptor to attach auth tokens
   */
  setupRequestInterceptor() {
    this.client.interceptors.request.use(
      async (config) => {
        try {
          // Get vault URL and set as base URL
          const vaultUrl = await AuthService.getVaultUrl();
          if (vaultUrl) {
            config.baseURL = vaultUrl;
            console.log('📍 API Base URL:', vaultUrl);
          }

          // Get access token (with auto-refresh disabled to avoid recursion)
          const accessToken = await AuthService.getAccessToken(false);
          
          if (accessToken) {
            // Attach token to Authorization header
            config.headers.Authorization = `Bearer ${accessToken}`;
            console.log('🔑 Token attached to request');
          } else {
            console.log('⚠️ No access token available');
          }

          return config;
        } catch (error) {
          console.error('❌ Request interceptor error:', error);
          return Promise.reject(error);
        }
      },
      (error) => {
        console.error('❌ Request interceptor error:', error);
        return Promise.reject(error);
      }
    );
  }

  /**
   * Setup response interceptor to handle token expiration
   */
  setupResponseInterceptor() {
    this.client.interceptors.response.use(
      (response) => {
        // Request succeeded, return response
        return response;
      },
      async (error) => {
        const originalRequest = error.config;

        // Check if error is 401 (Unauthorized)
        if (error.response?.status === 401 && !originalRequest._retry) {
          console.log('🔒 401 Unauthorized - Token may be expired');

          // Check if error is specifically token_expired
          const errorCode = error.response?.data?.error;
          const isTokenExpired = errorCode === 'token_expired' || 
                                 errorCode === 'invalid_token' ||
                                 error.response?.data?.message?.includes('expired');

          if (isTokenExpired) {
            console.log('🔄 Token expired, attempting refresh...');

            if (this.isRefreshing) {
              // Already refreshing, queue this request
              console.log('⏳ Token refresh in progress, queueing request...');
              
              return new Promise((resolve, reject) => {
                this.failedQueue.push({ resolve, reject });
              })
                .then((token) => {
                  originalRequest.headers.Authorization = `Bearer ${token}`;
                  return this.client(originalRequest);
                })
                .catch((err) => {
                  return Promise.reject(err);
                });
            }

            // Mark that we're refreshing
            originalRequest._retry = true;
            this.isRefreshing = true;

            try {
              // Attempt to refresh the token
              const refreshResult = await AuthService.refreshAccessToken();

              if (refreshResult.success) {
                console.log('✅ Token refreshed successfully');
                
                const newToken = refreshResult.accessToken;
                this.isRefreshing = false;

                // Process any queued requests
                this.processQueue(null, newToken);

                // Retry the original request with new token
                originalRequest.headers.Authorization = `Bearer ${newToken}`;
                return this.client(originalRequest);
              } else {
                throw new Error(refreshResult.error || 'Token refresh failed');
              }
            } catch (refreshError) {
              console.error('❌ Token refresh failed:', refreshError);
              this.isRefreshing = false;

              // Process queue with error
              this.processQueue(refreshError, null);

              // Logout user on refresh failure
              console.log('👋 Logging out user due to refresh failure...');
              await AuthService.logout();

              // Reject with error
              return Promise.reject(refreshError);
            }
          } else {
            // Not a token expiration error, just unauthorized
            console.log('⚠️ Unauthorized access - not a token issue');
          }
        }

        // Return original error if not handled
        return Promise.reject(error);
      }
    );
  }

  /**
   * Make a GET request
   * 
   * @param {string} url - Request URL (relative to base URL)
   * @param {object} config - Axios config options
   * @returns {Promise} Axios response
   */
  async get(url, config = {}) {
    try {
      console.log('📥 GET:', url);
      const response = await this.client.get(url, config);
      console.log('✅ GET successful:', response.status);
      return response;
    } catch (error) {
      console.error('❌ GET failed:', url, error.message);
      throw error;
    }
  }

  /**
   * Make a POST request
   * 
   * @param {string} url - Request URL (relative to base URL)
   * @param {any} data - Request body data
   * @param {object} config - Axios config options
   * @returns {Promise} Axios response
   */
  async post(url, data, config = {}) {
    try {
      console.log('📤 POST:', url);
      const response = await this.client.post(url, data, config);
      console.log('✅ POST successful:', response.status);
      return response;
    } catch (error) {
      console.error('❌ POST failed:', url, error.message);
      throw error;
    }
  }

  /**
   * Make a PUT request
   * 
   * @param {string} url - Request URL (relative to base URL)
   * @param {any} data - Request body data
   * @param {object} config - Axios config options
   * @returns {Promise} Axios response
   */
  async put(url, data, config = {}) {
    try {
      console.log('📝 PUT:', url);
      const response = await this.client.put(url, data, config);
      console.log('✅ PUT successful:', response.status);
      return response;
    } catch (error) {
      console.error('❌ PUT failed:', url, error.message);
      throw error;
    }
  }

  /**
   * Make a PATCH request
   * 
   * @param {string} url - Request URL (relative to base URL)
   * @param {any} data - Request body data
   * @param {object} config - Axios config options
   * @returns {Promise} Axios response
   */
  async patch(url, data, config = {}) {
    try {
      console.log('📝 PATCH:', url);
      const response = await this.client.patch(url, data, config);
      console.log('✅ PATCH successful:', response.status);
      return response;
    } catch (error) {
      console.error('❌ PATCH failed:', url, error.message);
      throw error;
    }
  }

  /**
   * Make a DELETE request
   * 
   * @param {string} url - Request URL (relative to base URL)
   * @param {object} config - Axios config options
   * @returns {Promise} Axios response
   */
  async delete(url, config = {}) {
    try {
      console.log('🗑️ DELETE:', url);
      const response = await this.client.delete(url, config);
      console.log('✅ DELETE successful:', response.status);
      return response;
    } catch (error) {
      console.error('❌ DELETE failed:', url, error.message);
      throw error;
    }
  }

  /**
   * Get the underlying axios instance for advanced use cases
   * 
   * @returns {object} Axios instance
   */
  getAxiosInstance() {
    return this.client;
  }

  /**
   * Update the base URL (useful for switching between environments)
   * 
   * @param {string} baseURL - New base URL
   */
  setBaseURL(baseURL) {
    this.client.defaults.baseURL = baseURL;
    console.log('📍 Base URL updated:', baseURL);
  }

  /**
   * Set a custom header for all requests
   * 
   * @param {string} key - Header key
   * @param {string} value - Header value
   */
  setHeader(key, value) {
    this.client.defaults.headers.common[key] = value;
    console.log(`📋 Header set: ${key}`);
  }

  /**
   * Remove a custom header
   * 
   * @param {string} key - Header key to remove
   */
  removeHeader(key) {
    delete this.client.defaults.headers.common[key];
    console.log(`🗑️ Header removed: ${key}`);
  }
}

// Export singleton instance
export default new ApiClient();
