'use client';

import { useEffect, useId, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  CashierPreview, KitchenPreview, OwnerPreview, WaiterPreview,
} from '../services/restaurant/preview-tabs';
import {
  ClinicOwnerPreview, DoctorPreview, InventoryManagerPreview, PatientRxPreview, ReceptionistPreview,
  RetailCashierPreview, RetailOwnerPreview,
} from './sector-previews';
import { SECTORS, SECTOR_BY_KEY, type SectorKey } from './sectors';
import { useSector } from './use-sector';

type Role = { key: string; label: string; blurb: string; Panel: () => JSX.Element };

/**
 * "A screen for every role", per sector: the owner's view (the same treasury
 * and reports underneath, shown with that trade's numbers) and the sector's
 * own staff. Every panel is hard-coded presentation data.
 */
const ROLES: Record<SectorKey, Role[]> = {
  restaurant: [
    { key: 'owner', label: 'المالك', blurb: 'المبيعات والفروع والخزينة في أي لحظة.', Panel: OwnerPreview },
    { key: 'waiter', label: 'الكابتن', blurb: 'الطاولات والطلبات والتقديم — بدون تحصيل أو خصم.', Panel: WaiterPreview },
    { key: 'chef', label: 'الشيف', blurb: 'الطلبات وحالتها فقط، بدون أي مبالغ.', Panel: KitchenPreview },
    { key: 'cashier', label: 'الكاشير', blurb: 'تسجيل الطلب والتحصيل وتقسيم الفاتورة.', Panel: CashierPreview },
  ],
  retail: [
    { key: 'owner', label: 'المالك', blurb: 'مبيعات كل فرع وهامش الربح والأصناف تحت الحد.', Panel: RetailOwnerPreview },
    { key: 'cashier', label: 'الكاشير', blurb: 'باركود وميزان وعروض ورصيد العميل في شاشة واحدة.', Panel: RetailCashierPreview },
    { key: 'inventory', label: 'مدير المخزن', blurb: 'التحويل بين الفروع واقتراحات إعادة الطلب.', Panel: InventoryManagerPreview },
  ],
  clinic: [
    { key: 'owner', label: 'المالك', blurb: 'إيراد العيادة وعمولات الأطباء والخزينة.', Panel: ClinicOwnerPreview },
    { key: 'reception', label: 'الاستقبال', blurb: 'الحجز في المواعيد المتاحة وقائمة الانتظار.', Panel: ReceptionistPreview },
    { key: 'doctor', label: 'الطبيب', blurb: 'ملف المريض والعلامات الحيوية والروشتة.', Panel: DoctorPreview },
    { key: 'patient', label: 'المريض', blurb: 'الروشتة على موبايله من رابط واتساب، بدون حساب.', Panel: PatientRxPreview },
  ],
};

/** The role tabs and panel for one sector, opening on its first front-line role. */
function RoleTabs({ sector, leading }: { sector: SectorKey; leading?: React.ReactNode }) {
  const roles = ROLES[sector];
  const [role, setRole] = useState(roles[1]!.key);
  const baseId = useId();
  useEffect(() => { setRole(ROLES[sector][1]!.key); }, [sector]);
  const current = roles.find((r) => r.key === role) ?? roles[0]!;
  const accent = SECTOR_BY_KEY[sector].accent;

  return (
    <div>
      <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-center', leading ? 'sm:justify-between' : 'sm:justify-center')}>
        {leading}
        <div role="tablist" aria-label="معاينة حسب الدور" className="flex flex-wrap gap-2">
          {roles.map((r) => {
            const selected = r.key === current.key;
            return (
              <button key={r.key} type="button" role="tab" id={`${baseId}-tab-${r.key}`} aria-selected={selected}
                aria-controls={`${baseId}-panel`} onClick={() => setRole(r.key)}
                className={cn('rounded px-4 py-2 text-sm font-semibold transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                  selected ? 'bg-primary text-primary-fg' : 'border border-line bg-elevated text-muted hover:bg-surface hover:text-fg')}>
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      <p className={cn('mt-4 flex items-center gap-2 text-sm text-muted', !leading && 'justify-center')}>
        <span className={cn('h-2 w-2 rounded-full', accent.dot)} aria-hidden /> {current.blurb}
      </p>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${current.key}`}
        key={`${sector}-${current.key}`} className="mt-4 animate-fade-up [animation-duration:300ms]">
        <current.Panel />
      </div>
      <p className="mt-3 text-center text-xs text-muted">بيانات العرض توضيحية بالكامل ولا تمثل أي منشأة حقيقية.</p>
    </div>
  );
}

/** One sector's tour, for its own service page. */
export function SectorRoleTabs({ sector }: { sector: SectorKey }) {
  return <RoleTabs sector={sector} />;
}

/** The landing page's tour: follows the sector picked anywhere on the page. */
export function RoleTour() {
  const [sector, setSector] = useSector();
  return (
    <RoleTabs sector={sector} leading={
      <div className="flex gap-1 self-start rounded-full border border-line bg-elevated p-1" aria-label="النشاط">
        {SECTORS.map((s) => (
          <button key={s.key} type="button" onClick={() => setSector(s.key)} aria-pressed={s.key === sector}
            className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-colors',
              s.key === sector ? s.accent.solid : 'text-muted hover:text-fg')}>
            <s.icon className="h-3.5 w-3.5" aria-hidden="true" /> {s.short}
          </button>
        ))}
      </div>
    } />
  );
}
