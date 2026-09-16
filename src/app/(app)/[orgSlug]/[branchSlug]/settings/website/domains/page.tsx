import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listDomains } from '@/modules/restaurant/website/domains';
import {
  DOMAIN_STATUS_HINTS, DOMAIN_STATUS_LABELS, challengeRecordName, dnsInstructions,
} from '@/modules/restaurant/website/domains-shared';
import { getWebsiteSettings } from '@/modules/restaurant/website/settings';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import {
  AddDomainForm, PrimaryButton, RemoveButton, StatusButton, VerifyButton,
} from './forms';

export const metadata = { title: 'النطاقات' };
export const dynamic = 'force-dynamic';

const STATUS_TONE = {
  pending: 'warn',
  verified: 'info',
  active: 'success',
  disabled: 'danger',
} as const;

/** A DNS record, shown the way a DNS provider's form asks for it. */
function Record({ type, name, value }: { type: string; name: string; value: string }) {
  return (
    <div className="grid gap-1 rounded border border-line bg-surface p-3 text-xs sm:grid-cols-[5rem_1fr]">
      <span className="font-semibold text-muted">النوع</span>
      <span className="font-mono text-fg" dir="ltr">{type}</span>
      <span className="font-semibold text-muted">الاسم</span>
      <span className="break-all font-mono text-fg" dir="ltr">{name}</span>
      <span className="font-semibold text-muted">القيمة</span>
      <span className="break-all font-mono text-fg" dir="ltr">{value}</span>
    </div>
  );
}

/**
 * Custom domains.
 *
 * Deliberately honest about the division of labour: LocalBasic owns ownership,
 * state and routing. DNS belongs to the customer's registrar and the
 * certificate belongs to the host. A domain being ACTIVE here means LocalBasic
 * will serve this restaurant for that hostname — not that the hostname
 * reaches us, which also needs their DNS records and the domain attached to
 * the deployment.
 */
export default async function DomainsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: {
    added?: string; token?: string; verified?: string; unverified?: string;
    activated?: string; disabled?: string; removed?: string; saved?: string; error?: string;
  };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'settings.manage')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  const [domains, settings] = await Promise.all([
    listDomains(ctx),
    getWebsiteSettings(ctx),
  ]);

  const base = `/${params.orgSlug}/${params.branchSlug}/settings/website`;
  const justAdded = searchParams.added && searchParams.token
    ? { hostname: searchParams.added, token: searchParams.token }
    : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-wrap items-center gap-2">
          <CardTitle>النطاقات</CardTitle>
          <div className="ms-auto flex gap-2">
            <Link
              href={base}
              className="inline-flex h-9 items-center rounded px-3 text-sm font-semibold text-muted hover:text-fg"
            >
              إعدادات الموقع
            </Link>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          {searchParams.verified ? <Alert tone="success">تم توثيق النطاق.</Alert> : null}
          {searchParams.unverified ? (
            <Alert tone="warn">
              لم نعثر على سجل TXT مطابق بعد. قد يستغرق انتشار DNS حتى ٢٤ ساعة.
            </Alert>
          ) : null}
          {searchParams.activated ? (
            <Alert tone="success">
              <span data-testid="domain-activated">تم تفعيل النطاق.</span>
            </Alert>
          ) : null}
          {searchParams.disabled ? <Alert tone="warn">تم إيقاف النطاق.</Alert> : null}
          {searchParams.removed ? <Alert tone="warn">تم حذف النطاق.</Alert> : null}
          {searchParams.saved ? <Alert tone="success">تم الحفظ.</Alert> : null}
          {searchParams.error ? <Alert tone="danger">{searchParams.error}</Alert> : null}

          {!settings.enabled ? (
            <Alert tone="warn">
              الموقع غير منشور من إعدادات الموقع، فلن يعمل أي نطاق حتى تنشره.
            </Alert>
          ) : null}

          <p className="text-sm text-muted">
            يمكنك ربط نطاقك الخاص بموقع مطعمك. سيظل عنوان LocalBasic يعمل كما هو.
          </p>

          <AddDomainForm orgSlug={params.orgSlug} branchSlug={params.branchSlug} />
        </CardBody>
      </Card>

      {justAdded ? (
        <Card>
          <CardHeader>
            <CardTitle>انسخ قيمة التحقّق الآن</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {/* Shown once, and only here: the database keeps a hash, so this
                value cannot be displayed again after you leave the page. */}
            <Alert tone="warn">
              لن تظهر هذه القيمة مرة أخرى. انسخها الآن وأضفها في إعدادات DNS.
            </Alert>
            <Record
              type="TXT"
              name={challengeRecordName(justAdded.hostname)}
              value={justAdded.token}
            />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>نطاقاتك</CardTitle>
        </CardHeader>
        <CardBody>
          {domains.length === 0 ? (
            <p className="rounded border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
              لا توجد نطاقات. موقعك متاح على عنوان LocalBasic.
            </p>
          ) : (
            <ul className="space-y-4">
              {domains.map((d) => {
                const dns = dnsInstructions(d.hostname);
                return (
                  <li key={d.id} className="rounded-lg border border-line">
                    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
                      <span className="font-mono font-bold text-fg" dir="ltr">{d.hostname}</span>
                      <Badge tone={STATUS_TONE[d.status]}>{DOMAIN_STATUS_LABELS[d.status]}</Badge>
                      {d.isPrimary ? <Badge tone="info">الأساسي</Badge> : null}
                      <span className="ms-auto flex flex-wrap items-center gap-1">
                        {d.status === 'pending' || d.status === 'disabled' ? (
                          <VerifyButton
                            orgSlug={params.orgSlug}
                            branchSlug={params.branchSlug}
                            id={d.id}
                            hostname={d.hostname}
                          />
                        ) : null}
                        {d.status === 'verified' ? (
                          <StatusButton
                            orgSlug={params.orgSlug}
                            branchSlug={params.branchSlug}
                            id={d.id}
                            to="active"
                          />
                        ) : null}
                        {d.status === 'active' ? (
                          <>
                            {!d.isPrimary ? (
                              <PrimaryButton
                                orgSlug={params.orgSlug}
                                branchSlug={params.branchSlug}
                                id={d.id}
                              />
                            ) : null}
                            <StatusButton
                              orgSlug={params.orgSlug}
                              branchSlug={params.branchSlug}
                              id={d.id}
                              to="disabled"
                            />
                          </>
                        ) : null}
                        <RemoveButton
                          orgSlug={params.orgSlug}
                          branchSlug={params.branchSlug}
                          id={d.id}
                        />
                      </span>
                    </div>

                    <div className="space-y-3 px-4 py-3">
                      <p className="text-xs text-muted">{DOMAIN_STATUS_HINTS[d.status]}</p>

                      {d.verificationError ? (
                        <p className="text-xs text-danger">{d.verificationError}</p>
                      ) : null}

                      {d.status !== 'active' ? (
                        <div className="space-y-2">
                          <p className="text-xs font-semibold text-fg">١. سجل إثبات الملكية</p>
                          <Record
                            type={dns.verification.type}
                            name={dns.verification.name}
                            value={dns.verification.value}
                          />
                        </div>
                      ) : null}

                      <div className="space-y-2">
                        <p className="text-xs font-semibold text-fg">
                          {d.status !== 'active' ? '٢. ' : ''}سجل التوجيه
                        </p>
                        {dns.routing.map((r) => (
                          <Record key={r.type} type={r.type} name={r.name} value={r.value} />
                        ))}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-2 text-xs leading-relaxed text-muted">
          <p className="font-semibold text-fg">ماذا يعني «مفعّل»</p>
          <p>
            «مفعّل» يعني أن LocalBasic سيعرض موقع مطعمك لهذا النطاق. لكي يصل الزائر فعليًا،
            يجب أيضًا أن تكون سجلات DNS لديك صحيحة وأن يكون النطاق مضافًا في الاستضافة.
            شهادة HTTPS تصدرها الاستضافة تلقائيًا بعد صحة السجلات.
          </p>
          <p>
            النطاق الموقوف يظل محجوزًا باسمك ولا يستطيع مطعم آخر استخدامه. الحذف وحده
            يحرّر الاسم.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
