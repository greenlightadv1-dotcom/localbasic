import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Logo, PoweredBy } from '@/components/brand/logo';
import { requireUser } from '@/modules/core/tenancy/context';
import { listMyWorkspaces } from '@/modules/core/tenancy/service';
import { OnboardingForm } from './onboarding-form';

export const metadata: Metadata = { title: 'إنشاء مساحة العمل' };

export default async function OnboardingPage() {
  await requireUser();

  // Already has a workspace — don't offer to create a second one by accident.
  const workspaces = await listMyWorkspaces();
  if (workspaces.length > 0) redirect(`/${workspaces[0]!.slug}`);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <Logo className="h-12" />
      <main className="w-full max-w-2xl">
        <OnboardingForm />
      </main>
      <PoweredBy />
    </div>
  );
}
