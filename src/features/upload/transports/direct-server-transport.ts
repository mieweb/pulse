import { uploadFileNative } from '../native-file-upload';
import { uploadViaDirect } from '../direct-client';
import { cancelTusUpload } from '../tus-client';
import type { UploadTransport } from '../types';

/**
 * Transport for pairings that advertised the PROTOCOL §9 direct-upload
 * profile: bytes go straight to object storage via a presigned PUT; the
 * server only authorizes, grants, and confirms. `onResourceCreated` reports
 * the artifact URL as the in-flight cancel handle — `cancel` is a plain
 * authorized DELETE on it, which `cancelTusUpload` already implements (a
 * generic DELETE-with-bearer where 404/410 count as success).
 */
export const directServerTransport: UploadTransport = {
  run: ({ destination, artifact, signal, onProgress, onResourceCreated }) =>
    uploadViaDirect({
      server: destination.server,
      token: destination.token,
      artifactId: artifact.artifactId,
      filename: artifact.filename,
      kind: artifact.kind,
      relatedTo: artifact.relatedTo,
      checksum: artifact.checksum,
      name: artifact.name,
      file: artifact.file,
      onResourceCreated,
      signal,
      uploadFile: uploadFileNative,
      onProgress,
    }),

  cancel: (resourceUrl, token) => cancelTusUpload(resourceUrl, token),
};
