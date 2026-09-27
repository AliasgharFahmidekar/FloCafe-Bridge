'use client';

import { LifeBuoy } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { SupportTicketForm } from '@/components/support/SupportTicketForm';

export default function SupportPage() {
  const t = useTranslations('support');

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm font-medium leading-6 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
        {t('lyraSupportNotice')}
      </div>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-brand/10 p-3 text-brand"><LifeBuoy className="size-6" /></div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      <SupportTicketForm />
    </div>
  );
}
