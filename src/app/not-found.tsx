import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-4 text-center">
      <Logo className="h-10" />
      <div className="space-y-1">
        <h1 className="text-lg font-bold">الصفحة غير موجودة</h1>
        <p className="text-sm text-muted">
          الرابط غير صحيح، أو لا تملك صلاحية الوصول إلى هذا المحتوى.
        </p>
      </div>
      <Link href="/">
        <Button variant="outline">العودة للرئيسية</Button>
      </Link>
    </div>
  );
}
