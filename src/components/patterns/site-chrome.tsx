import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { cn } from '@/lib/cn';
import { SITE_NAV, WHATSAPP_MESSAGES, CONTACT_EMAIL, whatsappLink } from '@/config/site';

/** WhatsApp glyph. Inline so the marketing pages pull no icon dependency. */
export function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={cn('h-5 w-5', className)}>
      <path d="M17.47 14.38c-.3-.15-1.74-.86-2-.96-.27-.1-.47-.15-.66.15s-.76.95-.93 1.15-.34.22-.63.07a8.2 8.2 0 0 1-2.4-1.48 9 9 0 0 1-1.67-2.06c-.17-.3 0-.46.13-.6s.3-.35.45-.52a2 2 0 0 0 .3-.5.55.55 0 0 0 0-.53c-.08-.15-.66-1.6-.9-2.18s-.48-.5-.66-.51h-.57a1.1 1.1 0 0 0-.79.37 3.3 3.3 0 0 0-1.03 2.45 5.7 5.7 0 0 0 1.2 3.03c.15.2 2.07 3.16 5.02 4.43a17 17 0 0 0 1.67.62 4 4 0 0 0 1.85.11 3 3 0 0 0 2-1.4 2.5 2.5 0 0 0 .17-1.4c-.07-.13-.27-.2-.56-.35z" />
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2m0 18.2a8.2 8.2 0 0 1-4.2-1.14l-.3-.18-3.1.8.83-3-.2-.31A8.2 8.2 0 1 1 12 20.2" />
    </svg>
  );
}

/** Primary sales CTA. Opens WhatsApp with the message prefilled. */
export function WhatsAppCta({
  message = WHATSAPP_MESSAGES.general,
  children = 'تواصل عبر واتساب',
  className,
  tone = 'solid',
}: {
  message?: string;
  children?: React.ReactNode;
  className?: string;
  tone?: 'solid' | 'outline';
}) {
  return (
    <a
      href={whatsappLink(message)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex h-12 items-center justify-center gap-2 rounded px-6 text-base font-semibold transition-colors',
        tone === 'solid'
          ? 'bg-[#25D366] text-white hover:bg-[#1eb455]'
          : 'border border-line bg-elevated text-fg hover:bg-surface',
        className,
      )}
    >
      <WhatsAppIcon />
      {children}
    </a>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Local Basic" className="shrink-0">
          <Logo className="h-8" />
        </Link>

        <nav className="hidden flex-1 items-center justify-center gap-1 lg:flex">
          {SITE_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-fg"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ms-auto flex items-center gap-2 lg:ms-0">
          <Link
            href="/login"
            className="inline-flex h-10 items-center rounded px-4 text-sm font-semibold text-fg transition-colors hover:bg-surface"
          >
            دخول
          </Link>
          <a
            href={whatsappLink(WHATSAPP_MESSAGES.demo)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center rounded bg-primary px-4 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary/90"
          >
            اطلب عرضًا
          </a>
        </div>
      </div>

      {/* Nav collapses to a scrollable strip rather than a hamburger: five
          links fit, and a menu button would be one more tap for no gain. */}
      <nav className="flex gap-1 overflow-x-auto border-t border-line/60 px-4 py-2 lg:hidden">
        {SITE_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="space-y-4">
          <Logo className="h-9" />
          <p className="max-w-sm text-sm leading-relaxed text-muted">
            منصة تشغيل للأعمال المحلية — نظام متكامل لإدارة المطاعم والكافيهات من نقطة البيع
            حتى التقارير، بالعربية وبالكامل.
          </p>
          <WhatsAppCta className="h-11 px-5 text-sm" />
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-bold text-fg">الخدمات</h3>
          <ul className="space-y-2 text-sm text-muted">
            <li>
              <Link href="/services" className="hover:text-primary">كل الخدمات</Link>
            </li>
            <li>
              <Link href="/services/restaurant" className="hover:text-primary">
                المطاعم والكافيهات
              </Link>
            </li>
          </ul>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-bold text-fg">الشركة</h3>
          <ul className="space-y-2 text-sm text-muted">
            <li><Link href="/about" className="hover:text-primary">من نحن</Link></li>
            <li><Link href="/contact" className="hover:text-primary">تواصل معنا</Link></li>
            <li><Link href="/privacy" className="hover:text-primary">سياسة الخصوصية</Link></li>
            <li><Link href="/terms" className="hover:text-primary">الشروط والأحكام</Link></li>
          </ul>
        </div>
      </div>

      <div className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} Local Basic — A Green Light Company</p>
          <p>
            <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-primary">{CONTACT_EMAIL}</a>
          </p>
        </div>
      </div>
    </footer>
  );
}

export function SiteChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
