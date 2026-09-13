'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { formatMoney } from '@/lib/money';
import type { StockRow } from '@/modules/retail/inventory/service';
import { adjustStockAction } from '../actions';

const STATUS = {
  ok: { tone: 'success', label: 'متاح' },
  low: { tone: 'warn', label: 'منخفض' },
  out: { tone: 'danger', label: 'نفد' },
} as const;

export function StockTable({
  rows,
  currency,
  canAdjust,
  organizationSlug,
  branchSlug,
}: {
  rows: StockRow[];
  currency: string;
  canAdjust: boolean;
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('adjustment');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(variantId: string) {
    setError(null);
    startTransition(async () => {
      const result = await adjustStockAction(
        { organizationSlug, branchSlug },
        { variantId, quantityDelta: delta, reason, note: undefined },
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(null);
      setDelta('');
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="p-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">مخزون الفرع</caption>
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th scope="col" className="p-3 text-start font-medium">الصنف</th>
              <th scope="col" className="p-3 text-start font-medium">الباركود</th>
              <th scope="col" className="p-3 text-start font-medium">السعر</th>
              <th scope="col" className="p-3 text-start font-medium">الكمية</th>
              <th scope="col" className="p-3 text-start font-medium">الحالة</th>
              {canAdjust && <th scope="col" className="p-3 text-start font-medium">تعديل</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const status = STATUS[row.status];
              const isEditing = editing === row.variantId;
              return (
                <tr key={row.variantId} className="border-b border-line last:border-0">
                  <td className="p-3">
                    <span className="font-medium">{row.productName}</span>
                    {row.variantName !== 'default' && (
                      <span className="ms-2 text-xs text-muted">{row.variantName}</span>
                    )}
                  </td>
                  <td className="p-3 lb-numeric text-muted">{row.barcode ?? '—'}</td>
                  <td className="p-3 lb-numeric">{formatMoney(row.priceCents, currency)}</td>
                  <td className="p-3 lb-numeric font-semibold">{row.quantity}</td>
                  <td className="p-3">
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </td>
                  {canAdjust && (
                    <td className="p-3">
                      {isEditing ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            value={delta}
                            onChange={(e) => setDelta(e.target.value)}
                            placeholder="±"
                            dir="ltr"
                            inputMode="decimal"
                            className="h-9 w-20"
                            aria-label="الكمية"
                            autoFocus
                          />
                          <Select
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            className="h-9 w-32"
                            aria-label="السبب"
                          >
                            <option value="adjustment">تسوية</option>
                            <option value="stocktake">جرد</option>
                            <option value="damage">تالف</option>
                            <option value="transfer_in">تحويل وارد</option>
                            <option value="transfer_out">تحويل صادر</option>
                          </Select>
                          <Button size="sm" disabled={isPending} onClick={() => submit(row.variantId)}>
                            حفظ
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            إلغاء
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditing(row.variantId);
                            setDelta('');
                            setError(null);
                          }}
                        >
                          تعديل الكمية
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
