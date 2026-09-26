import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { AppError } from '@/lib/errors';
import { getPublicContext, getPublicMenu } from '@/modules/restaurant/public/service';
import { lavechiCssVars } from '@/modules/restaurant/website/lavechi-theme';
import { GuestMenu } from './guest-menu';

export const dynamic = 'force-dynamic';

/**
 * The page a guest reaches by scanning a table QR.
 *
 * The token in the URL is the only identity involved: it resolves to the
 * restaurant, branch and table server-side. No internal id appears here, the
 * guest needs no account, and the page is not indexed.
 */
export async function generateMetadata({
  params,
}: {
  params: { token: string };
}): Promise<Metadata> {
  try {
    const context = await getPublicContext(params.token);
    return {
      title: `${context.organizationName} — منيو`,
      robots: { index: false, follow: false },
    };
  } catch {
    return { title: 'غير متاح', robots: { index: false, follow: false } };
  }
}

export default async function PublicMenuPage({ params }: { params: { token: string } }) {
  let context;
  try {
    context = await getPublicContext(params.token);
  } catch (error) {
    // A revoked, expired or unknown token is a 404 — indistinguishable from
    // one that never existed.
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }

  const menu = await getPublicMenu(params.token);

  return (
    <div
      className="min-h-dvh bg-[radial-gradient(circle_at_50%_18%,#0C3624,#07231A_60%)] text-[#F4F1E4]"
      style={lavechiCssVars() as React.CSSProperties}
    >
      <GuestMenu token={params.token} context={context} menu={menu} />
    </div>
  );
}
