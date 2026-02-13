import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import AuthService from '@/services/AuthService';
import { storeAuthConfig } from '@/utils/authStorage';

export default function LoginScreen() {
  const router = useRouter();
  const [vaultUrl, setVaultUrl] = useState('https://pulsevault.com');
  const [isLoading, setIsLoading] = useState(false);
  const [urlError, setUrlError] = useState('');

  /**
   * Validate URL format
   */
  const validateUrl = (url) => {
    if (!url || url.trim() === '') {
      return 'URL is required';
    }

    const trimmedUrl = url.trim();
    
    // Check if URL starts with http:// or https://
    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
      return 'URL must start with http:// or https://';
    }

    // Basic URL validation
    try {
      new URL(trimmedUrl);
      return null; // Valid URL
    } catch (error) {
      return 'Invalid URL format';
    }
  };

  /**
   * Handle URL input change
   */
  const handleUrlChange = (text) => {
    setVaultUrl(text);
    // Clear error when user types
    if (urlError) {
      setUrlError('');
    }
  };

  /**
   * Handle login with Pulse Vault
   */
  const handleLogin = async () => {
    // Validate URL
    const error = validateUrl(vaultUrl);
    if (error) {
      setUrlError(error);
      return;
    }

    setIsLoading(true);
    setUrlError('');

    try {
      console.log('🔐 Starting login with URL:', vaultUrl);

      // Call AuthService to start OAuth flow
      const result = await AuthService.startLogin(vaultUrl.trim());

      if (result.success && result.code) {
        console.log('✅ Authorization code received, completing login...');

        // Store auth config to mark user as logged in
        await storeAuthConfig('mie', vaultUrl.trim());

        // Navigate to home
        console.log('🎉 Login successful, navigating to home...');
        router.replace('/(tabs)');
      } else if (result.cancelled) {
        // User cancelled or dismissed - this is normal, don't show error
        console.log('ℹ️ Login cancelled by user');
        // Just stay on login screen, let them try again
      } else {
        // Actual error occurred
        const errorMessage = result.error || 'Login failed';
        console.error('❌ Login failed:', errorMessage);
        
        Alert.alert(
          'Login Failed',
          errorMessage,
          [{ text: 'OK' }]
        );
      }
    } catch (error) {
      console.error('❌ Login error:', error);
      
      Alert.alert(
        'Login Error',
        error.message || 'An unexpected error occurred. Please try again.',
        [{ text: 'OK' }]
      );
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Handle guest login
   */
  const handleGuestLogin = async () => {
    try {
      await storeAuthConfig('guest', '');
      router.replace('/(tabs)');
    } catch (error) {
      console.error('❌ Guest login error:', error);
      Alert.alert('Error', 'Failed to continue as guest');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.logo}>Pulse</Text>
            <Text style={styles.subtitle}>Sign in to your Pulse Vault</Text>
          </View>

          {/* Form */}
          <View style={styles.formContainer}>
            {/* URL Input */}
            <View style={styles.inputContainer}>
              <Text style={styles.label}>Pulse Vault URL</Text>
              <TextInput
                style={[
                  styles.input,
                  urlError ? styles.inputError : null
                ]}
                value={vaultUrl}
                onChangeText={handleUrlChange}
                placeholder="https://pulsevault.com"
                placeholderTextColor="#999"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={handleLogin}
                editable={!isLoading}
              />
              {urlError ? (
                <Text style={styles.errorText}>{urlError}</Text>
              ) : (
                <Text style={styles.helperText}>
                  Enter your organization's Pulse Vault URL
                </Text>
              )}
            </View>

            {/* Login Button */}
            <TouchableOpacity
              style={[
                styles.loginButton,
                isLoading && styles.loginButtonDisabled
              ]}
              onPress={handleLogin}
              disabled={isLoading}
              activeOpacity={0.8}
            >
              {isLoading ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator color="#FFFFFF" size="small" />
                  <Text style={styles.loginButtonText}>Authenticating...</Text>
                </View>
              ) : (
                <Text style={styles.loginButtonText}>
                  Login with Pulse Vault
                </Text>
              )}
            </TouchableOpacity>

            {/* Divider */}
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>OR</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Guest Button */}
            <TouchableOpacity
              style={styles.guestButton}
              onPress={handleGuestLogin}
              disabled={isLoading}
              activeOpacity={0.8}
            >
              <Text style={styles.guestButtonText}>Continue as Guest</Text>
            </TouchableOpacity>
          </View>

          {/* Footer */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>
              By logging in, you agree to our Terms of Service
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingVertical: 20,
  },
  header: {
    alignItems: 'center',
    marginTop: 40,
    marginBottom: 60,
  },
  logo: {
    fontSize: 48,
    fontWeight: 'bold',
    color: '#F01E21',
    marginBottom: 12,
    fontFamily: 'Roboto-Bold',
  },
  subtitle: {
    fontSize: 18,
    color: '#666',
    textAlign: 'center',
    fontFamily: 'Roboto-Regular',
  },
  formContainer: {
    flex: 1,
    justifyContent: 'center',
    maxWidth: 400,
    width: '100%',
    alignSelf: 'center',
  },
  inputContainer: {
    marginBottom: 24,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
    fontFamily: 'Roboto-Bold',
  },
  input: {
    height: 56,
    borderWidth: 2,
    borderColor: '#E0E0E0',
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#333',
    backgroundColor: '#F9F9F9',
    fontFamily: 'Roboto-Regular',
  },
  inputError: {
    borderColor: '#F01E21',
    backgroundColor: '#FFF5F5',
  },
  errorText: {
    fontSize: 14,
    color: '#F01E21',
    marginTop: 6,
    fontFamily: 'Roboto-Regular',
  },
  helperText: {
    fontSize: 14,
    color: '#999',
    marginTop: 6,
    fontFamily: 'Roboto-Regular',
  },
  loginButton: {
    height: 56,
    backgroundColor: '#F01E21',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
    shadowColor: '#F01E21',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  loginButtonDisabled: {
    opacity: 0.7,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  loginButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: 'bold',
    fontFamily: 'Roboto-Bold',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 32,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#E0E0E0',
  },
  dividerText: {
    marginHorizontal: 16,
    fontSize: 14,
    color: '#999',
    fontFamily: 'Roboto-Regular',
  },
  guestButton: {
    height: 56,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#E0E0E0',
  },
  guestButtonText: {
    color: '#333',
    fontSize: 18,
    fontWeight: '600',
    fontFamily: 'Roboto-Bold',
  },
  footer: {
    marginTop: 40,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    fontFamily: 'Roboto-Regular',
  },
});
