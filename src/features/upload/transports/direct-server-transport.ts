import { uploadFileNative } from '../native-file-upload';
import { uploadViaDirect } from '../direct-client';
import { cancelTusUpload } from '../tus-client';
import type { UploadTransport } from '../types';

/**
 * Transport for servers advertising the PROTOCOL §9 direct-upload profile:
 * bytes go straight to object storage via a presigned PUT; this server only
 * authorizes, grants, and confirms. Selected per run by the upload manager
 * from `/capabilities` — TUS remains the default transport.
 *
 * Resume identity: `artifact.resourceUrl` is ignored on run (the profile is
 * stateless client-side — create re-grants for an incomplete reservation and
 * complete is idempotent), but `onResourceCreated` still reports the durable
 * artifact URL so the manager's persistence, cancellation and invalidation
 * paths work unchanged: `cancel` is a plain authorized DELETE on that URL,
 * which `cancelTusUpload` already implements (it's a generic
 * DELETE-with-bearer where 404/410 count as success).
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
