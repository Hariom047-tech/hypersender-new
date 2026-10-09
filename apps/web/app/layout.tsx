import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { BRAND } from '@/lib/brand';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = { title: BRAND, description: 'WhatsApp inbox and automation for your business' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = (await cookies()).get('hs.lang')?.value === 'hi' ? 'hi' : 'en';
  return (
    <html lang={lang}>
      <body className="font-sans antialiased"><Providers lang={lang}>{children}</Providers></body>
    </html>
  );
}
