'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { LanguageProvider, type Lang } from '@/lib/i18n';

export function Providers({ children, lang = 'en' }: { children: ReactNode; lang?: Lang }) {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      },
    },
  }));
  return <QueryClientProvider client={qc}><LanguageProvider initial={lang}>{children}</LanguageProvider></QueryClientProvider>;
}
