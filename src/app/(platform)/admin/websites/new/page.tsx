import { listCandidateOrganizations, SITE_TYPES } from '@/modules/platform/websites/service';
import { adminMetadata } from '@/modules/platform/admin/metadata';
import { AdminHeading, Panel } from '../../ui';
import { CreateWebsiteForm } from './form';

export const generateMetadata = adminMetadata('موقع جديد');
export const dynamic = 'force-dynamic';

export default async function NewWebsitePage() {
  // The organization list is built server-side and the form posts back one of
  // its ids. The service re-resolves whatever id arrives rather than trusting
  // that it came from this list.
  const organizations = await listCandidateOrganizations();

  return (
    <>
      <AdminHeading
        title="موقع جديد"
        lead="اختر العميل، ثم صف ما تريده. تُنشأ مسودة أولية من بيانات العميل نفسها، وتُحرَّر بعدها."
      />
      <Panel className="p-6">
        <CreateWebsiteForm organizations={organizations} siteTypes={[...SITE_TYPES]} />
      </Panel>
    </>
  );
}
