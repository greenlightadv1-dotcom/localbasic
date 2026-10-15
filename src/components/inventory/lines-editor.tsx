'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { INPUT_UNITS, toBase, type BaseUnit, type InputUnit } from '@/modules/restaurant/inventory/units';

export type ItemOption = { id: string; name: string; unit: BaseUnit };
export type DraftLine = { key: number; itemId: string; amount: string; inputUnit: InputUnit; extra?: string };

let seq = 0;
export const newLine = (itemId = '', unit: InputUnit = 'kg', amount = ''): DraftLine => ({ key: ++seq, itemId, amount, inputUnit: unit, extra: '' });

export function defaultInputUnit(base: BaseUnit | undefined): InputUnit {
  return base ? INPUT_UNITS[base][0]!.key : 'kg';
}

/** Converts the drafts to base-unit lines; skips blank rows; null when a row is invalid. */
export function toBaseLines(lines: DraftLine[], items: ItemOption[]): { itemId: string; qty: number; extra?: string }[] | null {
  const out: { itemId: string; qty: number; extra?: string }[] = [];
  for (const l of lines) {
    if (!l.itemId && !l.amount) continue;
    const item = items.find((i) => i.id === l.itemId);
    const n = Number(l.amount.replace(',', '.'));
    if (!item || !Number.isFinite(n) || n <= 0) return null;
    const unit = INPUT_UNITS[item.unit].some((u) => u.key === l.inputUnit) ? l.inputUnit : defaultInputUnit(item.unit);
    out.push({ itemId: item.id, qty: toBase(n, item.unit, unit), extra: l.extra });
  }
  return out;
}

/**
 * Rows of "raw material · quantity · unit". Each row's unit list follows the
 * chosen item (grams can be typed as kg, millilitres as litres, pieces as
 * pieces), so a quantity is never entered in the wrong dimension.
 */
export function LinesEditor({
  items,
  lines,
  onChange,
  extraColumn,
  testId = 'lines',
}: {
  items: ItemOption[];
  lines: DraftLine[];
  onChange: (lines: DraftLine[]) => void;
  /** Optional extra input per row (e.g. cost). */
  extraColumn?: { placeholder: (unitLabel: string) => string };
  testId?: string;
}) {
  const update = (key: number, patch: Partial<DraftLine>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <div className="space-y-2" data-testid={testId}>
      {lines.map((l) => {
        const item = items.find((i) => i.id === l.itemId);
        const units = item ? INPUT_UNITS[item.unit] : INPUT_UNITS.g;
        const unitLabel = units.find((u) => u.key === l.inputUnit)?.label ?? units[0]!.label;
        return (
          <div key={l.key} className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="الخامة"
              className="min-w-0 flex-[2_1_10rem]"
              value={l.itemId}
              onChange={(e) => {
                const next = items.find((i) => i.id === e.target.value);
                update(l.key, { itemId: e.target.value, inputUnit: defaultInputUnit(next?.unit) });
              }}
            >
              <option value="">اختر الخامة…</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </Select>
            <Input
              aria-label="الكمية"
              className="w-24 flex-[1_1_5rem]"
              inputMode="decimal"
              dir="ltr"
              placeholder="0"
              value={l.amount}
              onChange={(e) => update(l.key, { amount: e.target.value })}
            />
            <Select
              aria-label="الوحدة"
              className="w-24"
              value={l.inputUnit}
              onChange={(e) => update(l.key, { inputUnit: e.target.value as InputUnit })}
            >
              {units.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
            </Select>
            {extraColumn ? (
              <Input
                aria-label={extraColumn.placeholder(unitLabel)}
                className="w-32 flex-[1_1_7rem]"
                inputMode="decimal"
                dir="ltr"
                placeholder={extraColumn.placeholder(unitLabel)}
                value={l.extra ?? ''}
                onChange={(e) => update(l.key, { extra: e.target.value })}
              />
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="حذف السطر"
              onClick={() => onChange(lines.length > 1 ? lines.filter((x) => x.key !== l.key) : [newLine()])}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      <Button type="button" size="sm" variant="outline" onClick={() => onChange([...lines, newLine()])}>
        <Plus className="h-4 w-4" aria-hidden="true" /> إضافة خامة
      </Button>
    </div>
  );
}
