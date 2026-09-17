import { UploadType } from 'expo-file-system';

import type { UploadFile } from './direct-client';

/**
 * Real `UploadFile` implementation for `direct-client.ts`: PUTs the whole
 * file to a presigned object-storage URL via `expo-file-system`'s native
 * upload task — the same URLSession (iOS) / OkHttp (Android) machinery as
 * `uploadChunkNative`, for the same reason (React Native's `fetch` cannot
 * carry a raw byte body). No staging copy is ever needed here: a direct PUT
 * is always the whole file from offset 0.
 *
 * The presigned URL already IS the credential — no Authorization header is
 * added, and the `headers` from the grant (signed Content-Type/Length) are
 * sent verbatim. The redirect caveat documented on `uploadChunkNative`
 * applies here too, with less exposure: there's no bearer token on this
 * request for a redirect to leak.
 */
export const uploadFileNative: UploadFile = async ({
  uploadUrl,
  headers,
  file,
  signal,
  onProgress,
}) => {
  const result = await file.upload(uploadUrl, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    sessionType: 'background', // survives iOS lock/backgrounding, same as the tus PATCH
    headers,
    signal,
    onProgress: onProgress ? ({ bytesSent }) => onProgress(bytesSent) : undefined,
  });
  return { status: result.status };
};
