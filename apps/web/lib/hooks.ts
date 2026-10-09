'use client';

import { useCallback } from 'react';
import { api } from './api';

/**
 * Resolves an attachment id to a short-lived URL (S3 presign, or the API's
 * token-protected download through this origin's BFF). Never a permanent URL.
 */
export function useMediaUrl(): (attachmentId: string) => Promise<string | null> {
  return useCallback(async (attachmentId: string) => {
    const r = await api<{ url: string }>(`/v1/media/attachments/${attachmentId}/url`);
    return r.url.startsWith('/v1/') ? `/api${r.url}` : r.url;
  }, []);
}
