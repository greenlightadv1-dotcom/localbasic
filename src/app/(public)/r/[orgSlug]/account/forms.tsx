'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import type { SavedAddress } from '@/modules/restaurant/account/service';
import {
  customerSignInAction, customerSignOutAction, customerSignUpAction,
  deleteAddressAction, saveAddressAction, saveProfileAction, saveSettingsAction,
  toggleFavoriteAction, type AccountState,
} from './actions';

/**
 * The account's interactive parts.
 *
 * Every one of these posts to a Server Action. None of them decides anything:
 * ownership, validation and the tenant boundary are all settled in the
 * database, and a form that renders is not a form that is authorised.
 */

function Submit({ label, block = true }: { label: string; block?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" block={block} disabled={pending}>
      {pending ? 'جارٍ الحفظ…' : label}
    </Button>
  );
}

export function SignOutButton({ orgSlug }: { orgSlug: string }) {
  return (
    <form action={customerSignOutAction}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <Button type="submit" variant="ghost" size="sm">
        تسجيل الخروج
      </Button>
    </form>
  );
}

export function CustomerAuthForm({
  mode,
  orgSlug,
  claim,
}: {
  mode: 'sign-in' | 'sign-up';
  orgSlug: string | null;
  claim: string | null;
}) {
  const [state, formAction] = useFormState<AccountState, FormData>(
    mode === 'sign-in' ? customerSignInAction : customerSignUpAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {orgSlug && <input type="hidden" name="orgSlug" value={orgSlug} />}
      {/* The order-status token the customer already holds, carried through
          the form so the order can be attached the moment they are signed in. */}
      {claim && <input type="hidden" name="claim" value={claim} />}

      {mode === 'sign-up' && (
        <Field label="الاسم" required>
          {(p) => <Input {...p} name="name" autoComplete="name" required minLength={2} />}
        </Field>
      )}

      <Field label="البريد الإلكتروني" required>
        {(p) => <Input {...p} name="email" type="email" autoComplete="email" required dir="ltr" />}
      </Field>

      <Field label="كلمة المرور" required hint={mode === 'sign-up' ? '8 أحرف على الأقل' : undefined}>
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            minLength={8}
            required
            dir="ltr"
          />
        )}
      </Field>

      {mode === 'sign-up' && (
        <Field label="تأكيد كلمة المرور" required>
          {(p) => (
            <Input
              {...p}
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              dir="ltr"
            />
          )}
        </Field>
      )}

      <Submit label={mode === 'sign-in' ? 'دخول' : 'إنشاء الحساب'} />
    </form>
  );
}

export function ProfileForm({
  orgSlug,
  name,
  phone,
  email,
}: {
  orgSlug: string;
  name: string;
  phone: string | null;
  email: string | null;
}) {
  const [state, formAction] = useFormState<AccountState, FormData>(saveProfileAction, undefined);

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <input type="hidden" name="orgSlug" value={orgSlug} />

      <Field label="الاسم" required>
        {(p) => <Input {...p} name="name" defaultValue={name} required minLength={2} />}
      </Field>

      <Field label="رقم الهاتف" hint="نستخدمه للتواصل بخصوص طلباتك.">
        {(p) => (
          <Input {...p} name="phone" type="tel" defaultValue={phone ?? ''} dir="ltr" maxLength={32} />
        )}
      </Field>

      {/* Read-only on purpose. The address is the identity the customer signs
          in with; changing it is an Auth operation, and writing a new value
          into the restaurant's record would only make the two disagree. */}
      <Field label="البريد الإلكتروني" hint="لتغيير بريدك تواصل معنا — البريد هو هويتك في تسجيل الدخول.">
        {(p) => <Input {...p} value={email ?? ''} readOnly disabled dir="ltr" />}
      </Field>

      <Submit label="حفظ" />
    </form>
  );
}

export function SettingsForm({
  orgSlug,
  marketing,
  orderUpdates,
}: {
  orgSlug: string;
  marketing: boolean;
  orderUpdates: boolean;
}) {
  const [state, formAction] = useFormState<AccountState, FormData>(saveSettingsAction, undefined);

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <input type="hidden" name="orgSlug" value={orgSlug} />

      <label className="flex items-start gap-3 rounded border border-line bg-elevated p-3">
        <input
          type="checkbox"
          name="orderUpdates"
          defaultChecked={orderUpdates}
          className="mt-1 h-4 w-4 accent-[rgb(var(--lb-primary))]"
        />
        <span>
          <span className="block text-sm font-medium text-fg">تحديثات الطلبات</span>
          <span className="block text-xs text-muted">
            أن يصلني تحديث بحالة الطلب عندما يتاح ذلك.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-3 rounded border border-line bg-elevated p-3">
        <input
          type="checkbox"
          name="marketing"
          defaultChecked={marketing}
          className="mt-1 h-4 w-4 accent-[rgb(var(--lb-primary))]"
        />
        <span>
          <span className="block text-sm font-medium text-fg">العروض والرسائل التسويقية</span>
          <span className="block text-xs text-muted">اختياري تمامًا، ويمكنك إيقافه في أي وقت.</span>
        </span>
      </label>

      <Submit label="حفظ التفضيلات" />
    </form>
  );
}

export function AddressForm({
  orgSlug,
  address,
  onDone,
}: {
  orgSlug: string;
  address?: SavedAddress;
  onDone?: () => void;
}) {
  const [state, formAction] = useFormState<AccountState, FormData>(saveAddressAction, undefined);

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <input type="hidden" name="orgSlug" value={orgSlug} />
      {address && <input type="hidden" name="id" value={address.id} />}

      <Field label="اسم العنوان" required hint="مثلاً: البيت، الشغل">
        {(p) => (
          <Input {...p} name="label" defaultValue={address?.label ?? ''} required maxLength={60} />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="المدينة">
          {(p) => <Input {...p} name="city" defaultValue={address?.city ?? ''} maxLength={120} />}
        </Field>
        <Field label="المنطقة">
          {(p) => <Input {...p} name="area" defaultValue={address?.area ?? ''} maxLength={120} />}
        </Field>
      </div>

      <Field label="العنوان بالتفصيل" required>
        {(p) => (
          <Textarea
            {...p}
            name="address"
            defaultValue={address?.address ?? ''}
            required
            minLength={5}
            maxLength={500}
          />
        )}
      </Field>

      <Field label="علامة مميزة">
        {(p) => (
          <Input {...p} name="landmark" defaultValue={address?.landmark ?? ''} maxLength={240} />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="اسم المستلم">
          {(p) => (
            <Input
              {...p}
              name="recipientName"
              defaultValue={address?.recipientName ?? ''}
              maxLength={120}
            />
          )}
        </Field>
        <Field label="هاتف المستلم">
          {(p) => (
            <Input
              {...p}
              name="phone"
              type="tel"
              defaultValue={address?.phone ?? ''}
              dir="ltr"
              maxLength={32}
            />
          )}
        </Field>
      </div>

      <label className="flex items-center gap-3 text-sm text-fg">
        <input
          type="checkbox"
          name="isDefault"
          defaultChecked={address?.isDefault ?? false}
          className="h-4 w-4 accent-[rgb(var(--lb-primary))]"
        />
        العنوان الافتراضي
      </label>

      <div className="flex gap-2">
        <Submit label={address ? 'حفظ التعديلات' : 'إضافة العنوان'} block={false} />
        {onDone && (
          <Button type="button" variant="ghost" onClick={onDone}>
            إلغاء
          </Button>
        )}
      </div>
    </form>
  );
}

export function AddAddress({ orgSlug }: { orgSlug: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return <Button onClick={() => setOpen(true)}>إضافة عنوان جديد</Button>;
  }
  return <AddressForm orgSlug={orgSlug} onDone={() => setOpen(false)} />;
}

export function EditAddress({ orgSlug, address }: { orgSlug: string; address: SavedAddress }) {
  const [open, setOpen] = useState(false);

  // A successful save redirects, and Next keeps this component mounted across
  // that navigation — so the form would sit open over a row that already
  // shows the new values. Collapsing when the row's data changes closes it
  // exactly when the save landed.
  useEffect(() => {
    setOpen(false);
  }, [address.label, address.address, address.city, address.area, address.landmark,
      address.recipientName, address.phone, address.isDefault]);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        تعديل
      </Button>
    );
  }
  return <AddressForm orgSlug={orgSlug} address={address} onDone={() => setOpen(false)} />;
}

export function DeleteAddressButton({ orgSlug, id }: { orgSlug: string; id: string }) {
  return (
    <form action={deleteAddressAction}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="sm" className="text-danger hover:bg-danger/10">
        حذف
      </Button>
    </form>
  );
}

export function FavoriteButton({
  orgSlug,
  productId,
  isFavorite,
  from,
}: {
  orgSlug: string;
  productId: string;
  /** Whether the product is already saved — the button offers the opposite. */
  isFavorite: boolean;
  from: 'menu' | 'account';
}) {
  return (
    <form action={toggleFavoriteAction}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="on" value={isFavorite ? '0' : '1'} />
      <input type="hidden" name="from" value={from} />
      <Button type="submit" variant="ghost" size="sm">
        {isFavorite ? 'إزالة من المفضلة' : 'أضف للمفضلة'}
      </Button>
    </form>
  );
}
