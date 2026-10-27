import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Building2, Phone, Pill } from 'lucide-react';
import { getPublicPrescription } from '@/modules/clinic/service';
import { PrintButton } from './print-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'روشتة طبية',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};


/**
 * The page a WhatsApp or printed prescription link opens. No account: the
 * opaque token is the only key, and the database answers only for an issued,
 * unexpired prescription (clinic_prescription_public, rate-limited). An
 * unknown, cancelled or expired token is a 404, indistinguishable from one
 * that never existed. Not indexed, no referrer sent onward.
 */
export default async function PublicPrescriptionPage({ params }: { params: { token: string } }) {
  const rx = await getPublicPrescription(params.token);
  if (!rx) notFound();
  const DATE = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'long', timeZone: rx.timezone ?? 'UTC' });

  return (
    <main className="min-h-dvh bg-surface px-4 py-6 print:bg-white print:p-0">
      <article className="mx-auto max-w-2xl space-y-5 rounded-lg border border-line bg-elevated p-6 shadow-sm print:max-w-none print:border-0 print:shadow-none" data-testid="public-rx">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
          <div className="space-y-1">
            <h1 className="flex items-center gap-2 text-xl font-bold"><Building2 className="h-5 w-5 text-primary" aria-hidden="true" /> {rx.clinic}</h1>
            <p className="text-sm text-muted">{rx.branch}{rx.branch_address ? ` — ${rx.branch_address}` : ''}</p>
            {rx.branch_phone && <p className="flex items-center gap-1 text-sm text-muted"><Phone className="h-3.5 w-3.5" aria-hidden="true" /> <span dir="ltr">{rx.branch_phone}</span></p>}
          </div>
          <div className="text-end">
            <p className="font-semibold">{rx.doctor}</p>
            {rx.specialty && <p className="text-sm text-muted">{rx.specialty}</p>}
            {rx.license && <p className="text-xs text-muted">ترخيص <span dir="ltr">{rx.license}</span></p>}
          </div>
        </header>

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-muted">المريض</dt><dd className="font-semibold">{rx.patient}</dd></div>
          <div><dt className="text-xs text-muted">السن</dt><dd>{rx.age !== null ? `${rx.age} سنة` : '—'}</dd></div>
          <div><dt className="text-xs text-muted">رقم الملف</dt><dd className="lb-numeric">{rx.file_number}</dd></div>
          <div><dt className="text-xs text-muted">التاريخ</dt><dd>{DATE.format(new Date(rx.issued_at))}</dd></div>
        </dl>

        <section aria-label="الأدوية" className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <span className="font-serif text-2xl text-primary" aria-hidden="true">℞</span> الأدوية
            <span className="ms-auto text-sm font-normal text-muted">رقم <span className="lb-numeric" dir="ltr">{rx.number}</span></span>
          </h2>
          <ol className="space-y-3">
            {rx.items.map((i, idx) => (
              <li key={idx} className="rounded border border-line p-3 print:break-inside-avoid">
                <p className="flex flex-wrap items-baseline gap-2">
                  <span className="lb-numeric text-sm text-muted">{idx + 1}.</span>
                  <Pill className="h-4 w-4 text-primary print:hidden" aria-hidden="true" />
                  <span className="text-base font-semibold">{i.drug_name}</span>
                  {i.strength && <span dir="ltr" className="text-sm">{i.strength}</span>}
                  {i.dosage_form && <span className="text-sm text-muted">{i.dosage_form}</span>}
                </p>
                <p className="mt-1 text-sm">
                  {[i.dose, i.frequency, i.route, i.duration && `لمدة ${i.duration}`].filter(Boolean).join(' · ')}
                </p>
                {i.instructions && <p className="mt-1 text-sm text-muted">{i.instructions}</p>}
              </li>
            ))}
          </ol>
        </section>

        {rx.notes && (
          <section className="rounded bg-surface p-3 text-sm print:border print:border-line">
            <h2 className="mb-1 font-semibold">ملاحظات الطبيب</h2>
            <p className="whitespace-pre-wrap">{rx.notes}</p>
          </section>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-xs text-muted">
          <span>رابط صالح حتى {DATE.format(new Date(rx.expires_at))}. صرف الدواء بإشراف صيدلي.</span>
          <PrintButton />
        </footer>
      </article>
    </main>
  );
}
