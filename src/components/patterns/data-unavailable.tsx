import { DataUnavailableError } from '@/lib/errors';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/patterns/states';

/**
 * Shown in place of a page body when its data could not be read. Failures we
 * can explain (an unapplied migration, a permission refusal) say so; anything
 * else gets a generic retry message. The underlying error is already logged.
 */
export function DataUnavailable({ error }: { error: unknown }) {
  const known = error instanceof DataUnavailableError ? error : null;
  return (
    <Card>
      <ErrorState
        title={known?.reason === 'missing_migration' ? 'قاعدة البيانات تحتاج تحديثًا' : 'تعذّر تحميل البيانات'}
        description={known?.message ?? 'حدث خطأ غير متوقع أثناء تحميل الصفحة. حاول مرة أخرى بعد قليل.'}
      />
    </Card>
  );
}
