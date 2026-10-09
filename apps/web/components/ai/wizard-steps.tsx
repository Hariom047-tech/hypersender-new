import { cx } from '@/components/ui';
import { msg, t } from '@/lib/i18n';

// Step ids double as English labels (translated where shown). i18n-ignore
export const WIZARD_STEPS = ['Preview', 'Business', 'Configure', 'Capabilities', 'Knowledge', 'WhatsApp', 'Test', 'Publish'] as const;
void [msg('Preview'), msg('Business'), msg('Configure'), msg('Capabilities'), msg('Knowledge'), msg('Test'), msg('Publish')];
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** The 8-step setup journey (template install wizard -> assistant builder). */
export function WizardStepper({ current, done = [] }: { current: WizardStep; done?: WizardStep[] }) {
  const idx = WIZARD_STEPS.indexOf(current);
  return (
    <ol className="mb-6 flex flex-wrap gap-x-1 gap-y-2 text-xs" aria-label={t("Setup progress")}>
      {WIZARD_STEPS.map((s, i) => {
        const complete = done.includes(s) || i < idx;
        return (
          <li key={s} aria-current={s === current ? 'step' : undefined}
            className={cx('flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ring-inset',
              s === current ? 'bg-emerald-700 text-white ring-emerald-700' : complete ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-white text-slate-500 ring-slate-200')}>
            <span aria-hidden>{complete && s !== current ? '✓' : i + 1}</span>{t(s)}
          </li>
        );
      })}
    </ol>
  );
}
