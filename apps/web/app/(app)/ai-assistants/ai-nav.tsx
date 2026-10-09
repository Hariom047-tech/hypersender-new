'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/components/ui';
import { t } from '@/lib/i18n';

/** Sub-navigation shared by the AI Assistants pages. */
export function AiNav() {
  const path = usePathname();
  const items = [{ href: '/ai-assistants/templates', label: t("Templates") }, { href: '/ai-assistants', label: t("My assistants") }];
  return (
    <nav aria-label={t("AI assistants")} className="mb-6 flex gap-1 border-b border-slate-200">
      {items.map((i) => {
        const active = i.href === '/ai-assistants' ? path === '/ai-assistants' : path.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? 'page' : undefined}
            className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', active ? 'border-emerald-700 text-emerald-800' : 'border-transparent text-slate-600 hover:text-slate-900')}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
