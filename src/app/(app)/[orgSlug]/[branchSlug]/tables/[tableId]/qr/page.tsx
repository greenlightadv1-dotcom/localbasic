import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getTableForPrint } from '@/modules/restaurant/tables/service';
import { getBranding } from '@/modules/core/branding/service';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { PrintButton } from './print-button';

export const metadata = { title: 'رمز QR' };

/**
 * The printable QR card for one table.
 *
 * The code encodes only the public URL with its opaque token — no table id, no
 * branch id, no restaurant id — so the printed card reveals nothing and keeps
 * working through every menu change.
 */
export default async function TableQrPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string; tableId: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.table.read')) notFound();

  const [{ table, url, svg }, branding] = await Promise.all([
    getTableForPrint(ctx, params.tableId),
    getBranding(ctx),
  ]);

  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Link href={`${base}/tables`}>
          <Button variant="ghost" size="sm">
            <ArrowRight className="h-4 w-4 lb-flip" aria-hidden="true" />
            الطاولات
          </Button>
        </Link>
        {svg && <PrintButton />}
      </div>

      {!svg ? (
        <Alert tone="warn" title="لا يوجد رمز QR لهذه الطاولة">
          أنشئ رمزًا من صفحة الطاولات.
        </Alert>
      ) : (
        <div className="rounded-lg border border-line bg-white p-8 text-center text-[#0E1330] print:border-0">
          <p className="text-lg font-bold">{branding.displayName}</p>
          <p className="mt-1 text-sm opacity-70">{ctx.branchName}</p>

          <p className="mt-6 text-5xl font-black">{table.name}</p>
          <p className="mt-1 text-sm opacity-70">رقم الطاولة</p>

          <div
            className="mx-auto mt-6 w-64 [&>svg]:h-auto [&>svg]:w-full"
            // The SVG comes from the qrcode library on the server, not from
            // user input, and is regenerated on every request.
            dangerouslySetInnerHTML={{ __html: svg }}
          />

          <p className="mt-6 text-base font-semibold">امسح الرمز لعرض المنيو والطلب</p>
          <p className="mt-1 text-xs opacity-60" dir="ltr">
            {url}
          </p>

          {!branding.whiteLabel && (
            <p className="mt-6 text-xs opacity-50">
              مدعوم بواسطة LocalBasic — A Green Light Company
            </p>
          )}
        </div>
      )}
    </div>
  );
}
