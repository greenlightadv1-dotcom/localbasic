'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDown, ArrowUp, Copy, Eye, EyeOff, Layers, Plus, Save, Search, SlidersHorizontal, Trash2, Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Field, Input } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { EmptyState } from '@/components/patterns/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/money';
import { fromCents, toCents } from '@/lib/amount-input';
import type { HubModifierGroup } from '@/modules/restaurant/hub/service';
import { copyModifierGroupAction, saveModifierGroupAction } from './actions';
import type { Scope } from './shared';

type Product = { id: string; name: string; categoryName: string | null; isActive: boolean; basePriceCents: number };
type DraftChoice = { key: string; id: string | null; name: string; price: string; isActive: boolean };
type Draft = { groupId: string | null; name: string; min: number; max: number; isActive: boolean; choices: DraftChoice[] };

let seq = 0;
const key = () => `c${++seq}`;

/** One tap starts the groups every kitchen asks for; each is edited before saving. */
const TEMPLATES: { label: string; draft: Omit<Draft, 'groupId'> }[] = [
  { label: 'إضافات', draft: { name: 'إضافات', min: 0, max: 3, isActive: true, choices: [
    { key: '', id: null, name: 'جبنة زيادة', price: '15', isActive: true },
    { key: '', id: null, name: 'بيض', price: '10', isActive: true },
    { key: '', id: null, name: 'صوص زيادة', price: '5', isActive: true }] } },
  { label: 'بدون', draft: { name: 'بدون', min: 0, max: 5, isActive: true, choices: [
    { key: '', id: null, name: 'بدون بصل', price: '0', isActive: true },
    { key: '', id: null, name: 'بدون طماطم', price: '0', isActive: true },
    { key: '', id: null, name: 'بدون مخلل', price: '0', isActive: true }] } },
  { label: 'طريقة التقديم', draft: { name: 'طريقة التقديم', min: 0, max: 2, isActive: true, choices: [
    { key: '', id: null, name: 'الصوص جانبًا', price: '0', isActive: true },
    { key: '', id: null, name: 'سبايسي', price: '0', isActive: true }] } },
  { label: 'درجة الاستواء', draft: { name: 'درجة الاستواء', min: 1, max: 1, isActive: true, choices: [
    { key: '', id: null, name: 'ميديم', price: '0', isActive: true },
    { key: '', id: null, name: 'ميديم ويل', price: '0', isActive: true },
    { key: '', id: null, name: 'ويل دن', price: '0', isActive: true }] } },
];

function toDraft(g: HubModifierGroup): Draft {
  return {
    groupId: g.id, name: g.name, min: g.minSelect, max: g.maxSelect, isActive: g.isActive,
    choices: g.modifiers.map((m) => ({ key: key(), id: m.id, name: m.name, price: fromCents(m.priceCents), isActive: m.isActive })),
  };
}

/**
 * The modifier builder: pick a menu item, then shape its option groups —
 * extras with a price ("extra cheese"), free removals ("no onions"), serving
 * notes ("sauce on the side"), required choices ("doneness") — with how many
 * a guest must and may pick. A group saves with its choices in one audited
 * call (0117); a removed choice is retired, not deleted, so past orders keep
 * it and it can be brought back. A finished group can be copied onto other
 * items in one go.
 */
export function ModifierBuilder({ scope, currency, products, groups }: {
  scope: Scope; currency: string; products: Product[]; groups: HubModifierGroup[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [query, setQuery] = useState('');
  const [productId, setProductId] = useState<string | null>(products[0]?.id ?? null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copying, setCopying] = useState<HubModifierGroup | null>(null);

  const countByProduct = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) if (g.isActive) m.set(g.productId, (m.get(g.productId) ?? 0) + 1);
    return m;
  }, [groups]);
  const q = query.trim().toLowerCase();
  const list = products.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.categoryName ?? '').toLowerCase().includes(q));
  const product = products.find((p) => p.id === productId) ?? null;
  const productGroups = groups.filter((g) => g.productId === productId);

  function pick(id: string) {
    if (draft && !confirmDiscard()) return;
    setProductId(id); setDraft(null); setError(null);
  }
  function confirmDiscard() { return window.confirm('لديك تعديلات لم تُحفظ. تجاهلها؟'); }

  function startNew(template?: Omit<Draft, 'groupId'>) {
    setError(null);
    setDraft(template
      ? { groupId: null, ...template, choices: template.choices.map((c) => ({ ...c, key: key() })) }
      : { groupId: null, name: '', min: 0, max: 1, isActive: true, choices: [{ key: key(), id: null, name: '', price: '0', isActive: true }] });
  }

  function patch(p: Partial<Draft>) { setDraft((d) => (d ? { ...d, ...p } : d)); }
  function patchChoice(k: string, p: Partial<DraftChoice>) {
    setDraft((d) => (d ? { ...d, choices: d.choices.map((c) => (c.key === k ? { ...c, ...p } : c)) } : d));
  }
  function moveChoice(k: string, dir: -1 | 1) {
    setDraft((d) => {
      if (!d) return d;
      const i = d.choices.findIndex((c) => c.key === k);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.choices.length) return d;
      const next = [...d.choices];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...d, choices: next };
    });
  }
  function removeChoice(c: DraftChoice) {
    // A saved choice is retired (kept for past orders); a new one simply goes.
    if (c.id) patchChoice(c.key, { isActive: !c.isActive });
    else setDraft((d) => (d ? { ...d, choices: d.choices.filter((x) => x.key !== c.key) } : d));
  }

  const activeChoices = draft?.choices.filter((c) => c.isActive).length ?? 0;
  const problems: string[] = [];
  if (draft) {
    if (!draft.name.trim()) problems.push('اسم المجموعة مطلوب');
    if (draft.min > draft.max) problems.push('الحد الأدنى أكبر من الأقصى');
    if (draft.isActive && draft.min > activeChoices) problems.push('الحد الأدنى أكبر من عدد الاختيارات المتاحة');
    if (draft.choices.some((c) => !c.name.trim())) problems.push('كل اختيار يحتاج اسمًا');
    if (draft.choices.some((c) => toCents(c.price || '0') === null)) problems.push('سعر غير صحيح');
  }

  function save() {
    if (!draft || !productId) return;
    if (problems.length) { setError(problems.join(' · ')); return; }
    setError(null);
    start(async () => {
      const r = await saveModifierGroupAction(scope, {
        groupId: draft.groupId, productId, name: draft.name, minSelect: draft.min, maxSelect: draft.max, isActive: draft.isActive,
        modifiers: draft.choices.map((c) => ({ id: c.id, name: c.name, priceCents: toCents(c.price || '0') ?? 0, isActive: c.isActive })),
      });
      if (!r.ok) { setError(r.error); return; }
      toast.success(draft.groupId ? 'تم حفظ المجموعة' : 'تمت إضافة المجموعة');
      setDraft(null);
      router.refresh();
    });
  }

  const rule = (min: number, max: number) =>
    min === 0 ? `اختياري — حتى ${max}` : min === max ? `مطلوب — ${min}` : `مطلوب ${min} إلى ${max}`;

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]" data-testid="modifier-builder">
      <aside aria-label="أصناف المنيو" className="space-y-2 rounded-lg border border-line bg-elevated p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ابحث عن صنف…" className="ps-9" aria-label="ابحث عن صنف" />
        </div>
        <ul className="max-h-[65vh] space-y-0.5 overflow-y-auto">
          {list.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => pick(p.id)} aria-current={p.id === productId ? 'true' : undefined}
                className={cn('flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-start text-sm',
                  p.id === productId ? 'bg-primary-soft font-semibold text-primary' : 'hover:bg-surface', !p.isActive && 'opacity-60')}>
                <span className="min-w-0">
                  <span className="block truncate">{p.name}</span>
                  {p.categoryName && <span className="block truncate text-xs text-muted">{p.categoryName}</span>}
                </span>
                {(countByProduct.get(p.id) ?? 0) > 0 && <Badge tone="info">{countByProduct.get(p.id)}</Badge>}
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="p-4 text-center text-sm text-muted">لا توجد أصناف.</li>}
        </ul>
      </aside>

      <section aria-label="مجموعات الإضافات" className="min-w-0 space-y-3">
        {!product ? (
          <EmptyState icon={SlidersHorizontal} title="لا توجد أصناف في المنيو" description="أضف أصنافًا من شاشة المنيو أولًا." />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold">{product.name}</h2>
                <p className="text-xs text-muted">السعر الأساسي <span className="lb-numeric">{formatMoney(product.basePriceCents, currency)}</span> · الإضافات تُضاف على سعر السطر</p>
              </div>
              {!draft && (
                <div className="flex flex-wrap gap-1.5">
                  {TEMPLATES.map((t) => (
                    <Button key={t.label} size="sm" variant="outline" onClick={() => startNew(t.draft)}>+ {t.label}</Button>
                  ))}
                  <Button size="sm" onClick={() => startNew()} data-testid="group-new"><Plus className="h-4 w-4" aria-hidden="true" /> مجموعة جديدة</Button>
                </div>
              )}
            </div>

            {draft && (
              <div className="space-y-3 rounded-lg border-2 border-primary bg-elevated p-3" data-testid="group-editor">
                <div className="grid gap-3 sm:grid-cols-[1fr_7rem_7rem]">
                  <Field label="اسم المجموعة" required>
                    {(p) => <Input {...p} value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="مثال: إضافات" data-testid="group-name" />}
                  </Field>
                  <Field label="أقل اختيار">
                    {(p) => <Input {...p} type="number" min={0} max={30} dir="ltr" value={draft.min}
                      onChange={(e) => patch({ min: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })} />}
                  </Field>
                  <Field label="أقصى اختيار">
                    {(p) => <Input {...p} type="number" min={1} max={30} dir="ltr" value={draft.max}
                      onChange={(e) => patch({ max: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })} />}
                  </Field>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <Badge tone={draft.min > 0 ? 'warn' : 'neutral'}>{rule(draft.min, draft.max)}</Badge>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={draft.isActive} onChange={(e) => patch({ isActive: e.target.checked })} className="h-4 w-4" />
                    المجموعة ظاهرة في الطلب
                  </label>
                </div>

                <ul className="space-y-1.5" aria-label="الاختيارات">
                  {draft.choices.map((c, i) => (
                    <li key={c.key} className={cn('flex flex-wrap items-center gap-1.5 rounded border border-line p-1.5', !c.isActive && 'bg-surface opacity-60')}>
                      <Input value={c.name} onChange={(e) => patchChoice(c.key, { name: e.target.value })} placeholder="اسم الاختيار"
                        aria-label={`اسم الاختيار ${i + 1}`} className="min-w-[10rem] flex-1" disabled={!c.isActive} />
                      <span className="flex items-center gap-1">
                        <span className="text-xs text-muted">+</span>
                        <Input value={c.price} onChange={(e) => patchChoice(c.key, { price: e.target.value })} inputMode="decimal" dir="ltr"
                          aria-label={`سعر الاختيار ${i + 1}`} className="w-24 lb-numeric" disabled={!c.isActive} />
                      </span>
                      <span className="flex">
                        <Button size="icon" variant="ghost" onClick={() => moveChoice(c.key, -1)} disabled={i === 0} aria-label="لأعلى"><ArrowUp className="h-4 w-4" aria-hidden="true" /></Button>
                        <Button size="icon" variant="ghost" onClick={() => moveChoice(c.key, 1)} disabled={i === draft.choices.length - 1} aria-label="لأسفل"><ArrowDown className="h-4 w-4" aria-hidden="true" /></Button>
                        <Button size="icon" variant="ghost" onClick={() => removeChoice(c)}
                          aria-label={c.id ? (c.isActive ? 'إيقاف الاختيار' : 'إعادة الاختيار') : 'حذف الاختيار'}>
                          {c.id ? (c.isActive ? <Trash2 className="h-4 w-4" aria-hidden="true" /> : <Undo2 className="h-4 w-4" aria-hidden="true" />) : <Trash2 className="h-4 w-4" aria-hidden="true" />}
                        </Button>
                      </span>
                      {!c.isActive && <span className="w-full text-xs text-muted">موقوف — لن يظهر في الطلبات الجديدة، ويبقى في الطلبات السابقة.</span>}
                    </li>
                  ))}
                </ul>
                <Button size="sm" variant="outline" disabled={draft.choices.length >= 30}
                  onClick={() => patch({ choices: [...draft.choices, { key: key(), id: null, name: '', price: '0', isActive: true }] })}>
                  <Plus className="h-4 w-4" aria-hidden="true" /> اختيار
                </Button>

                {(error || problems.length > 0) && <Alert tone={error ? 'danger' : 'warn'}>{error ?? problems.join(' · ')}</Alert>}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => { setDraft(null); setError(null); }} disabled={pending}>إلغاء</Button>
                  <Button onClick={save} disabled={pending || problems.length > 0} data-testid="group-save">
                    <Save className="h-4 w-4" aria-hidden="true" /> حفظ المجموعة
                  </Button>
                </div>
              </div>
            )}

            {productGroups.length === 0 && !draft ? (
              <EmptyState icon={Layers} title="لا إضافات على هذا الصنف"
                description="ابدأ بقالب جاهز (إضافات، بدون، طريقة التقديم) أو مجموعة جديدة." />
            ) : (
              <ul className="grid gap-2 md:grid-cols-2">
                {productGroups.map((g) => (
                  <li key={g.id} className={cn('rounded-lg border border-line bg-elevated p-3', !g.isActive && 'opacity-60')} data-testid={`group-${g.name}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="flex items-center gap-1.5 font-bold">
                          {g.isActive ? <Eye className="h-4 w-4 text-muted" aria-hidden="true" /> : <EyeOff className="h-4 w-4 text-muted" aria-hidden="true" />}
                          {g.name}
                        </h3>
                        <p className="text-xs text-muted">{rule(g.minSelect, g.maxSelect)}</p>
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setCopying(g)} disabled={pending || !!draft} aria-label={`نسخ ${g.name} لأصناف أخرى`}>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" /> نسخ
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => { setError(null); setDraft(toDraft(g)); }} disabled={pending || !!draft}>تعديل</Button>
                      </div>
                    </div>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {g.modifiers.filter((m) => m.isActive).map((m) => (
                        <li key={m.id} className="rounded-full border border-line px-2.5 py-0.5 text-xs">
                          {m.name}{m.priceCents > 0 && <span className="ms-1 text-muted lb-numeric">+{formatMoney(m.priceCents, currency)}</span>}
                        </li>
                      ))}
                      {g.modifiers.some((m) => !m.isActive) && (
                        <li className="px-1 text-xs text-muted">+{g.modifiers.filter((m) => !m.isActive).length} موقوف</li>
                      )}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {copying && (
        <CopyGroupModal scope={scope} group={copying} products={products.filter((p) => p.id !== copying.productId)}
          onClose={() => setCopying(null)} onDone={() => { setCopying(null); router.refresh(); }} />
      )}
    </div>
  );
}

function CopyGroupModal({ scope, group, products, onClose, onDone }: {
  scope: Scope; group: HubModifierGroup; products: Product[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const visible = products.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.categoryName ?? '').toLowerCase().includes(q));
  const categories = [...new Set(products.map((p) => p.categoryName).filter((c): c is string => Boolean(c)))];

  function toggle(id: string) {
    setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  function submit() {
    setError(null);
    start(async () => {
      const r = await copyModifierGroupAction(scope, { groupId: group.id, productIds: [...picked] });
      if (!r.ok) { setError(r.error); return; }
      const skipped = picked.size - r.data.copies;
      toast.success(`نُسخت "${group.name}" إلى ${r.data.copies} صنف${skipped > 0 ? ` (تخطّي ${skipped} لديها مجموعة بنفس الاسم)` : ''}`);
      onDone();
    });
  }

  return (
    <Modal open title={`نسخ "${group.name}" لأصناف أخرى`} description="تُنسخ المجموعة باختياراتها الفعّالة؛ الصنف الذي لديه مجموعة بنفس الاسم يُتخطّى."
      icon={Copy} size="md" onClose={onClose} busy={pending} testId="copy-group"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-sm text-muted lb-numeric">{picked.size} مختار</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={pending}>إلغاء</Button>
            <Button onClick={submit} disabled={pending || picked.size === 0} data-testid="copy-submit">نسخ</Button>
          </div>
        </div>
      }>
      <div className="space-y-3">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ابحث…" aria-label="ابحث" />
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => (
              <Button key={c} size="sm" variant="ghost"
                onClick={() => setPicked((s) => new Set([...s, ...products.filter((p) => p.categoryName === c).map((p) => p.id)]))}>
                كل {c}
              </Button>
            ))}
          </div>
        )}
        <ul className="max-h-[45vh] divide-y divide-line overflow-y-auto rounded border border-line">
          {visible.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} className="h-4 w-4" />
                <span className="flex-1">{p.name}</span>
                {p.categoryName && <span className="text-xs text-muted">{p.categoryName}</span>}
              </label>
            </li>
          ))}
        </ul>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
