import { getThumbnailAsync } from 'expo-video-thumbnails';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

export interface ThumbnailOptions {
  time?: number;
  quality?: number;
}

// Simple in-memory cache for thumbnails
const thumbnailCache = new Map<string, string>();

// Helper to check if a file exists
async function fileExists(uri: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists;
  } catch {
    return false;
  }
}

export async function generateVideoThumbnail(
  videoUri: string,
  options: ThumbnailOptions = {}
): Promise<string | null> {
  try {
    const { time = 0, quality = 1.0 } = options;
    
    // Create cache key based on video URI and options
    const cacheKey = `${videoUri}_${time}_${quality}`;
    
    // Check in-memory cache first - but verify file still exists
    if (thumbnailCache.has(cacheKey)) {
      const cachedUri = thumbnailCache.get(cacheKey)!;
      if (await fileExists(cachedUri)) {
        return cachedUri;
      }
      // File no longer exists, remove from cache
      thumbnailCache.delete(cacheKey);
    }
    
    // Check persistent storage - but verify file still exists
    try {
      const cachedUri = await AsyncStorage.getItem(`thumbnail_${cacheKey}`);
      if (cachedUri) {
        if (await fileExists(cachedUri)) {
          thumbnailCache.set(cacheKey, cachedUri);
          return cachedUri;
        }
        // File no longer exists (cache was cleared), remove from AsyncStorage
        console.log('[videoThumbnails] Cached thumbnail file no longer exists, regenerating...');
        await AsyncStorage.removeItem(`thumbnail_${cacheKey}`);
      }
    } catch (storageError) {
      console.warn('Failed to read thumbnail from cache:', storageError);
    }
    
    // Generate new thumbnail
    const { uri } = await getThumbnailAsync(videoUri, {
      time,
      quality,
    });
    
    // Cache the result
    thumbnailCache.set(cacheKey, uri);
    
    // Store in persistent storage
    try {
      await AsyncStorage.setItem(`thumbnail_${cacheKey}`, uri);
    } catch (storageError) {
      console.warn('Failed to cache thumbnail:', storageError);
    }
    
    console.log('Generated thumbnail:', uri);
    return uri;
  } catch (error) {
    console.error('Error generating video thumbnail:', error);
    return null;
  }
}

export async function generateMultipleThumbnails(
  videoUris: string[],
  options: ThumbnailOptions = {}
): Promise<(string | null)[]> {
  try {
    const thumbnailPromises = videoUris.map(uri => 
      generateVideoThumbnail(uri, options)
    );
    
    return await Promise.all(thumbnailPromises);
  } catch (error) {
    console.error('Error generating multiple thumbnails:', error);
    return videoUris.map(() => null);
  }
} 