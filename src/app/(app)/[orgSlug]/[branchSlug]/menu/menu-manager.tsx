'use client';

import { Fragment, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, ImageIcon, Plus, Trash2, Pencil } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm';
import { EmptyState } from '@/components/patterns/states';
import { useToast } from '@/components/ui/toast';
import { ImageUpload } from '@/components/patterns/image-upload';
import { formatMoney } from '@/lib/money';
import type { MenuItem } from '@/modules/restaurant/menu/service';
import type { Station } from '@/modules/restaurant/stations/service';
import {
  createMenuCategoryAction,
  createMenuProductAction,
  toggleMenuProductAction,
  toggleBestSellerAction,
  setProductImageAction,
  setAvailabilityAction,
  setProductStationAction,
  setCategoryStationAction,
  updateMenuProductAction,
  deleteMenuProductAction,
} from '../restaurant-actions';

const STATION_KIND_LABELS: Record<string, string> = { kitchen: 'مطبخ', bar: 'بار' };

type VariantDraft = { key: number; name: string; price: string };
type GroupDraft = {
  key: number;
  name: string;
  minSelect: string;
  maxSelect: string;
  modifiers: { key: number; name: string; price: string }[];
};

export function MenuManager({
  menu,
  categories,
  stations,
  currency,
  canManage,
  organizationId,
  organizationSlug,
  branchSlug,
}: {
  menu: MenuItem[];
  categories: { id: string; name: string; default_station_kind: string }[];
  stations: Station[];
  currency: string;
  canManage: boolean;
  organizationId: string;
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showItemForm, setShowItemForm] = useState(false);
  const [variants, setVariants] = useState<VariantDraft[]>([{ key: 0, name: '', price: '' }]);
  const [groups, setGroups] = useState<GroupDraft[]>([]);
  const [newItemImage, setNewItemImage] = useState<string | null>(null);
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<MenuItem | null>(null);
  const scope = { organizationSlug, branchSlug };

  function addCategory(formData: FormData) {
    startTransition(async () => {
      const result = await createMenuCategoryAction(scope, {
        name: formData.get('name'),
        sortOrder: formData.get('sortOrder') || 0,
        defaultStationKind: formData.get('defaultStationKind') || 'kitchen',
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('تمت إضافة التصنيف');
      router.refresh();
    });
  }

  function addItem(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createMenuProductAction(scope, {
        name: formData.get('name'),
        categoryId: formData.get('categoryId') || null,
        description: formData.get('description') || undefined,
        imageUrl: newItemImage,
        taxRatePercent: formData.get('taxRatePercent') || 0,
        prepMinutes: formData.get('prepMinutes') || 0,
        stationId: formData.get('stationId') || null,
        variants: variants.map((v) => ({ name: v.name || 'default', priceCents: v.price || '0' })),
        modifierGroups: groups.map((g) => ({
          name: g.name,
          minSelect: g.minSelect || 0,
          maxSelect: g.maxSelect || 1,
          modifiers: g.modifiers.map((m) => ({ name: m.name, priceCents: m.price || '0' })),
        })),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success('تمت إضافة الصنف');
      setShowItemForm(false);
      setVariants([{ key: 0, name: '', price: '' }]);
      setGroups([]);
      setNewItemImage(null);
      router.refresh();
    });
  }

  function toggleItem(productId: string, isActive: boolean) {
    startTransition(async () => {
      const result = await toggleMenuProductAction(scope, { productId, isActive });
      if (!result.ok) toast.error(result.error);
      else router.refresh();
    });
  }

  function saveItemImage(productId: string, imageUrl: string | null) {
    startTransition(async () => {
      const result = await setProductImageAction(scope, { id: productId, imageUrl });
      if (!result.ok) toast.error(result.error);
      else router.refresh();
    });
  }

  /** Highlights a dish on the customer-facing site's "الأكثر مبيعًا" section. */
  function toggleBestSeller(productId: string, isBestSeller: boolean) {
    startTransition(async () => {
      const result = await toggleBestSellerAction(scope, { productId, isBestSeller });
      if (!result.ok) toast.error(result.error);
      else router.refresh();
    });
  }

  function saveEdit(item: MenuItem, formData: FormData) {
    startTransition(async () => {
      const result = await updateMenuProductAction(scope, {
        productId: item.id,
        name: formData.get('name'),
        categoryId: formData.get('categoryId') || null,
        description: formData.get('description') || undefined,
        taxRatePercent: formData.get('taxRatePercent') || 0,
        prepMinutes: formData.get('prepMinutes') || 0,
        variants: item.variants.map((v) => ({
          id: v.id,
          name: formData.get(`variant-name-${v.id}`) || 'default',
          priceCents: formData.get(`variant-price-${v.id}`) || '0',
        })),
      });
      if (!result.ok) { toast.error(result.error); return; }
      toast.success('تم حفظ التعديلات');
      setEditingId(null);
      router.refresh();
    });
  }

  function removeItem(productId: string) {
    startTransition(async () => {
      const result = await deleteMenuProductAction(scope, { productId });
      if (!result.ok) { toast.error(result.error); return; }
      toast.success('تم حذف الصنف');
      setDeleting(null);
      router.refresh();
    });
  }

  /** "86" a dish at this branch only — the kitchen's call, not a menu edit. */
  function toggleAvailability(variantId: string, isAvailable: boolean) {
    startTransition(async () => {
      const result = await setAvailabilityAction(scope, { variantId, isAvailable });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(isAvailable ? 'الصنف متاح الآن' : 'تم إيقاف الصنف في هذا الفرع');
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>تصنيف جديد</CardTitle>
            </CardHeader>
            <CardBody>
              <form action={addCategory} className="flex gap-2">
                <div className="flex-1">
                  <label htmlFor="cat-name" className="sr-only">
                    اسم التصنيف
                  </label>
                  <Input id="cat-name" name="name" placeholder="مثال: مشروبات ساخنة" required maxLength={120} />
                </div>
                <label htmlFor="cat-station" className="sr-only">
                  التوجيه الافتراضي
                </label>
                <Select id="cat-station" name="defaultStationKind" defaultValue="kitchen" className="w-28">
                  <option value="kitchen">مطبخ</option>
                  <option value="bar">بار</option>
                </Select>
                <input type="hidden" name="sortOrder" value={categories.length} />
                <Button type="submit" disabled={isPending}>
                  إضافة
                </Button>
              </form>
              {categories.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {categories.map((c) => (
                    <li key={c.id} className="flex items-center gap-1">
                      <Badge>{c.name}</Badge>
                      {canManage ? (
                        <button
                          type="button"
                          title="تبديل توجيه هذا التصنيف بين المطبخ والبار"
                          disabled={isPending}
                          onClick={() =>
                            startTransition(async () => {
                              const next = c.default_station_kind === 'bar' ? 'kitchen' : 'bar';
                              const result = await setCategoryStationAction(scope, {
                                id: c.id,
                                defaultStationKind: next,
                              });
                              if (!result.ok) { toast.error(result.error); return; }
                              router.refresh();
                            })
                          }
                          className="text-xs text-muted underline decoration-dotted hover:text-fg"
                        >
                          {STATION_KIND_LABELS[c.default_station_kind] ?? c.default_station_kind}
                        </button>
                      ) : (
                        <span className="text-xs text-muted">
                          {STATION_KIND_LABELS[c.default_station_kind] ?? c.default_station_kind}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>صنف جديد</CardTitle>
              <Button size="sm" variant="outline" onClick={() => setShowItemForm((v) => !v)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {showItemForm ? 'إخفاء' : 'إضافة صنف'}
              </Button>
            </CardHeader>
            {!showItemForm && (
              <CardBody className="text-sm text-muted">
                أضف الأصناف وأسعارها والإضافات المتاحة عليها.
              </CardBody>
            )}
          </Card>
        </div>
      )}

      {showItemForm && canManage && (
        <Card>
          <CardBody>
            {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
            <form action={addItem} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="اسم الصنف" required>
                  {(p) => <Input {...p} name="name" required maxLength={200} />}
                </Field>
                <Field label="التصنيف">
                  {(p) => (
                    <Select {...p} name="categoryId" defaultValue="">
                      <option value="">بدون تصنيف</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="نسبة الضريبة %">
                  {(p) => (
                    <Input {...p} name="taxRatePercent" type="number" min={0} max={100} step="0.01" defaultValue="0" dir="ltr" />
                  )}
                </Field>
                <Field label="زمن التحضير (دقائق)">
                  {(p) => <Input {...p} name="prepMinutes" type="number" min={0} max={600} defaultValue="0" dir="ltr" />}
                </Field>
                <Field label="المحطة" hint="اتركه تلقائيًا ليتّبع توجيه التصنيف (مطبخ/بار)">
                  {(p) => (
                    <Select {...p} name="stationId" defaultValue="">
                      <option value="">تلقائي حسب التصنيف</option>
                      {stations.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({STATION_KIND_LABELS[s.kind] ?? s.kind})
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <div className="sm:col-span-2">
                  <Field label="الوصف">
                    {(p) => <Textarea {...p} name="description" maxLength={1000} />}
                  </Field>
                </div>
              </div>

              <ImageUpload
                organizationId={organizationId}
                purpose="product"
                value={newItemImage}
                onChange={setNewItemImage}
                label="صورة الصنف"
                aspectClassName="aspect-square"
              />

              <fieldset className="rounded border border-line p-3">
                <legend className="px-1 text-sm font-medium">الأحجام والأسعار</legend>
                <div className="space-y-2">
                  {variants.map((v, i) => (
                    <div key={v.key} className="flex flex-wrap items-end gap-2">
                      <div className="flex-1">
                        <label htmlFor={`v-name-${v.key}`} className="mb-1 block text-xs">
                          الاسم {variants.length === 1 && '(اختياري)'}
                        </label>
                        <Input
                          id={`v-name-${v.key}`}
                          value={v.name}
                          placeholder={variants.length === 1 ? 'بدون أحجام' : `حجم ${i + 1}`}
                          onChange={(e) =>
                            setVariants((r) =>
                              r.map((x) => (x.key === v.key ? { ...x, name: e.target.value } : x)),
                            )
                          }
                        />
                      </div>
                      <div className="w-32">
                        <label htmlFor={`v-price-${v.key}`} className="mb-1 block text-xs">
                          السعر ({currency})
                        </label>
                        <Input
                          id={`v-price-${v.key}`}
                          value={v.price}
                          onChange={(e) =>
                            setVariants((r) =>
                              r.map((x) => (x.key === v.key ? { ...x, price: e.target.value } : x)),
                            )
                          }
                          inputMode="decimal"
                          dir="ltr"
                          required
                          placeholder="0.00"
                        />
                      </div>
                      {variants.length > 1 && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-danger"
                          aria-label="حذف الحجم"
                          onClick={() => setVariants((r) => r.filter((x) => x.key !== v.key))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  onClick={() =>
                    setVariants((r) => [...r, { key: Date.now(), name: '', price: '' }])
                  }
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  إضافة حجم
                </Button>
              </fieldset>

              <fieldset className="rounded border border-line p-3">
                <legend className="px-1 text-sm font-medium">مجموعات الإضافات</legend>
                {groups.length === 0 && (
                  <p className="text-sm text-muted">
                    مثال: «درجة النضج» (اختيار إجباري واحد) أو «إضافات» (اختياري متعدد).
                  </p>
                )}
                <div className="space-y-3">
                  {groups.map((g) => (
                    <div key={g.key} className="space-y-2 rounded border border-line p-2">
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-40 flex-1">
                          <label htmlFor={`g-name-${g.key}`} className="mb-1 block text-xs">
                            اسم المجموعة
                          </label>
                          <Input
                            id={`g-name-${g.key}`}
                            value={g.name}
                            onChange={(e) =>
                              setGroups((r) =>
                                r.map((x) => (x.key === g.key ? { ...x, name: e.target.value } : x)),
                              )
                            }
                          />
                        </div>
                        <div className="w-24">
                          <label htmlFor={`g-min-${g.key}`} className="mb-1 block text-xs">
                            أقل عدد
                          </label>
                          <Input
                            id={`g-min-${g.key}`}
                            value={g.minSelect}
                            type="number"
                            min={0}
                            dir="ltr"
                            onChange={(e) =>
                              setGroups((r) =>
                                r.map((x) =>
                                  x.key === g.key ? { ...x, minSelect: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        </div>
                        <div className="w-24">
                          <label htmlFor={`g-max-${g.key}`} className="mb-1 block text-xs">
                            أقصى عدد
                          </label>
                          <Input
                            id={`g-max-${g.key}`}
                            value={g.maxSelect}
                            type="number"
                            min={1}
                            dir="ltr"
                            onChange={(e) =>
                              setGroups((r) =>
                                r.map((x) =>
                                  x.key === g.key ? { ...x, maxSelect: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        </div>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-danger"
                          aria-label="حذف المجموعة"
                          onClick={() => setGroups((r) => r.filter((x) => x.key !== g.key))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      {g.modifiers.map((m) => (
                        <div key={m.key} className="flex flex-wrap items-end gap-2 ps-4">
                          <div className="min-w-32 flex-1">
                            <label htmlFor={`m-name-${m.key}`} className="mb-1 block text-xs">
                              الإضافة
                            </label>
                            <Input
                              id={`m-name-${m.key}`}
                              value={m.name}
                              onChange={(e) =>
                                setGroups((r) =>
                                  r.map((x) =>
                                    x.key === g.key
                                      ? {
                                          ...x,
                                          modifiers: x.modifiers.map((y) =>
                                            y.key === m.key ? { ...y, name: e.target.value } : y,
                                          ),
                                        }
                                      : x,
                                  ),
                                )
                              }
                            />
                          </div>
                          <div className="w-28">
                            <label htmlFor={`m-price-${m.key}`} className="mb-1 block text-xs">
                              السعر
                            </label>
                            <Input
                              id={`m-price-${m.key}`}
                              value={m.price}
                              inputMode="decimal"
                              dir="ltr"
                              placeholder="0.00"
                              onChange={(e) =>
                                setGroups((r) =>
                                  r.map((x) =>
                                    x.key === g.key
                                      ? {
                                          ...x,
                                          modifiers: x.modifiers.map((y) =>
                                            y.key === m.key ? { ...y, price: e.target.value } : y,
                                          ),
                                        }
                                      : x,
                                  ),
                                )
                              }
                            />
                          </div>
                        </div>
                      ))}

                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setGroups((r) =>
                            r.map((x) =>
                              x.key === g.key
                                ? {
                                    ...x,
                                    modifiers: [
                                      ...x.modifiers,
                                      { key: Date.now(), name: '', price: '' },
                                    ],
                                  }
                                : x,
                            ),
                          )
                        }
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        إضافة خيار
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  onClick={() =>
                    setGroups((r) => [
                      ...r,
                      { key: Date.now(), name: '', minSelect: '0', maxSelect: '1', modifiers: [] },
                    ])
                  }
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  إضافة مجموعة
                </Button>
              </fieldset>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowItemForm(false)}>
                  إلغاء
                </Button>
                <Button type="submit" disabled={isPending}>
                  {isPending ? 'جارٍ الحفظ…' : 'حفظ الصنف'}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}

      <Card>
        {menu.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="المنيو فارغ"
            description="ابدأ بإضافة تصنيف ثم أضف الأصناف وأسعارها."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">أصناف المنيو</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">الصنف</th>
                  <th scope="col" className="p-3 text-start font-medium">التصنيف</th>
                  <th scope="col" className="p-3 text-start font-medium">الأسعار</th>
                  <th scope="col" className="p-3 text-start font-medium">التوافر في الفرع</th>
                  {canManage && <th scope="col" className="p-3 text-start font-medium">الأكثر مبيعًا</th>}
                  {canManage && <th scope="col" className="p-3 text-start font-medium">الحالة</th>}
                  {canManage && <th scope="col" className="p-3 text-start font-medium">إجراءات</th>}
                </tr>
              </thead>
              <tbody>
                {menu.map((item) => (
                  <Fragment key={item.id}>
                  <tr className="border-b border-line last:border-0">
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        {canManage ? (
                          <button
                            type="button"
                            onClick={() => setExpandedImageId((id) => (id === item.id ? null : item.id))}
                            className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded border border-line bg-surface"
                            aria-label={`صورة ${item.name}`}
                          >
                            {item.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element -- a Storage URL, not a build asset.
                              <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <ImageIcon className="h-4 w-4 text-muted" aria-hidden="true" />
                            )}
                          </button>
                        ) : null}
                        <span className="font-medium">{item.name}</span>
                      </div>
                      {item.modifierGroupCount > 0 && (
                        <span className="ms-2 text-xs text-muted">
                          {item.modifierGroupCount} مجموعة إضافات
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-muted">{item.categoryName ?? '—'}</td>
                    <td className="p-3">
                      <ul className="space-y-0.5">
                        {item.variants.map((v) => (
                          <li key={v.id} className="lb-numeric">
                            {v.name !== 'default' && (
                              <span className="me-1 text-muted">{v.name}:</span>
                            )}
                            {formatMoney(v.priceCents, currency)}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="p-3">
                      <ul className="space-y-1">
                        {item.variants.map((v) => (
                          <li key={v.id}>
                            <Button
                              size="sm"
                              variant={v.isAvailableHere ? 'outline' : 'secondary'}
                              disabled={isPending}
                              onClick={() => toggleAvailability(v.id, !v.isAvailableHere)}
                            >
                              {v.isAvailableHere ? 'متاح' : 'غير متاح'}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </td>
                    {canManage && (
                      <td className="p-3">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isPending}
                          onClick={() => toggleBestSeller(item.id, !item.isBestSeller)}
                        >
                          {item.isBestSeller ? (
                            <Badge tone="info">مُميّز ★</Badge>
                          ) : (
                            <Badge tone="neutral">—</Badge>
                          )}
                        </Button>
                      </td>
                    )}
                    {canManage && (
                      <td className="p-3">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isPending}
                          onClick={() => toggleItem(item.id, !item.isActive)}
                        >
                          {item.isActive ? (
                            <Badge tone="success">مفعّل</Badge>
                          ) : (
                            <Badge tone="neutral">موقوف</Badge>
                          )}
                        </Button>
                      </td>
                    )}
                    {canManage && (
                      <td className="p-3">
                        <div className="flex gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isPending}
                            onClick={() => setEditingId((id) => (id === item.id ? null : item.id))}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                            تعديل
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-danger"
                            disabled={isPending}
                            onClick={() => setDeleting(item)}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                            حذف
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                  {editingId === item.id && (
                    <tr className="border-b border-line bg-surface last:border-0">
                      <td colSpan={canManage ? 7 : 4} className="p-3">
                        <form
                          action={(formData) => saveEdit(item, formData)}
                          className="space-y-3"
                        >
                          <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="اسم الصنف" required>
                              {(p) => <Input {...p} name="name" required maxLength={200} defaultValue={item.name} />}
                            </Field>
                            <Field label="التصنيف">
                              {(p) => (
                                <Select {...p} name="categoryId" defaultValue={item.categoryId ?? ''}>
                                  <option value="">بدون تصنيف</option>
                                  {categories.map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {c.name}
                                    </option>
                                  ))}
                                </Select>
                              )}
                            </Field>
                            <Field label="نسبة الضريبة %">
                              {(p) => (
                                <Input
                                  {...p}
                                  name="taxRatePercent"
                                  type="number"
                                  min={0}
                                  max={100}
                                  step="0.01"
                                  defaultValue={item.taxRateBp / 100}
                                  dir="ltr"
                                />
                              )}
                            </Field>
                            <Field label="زمن التحضير (دقائق)">
                              {(p) => (
                                <Input
                                  {...p}
                                  name="prepMinutes"
                                  type="number"
                                  min={0}
                                  max={600}
                                  defaultValue={item.prepMinutes}
                                  dir="ltr"
                                />
                              )}
                            </Field>
                            <div className="sm:col-span-2">
                              <Field label="الوصف">
                                {(p) => <Textarea {...p} name="description" maxLength={1000} defaultValue={item.description ?? ''} />}
                              </Field>
                            </div>
                          </div>

                          <fieldset className="rounded border border-line p-3">
                            <legend className="px-1 text-sm font-medium">الأحجام والأسعار</legend>
                            <div className="space-y-2">
                              {item.variants.map((v) => (
                                <div key={v.id} className="flex flex-wrap items-end gap-2">
                                  <div className="flex-1">
                                    <label htmlFor={`variant-name-${v.id}`} className="mb-1 block text-xs">
                                      الاسم
                                    </label>
                                    <Input
                                      id={`variant-name-${v.id}`}
                                      name={`variant-name-${v.id}`}
                                      defaultValue={v.name}
                                    />
                                  </div>
                                  <div className="w-32">
                                    <label htmlFor={`variant-price-${v.id}`} className="mb-1 block text-xs">
                                      السعر ({currency})
                                    </label>
                                    <Input
                                      id={`variant-price-${v.id}`}
                                      name={`variant-price-${v.id}`}
                                      defaultValue={(v.priceCents / 100).toFixed(2)}
                                      dir="ltr"
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </fieldset>

                          <div className="flex gap-2">
                            <Button type="submit" disabled={isPending}>
                              حفظ التعديلات
                            </Button>
                            <Button type="button" variant="ghost" onClick={() => setEditingId(null)}>
                              إلغاء
                            </Button>
                          </div>
                        </form>
                      </td>
                    </tr>
                  )}
                  {expandedImageId === item.id && (
                    <tr className="border-b border-line bg-surface last:border-0">
                      <td colSpan={canManage ? 7 : 4} className="space-y-3 p-3">
                        <ImageUpload
                          organizationId={organizationId}
                          purpose="product"
                          value={item.imageUrl}
                          onChange={(url) => saveItemImage(item.id, url)}
                          label={`صورة ${item.name}`}
                          aspectClassName="aspect-square"
                        />
                        {canManage && (
                          <label className="block max-w-xs">
                            <span className="mb-1.5 block text-xs font-semibold text-fg">
                              محطة التحضير
                            </span>
                            <Select
                              defaultValue={item.stationId ?? ''}
                              disabled={isPending}
                              onChange={(e) =>
                                startTransition(async () => {
                                  const result = await setProductStationAction(scope, {
                                    productId: item.id,
                                    stationId: e.target.value || null,
                                  });
                                  if (!result.ok) { toast.error(result.error); return; }
                                  router.refresh();
                                })
                              }
                            >
                              <option value="">تلقائي حسب التصنيف</option>
                              {stations.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} ({STATION_KIND_LABELS[s.kind] ?? s.kind})
                                </option>
                              ))}
                            </Select>
                          </label>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={deleting !== null}
        title={`حذف الصنف ${deleting?.name ?? ''}`}
        description="لن يظهر هذا الصنف بعد الآن في المنيو ولا عند الكاشير. الطلبات السابقة عليه تبقى في السجل كما هي."
        confirmLabel="حذف نهائيًا"
        busy={isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          removeItem(deleting.id);
        }}
      />
    </div>
  );
}
