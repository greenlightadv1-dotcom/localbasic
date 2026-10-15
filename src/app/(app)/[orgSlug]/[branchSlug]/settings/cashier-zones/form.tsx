'use client';

import { useState, useTransition } from 'react';
import { MapPinned } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { useToast } from '@/components/ui/toast';
import type { CashierZoneRow } from '@/modules/restaurant/approvals/service';
import { saveCashierZoneAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };
type Section = { id: string; name: string };

/**
 * Which tables a sub-cashier serves. A restricted cashier sees and settles
 * only orders on tables in their sections (plus takeaway / online when
 * allowed); the database enforces it, this screen only sets it. Main
 * cashiers and managers are never restricted.
 */
export function CashierZonesForm({ scope, cashiers, sections }: { scope: Scope; cashiers: CashierZoneRow[]; sections: Section[] }) {
  if (cashiers.length === 0) {
    return (
      <Card>
        <EmptyState icon={MapPinned} title="لا يوجد كاشير بعد" description="أضف عضوًا بدور «كاشير» من الأعضاء، ثم حدّد منطقته هنا." />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted">
        الكاشير الفرعي يرى ويحاسب طلبات طاولات منطقته فقط. الكاشير الرئيسي والمدير يريان كل الصالات.
        الإلغاء بعد التحضير والخصومات تحتاج دائمًا رمز موافقة المدير.
      </p>
      {cashiers.map((c) => <ZoneCard key={c.memberId} scope={scope} row={c} sections={sections} />)}
    </div>
  );
}

function ZoneCard({ scope, row, sections }: { scope: Scope; row: CashierZoneRow; sections: Section[] }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [restricted, setRestricted] = useState(row.restricted);
  const [selected, setSelected] = useState(new Set(row.sectionIds));
  const [allowTakeaway, setAllowTakeaway] = useState(row.allowTakeaway);
  const [allowOnline, setAllowOnline] = useState(row.allowOnline);
  const here = new Set(sections.map((s) => s.id));

  function save() {
    start(async () => {
      // Sections of other branches stay as they are; this screen edits this branch's.
      const sectionIds = [...row.sectionIds.filter((id) => !here.has(id)), ...[...selected].filter((id) => here.has(id))];
      const r = await saveCashierZoneAction(scope, { memberId: row.memberId, restricted, sectionIds, allowTakeaway, allowOnline });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(restricted ? `تم ضبط منطقة ${row.name}` : `${row.name} يرى كل الصالات الآن`);
    });
  }

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  return (
    <Card data-testid="zone-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {row.name}
          {row.role ? <Badge tone="neutral">{row.role}</Badge> : null}
          {restricted ? <Badge tone="warn">كاشير فرعي</Badge> : <Badge tone="success">كل الصالات</Badge>}
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} data-testid="zone-restricted" />
          قصر هذا الكاشير على مناطق محددة
        </label>
        {restricted && (
          <div className="space-y-3 rounded border border-line p-3">
            {sections.length === 0 ? (
              <p className="text-sm text-muted">لا توجد صالات في هذا الفرع. أضفها من «الطاولات».</p>
            ) : (
              <fieldset>
                <legend className="mb-2 text-sm font-medium">الصالات</legend>
                <div className="flex flex-wrap gap-3">
                  {sections.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="h-4 w-4 accent-primary" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                      {s.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={allowTakeaway} onChange={(e) => setAllowTakeaway(e.target.checked)} />
              طلبات التيك أواي من الكاشير
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={allowOnline} onChange={(e) => setAllowOnline(e.target.checked)} />
              الطلبات الأونلاين
            </label>
          </div>
        )}
        <Button onClick={save} disabled={pending} data-testid="zone-save">حفظ</Button>
      </CardBody>
    </Card>
  );
}
