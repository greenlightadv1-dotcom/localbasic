'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import type { StockRow } from '@/modules/retail/inventory/service';
import { transferStockAction } from '../actions';

/**
 * Move stock to another branch.
 *
 * Deliberately one variant and one quantity at a time. The service and the
 * database both accept a multi-line transfer, but a stock move is usually one
 * shelf's worth and a form that makes the common case two fields beats one
 * that makes every case a spreadsheet. The multi-line path stays available for
 * an importer or a future bulk screen.
 *
 * Nothing here decides anything: the branch, the variant and the quantity are
 * all re-validated server-side, and whether the stock exists is settled by the
 * database under a row lock.
 */
export function TransferPanel({
  rows,
  branches,
  currentBranchId,
  organizationSlug,
  branchSlug,
}: {
  rows: StockRow[];
  branches: { id: string; name: string }[];
  currentBranchId: string;
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [variantId, setVariantId] = useState('');
  const [toBranchId, setToBranchId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Only branches other than this one can receive; stock cannot move to where
  // it already is, and the database refuses it too.
  const destinations = branches.filter((b) => b.id !== currentBranchId);

  // Transferring something the branch does not hold is a guaranteed refusal,
  // so the picker offers only what is actually on the shelf.
  const available = rows.filter((r) => r.quantity > 0);
  const selected = available.find((r) => r.variantId === variantId);

  function submit() {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const result = await transferStockAction(
        { organizationSlug, branchSlug },
        {
          fromBranchId: currentBranchId,
          toBranchId,
          lines: [{ variantId, quantity: Number(quantity) }],
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      );

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone('تم التحويل.');
      setVariantId('');
      setQuantity('');
      setNote('');
      router.refresh();
    });
  }

  if (destinations.length === 0) {
    return (
      <p className="px-4 py-3 text-xs text-muted">
        التحويل يحتاج فرعًا آخر. هذه المؤسسة لديها فرع واحد.
      </p>
    );
  }

  if (!open) {
    return (
      <div className="px-4 py-3">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <ArrowLeftRight className="h-4 w-4" />
          تحويل إلى فرع آخر
        </Button>
      </div>
    );
  }

  const valid =
    variantId !== ''
    && toBranchId !== ''
    && Number(quantity) > 0
    && (!selected || Number(quantity) <= selected.quantity);

  return (
    <div className="space-y-3 border-b border-line bg-surface px-4 py-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="الصنف">
          {(p) => (
            <Select {...p} value={variantId} onChange={(e) => setVariantId(e.target.value)}>
              <option value="">— اختر صنفًا —</option>
              {available.map((r) => (
                <option key={r.variantId} value={r.variantId}>
                  {r.productName} — {r.variantName} ({r.quantity})
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="إلى فرع">
          {(p) => (
            <Select {...p} value={toBranchId} onChange={(e) => setToBranchId(e.target.value)}>
              <option value="">— اختر فرعًا —</option>
              {destinations.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="الكمية">
          {(p) => (
            <Input
              {...p}
              type="number"
              min={1}
              step="any"
              dir="ltr"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              {...(selected ? { max: selected.quantity } : {})}
            />
          )}
        </Field>

        <Field label="ملاحظة">
          {(p) => (
            <Input
              {...p}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      </div>

      {selected && Number(quantity) > selected.quantity && (
        <Alert tone="warn">
          الفرع يحتوي على {selected.quantity} فقط من هذا الصنف.
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {done && <Alert tone="success">{done}</Alert>}

      <div className="flex gap-2">
        <Button size="sm" disabled={!valid || isPending} onClick={submit}>
          {isPending ? 'جارٍ التحويل…' : 'تحويل'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setError(null);
            setDone(null);
          }}
        >
          إلغاء
        </Button>
      </div>
    </div>
  );
}
