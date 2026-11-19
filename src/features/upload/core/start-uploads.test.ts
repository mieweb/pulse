import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState } from 'react-native';

import { startUploads } from './start-uploads';
import { uploads } from './upload-manager';

const mockCalls: string[] = [];
const mockRemove = jest.fn();
let mockOnChange: ((state: string) => void) | null = null;

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn((_type: string, listener: (state: string) => void) => {
      mockOnChange = listener;
      return { remove: mockRemove };
    }),
  },
}));

jest.mock('./upload-manager', () => {
  const step = (name: string) =>
    jest.fn(() => {
      mockCalls.push(name);
    });
  return {
    uploads: {
      registerToast: step('registerToast'),
      setCopyLink: step('setCopyLink'),
      prepareLaunch: jest.fn(async () => {
        mockCalls.push('prepareLaunch');
      }),
      ensureRunning: jest.fn(async () => {
        mockCalls.push('ensureRunning');
      }),
    },
  };
});

beforeEach(() => {
  mockCalls.length = 0;
  mockOnChange = null;
  jest.clearAllMocks();
});

describe('startUploads', () => {
  it('hands the manager the shell’s toast and clipboard before the launch check', () => {
    const showToast = jest.fn();
    const copyLink = jest.fn(async () => true);
    startUploads({ showToast, copyLink });

    expect(mockCalls).toEqual(['registerToast', 'setCopyLink', 'prepareLaunch']);
    expect(uploads.registerToast).toHaveBeenCalledWith(showToast);
    expect(uploads.setCopyLink).toHaveBeenCalledWith(copyLink);
  });

  it('passes a shell without a clipboard on as none', () => {
    startUploads({ showToast: jest.fn(), copyLink: null });
    expect(uploads.setCopyLink).toHaveBeenCalledWith(null);
  });

  it('pokes the drain on every return to the foreground, and stops when asked', () => {
    const stop = startUploads({ showToast: jest.fn(), copyLink: null });
    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    mockOnChange?.('background');
    mockOnChange?.('inactive');
    expect(uploads.ensureRunning).not.toHaveBeenCalled();
    mockOnChange?.('active');
    mockOnChange?.('active');
    expect(uploads.ensureRunning).toHaveBeenCalledTimes(2);

    expect(mockRemove).not.toHaveBeenCalled();
    stop();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});
