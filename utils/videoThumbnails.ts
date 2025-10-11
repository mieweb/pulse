import { getThumbnailAsync } from 'expo-video-thumbnails';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ThumbnailOptions {
  time?: number;
  quality?: number;
}

// Simple in-memory cache for thumbnails
const thumbnailCache = new Map<string, string>();

export async function generateVideoThumbnail(
  videoUri: string,
  options: ThumbnailOptions = {}
): Promise<string | null> {
  try {
    const { time = 0, quality = 1.0 } = options;
    
    // Create cache key based on video URI and options
    const cacheKey = `${videoUri}_${time}_${quality}`;
    
    // Check in-memory cache first
    if (thumbnailCache.has(cacheKey)) {
      return thumbnailCache.get(cacheKey)!;
    }
    
    // Check persistent storage
    try {
      const cachedUri = await AsyncStorage.getItem(`thumbnail_${cacheKey}`);
      if (cachedUri) {
        thumbnailCache.set(cacheKey, cachedUri);
        return cachedUri;
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