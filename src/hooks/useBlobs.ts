/**
 * useBlobs — upload and fetch blobs via the aggregator.
 *
 * Upload uses the Android native module to sign with the agent's Ed25519
 * identity key (local mode only). Fetch is unauthenticated — blobs are
 * publicly readable by CID.
 *
 * Hosted mode: uploadBlob() rejects with HOSTED_UNSUPPORTED since the
 * identity key lives on the remote server, not on the device. File
 * delivery for hosted agents is a future improvement.
 */
import { useCallback, useState } from 'react';
import { NodeModule } from '../native/NodeModule';
import { useNode } from './useNode';

const AGGREGATOR = 'https://api.0x01.world';

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Upload bytes to the aggregator blob store.
 * Returns the CID (64-char hex) on success.
 * Throws if the node is not running locally or if upload fails.
 */
export async function uploadBlob(
  dataBase64: string,
  mimeType: string,
): Promise<string> {
  return NodeModule.uploadBlob(dataBase64, mimeType);
}

/**
 * Fetch a blob from the aggregator by CID.
 * Returns base64-encoded bytes.
 */
export async function fetchBlob(cid: string): Promise<string> {
  const res = await fetch(`${AGGREGATOR}/blobs/${cid}`);
  if (!res.ok) throw new Error(`Fetch blob failed: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  // Convert ArrayBuffer → base64
  const bytes  = new Uint8Array(buffer);
  let binary   = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

// ── Hook ──────────────────────────────────────────────────────────────────

interface UseBlobsResult {
  uploading:  boolean;
  error:      string | null;
  upload:     (dataBase64: string, mimeType: string) => Promise<string | null>;
  fetchBlob:  (cid: string) => Promise<string | null>;
}

export function useBlobs(): UseBlobsResult {
  const { status, config } = useNode();
  const [uploading, setUploading] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const upload = useCallback(async (
    dataBase64: string,
    mimeType:   string,
  ): Promise<string | null> => {
    setError(null);

    if (config.nodeApiUrl) {
      const msg = 'File upload is only supported in local node mode.';
      setError(msg);
      return null;
    }
    if (status !== 'running') {
      const msg = 'Start your local node before uploading files.';
      setError(msg);
      return null;
    }

    setUploading(true);
    try {
      const cid = await uploadBlob(dataBase64, mimeType);
      return cid;
    } catch (e: any) {
      const msg = e?.message ?? 'Upload failed';
      setError(msg);
      return null;
    } finally {
      setUploading(false);
    }
  }, [status, config.nodeApiUrl]);

  const fetch_ = useCallback(async (cid: string): Promise<string | null> => {
    setError(null);
    try {
      return await fetchBlob(cid);
    } catch (e: any) {
      setError(e?.message ?? 'Fetch failed');
      return null;
    }
  }, []);

  return { uploading, error, upload, fetchBlob: fetch_ };
}
