import { Logo, PoweredBy } from '@/components/brand/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <Logo className="h-12" />
      <main className="w-full max-w-md">{children}</main>
      <PoweredBy />
    </div>
  );
}
