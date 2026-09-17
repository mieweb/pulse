import { uploadFileNative } from '../native-file-upload';
import { uploadViaDirect } from '../direct-client';
import type { UploadTransport } from '../types';

/**
 * Transport for pairings that advertised the PROTOCOL §9 direct-upload
 * profile: bytes go straight to object storage via a presigned PUT; the
 * server only authorizes, grants, and confirms. `onResourceCreated` reports
 * the artifact URL as the cancel handle — the manager's bearer DELETE works
 * on it exactly as on a tus resource.
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
};
