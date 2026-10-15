'use client';

import { useState, useTransition } from 'react';
import { KeyRound } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { setApprovalPinAction } from './actions';

export function ApprovalPinForm({ scope, hasPin }: { scope: { organizationSlug: string; branchSlug: string }; hasPin: boolean }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const r = await setApprovalPinAction(scope, { pin, confirm });
      if (!r.ok) {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
        return;
      }
      setErrors({});
      setPin('');
      setConfirm('');
      toast.success('تم حفظ رمز الموافقة');
    });
  }

  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 8);

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" aria-hidden="true" /> رمز الموافقة
          {hasPin ? <Badge tone="success">مضبوط</Badge> : <Badge tone="warn">غير مضبوط</Badge>}
        </CardTitle>
      </CardHeader>
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-muted">
            تكتب هذا الرمز على جهاز الكاشير لتوافق على إلغاء طلب بعد إرساله للتحضير، أو خصم، أو تسوية مخزون.
            كل موافقة تُسجَّل باسمك وتصلح لعملية واحدة فقط.
          </p>
          <Field label={hasPin ? 'الرمز الجديد' : 'الرمز'} hint="من 4 إلى 8 أرقام، وليس أرقامًا متكررة أو متتالية" error={errors.pin}>
            {(p) => <Input {...p} type="password" inputMode="numeric" autoComplete="new-password" dir="ltr" value={pin} onChange={(e) => setPin(digits(e.target.value))} data-testid="pin-new" />}
          </Field>
          <Field label="تأكيد الرمز" error={errors.confirm}>
            {(p) => <Input {...p} type="password" inputMode="numeric" autoComplete="new-password" dir="ltr" value={confirm} onChange={(e) => setConfirm(digits(e.target.value))} data-testid="pin-confirm" />}
          </Field>
          <p className="text-xs text-muted">خمس محاولات خاطئة متتالية توقف الرمز 15 دقيقة. لا تشارك رمزك مع أحد.</p>
          <Button type="submit" disabled={pending || pin.length < 4}>{hasPin ? 'تغيير الرمز' : 'حفظ الرمز'}</Button>
        </form>
      </CardBody>
    </Card>
  );
}
