import 'server-only';
import { IMPORT_LIMITS, ImportParseError } from './parse';

/**
 * Google Sheets, the part that can be done safely today.
 *
 * WHAT IS SUPPORTED: a sheet whose sharing is set to "anyone with the link can
 * view". Its CSV export endpoint is fetched server-side and parsed like any
 * other CSV.
 *
 * WHAT IS NOT, and is not faked: a PRIVATE sheet. Reading one needs OAuth —
 * a Google Cloud project, a consent screen, a stored refresh token per
 * organization and a token-exchange route. None of that exists in this
 * repository, and none of it is simulated here. The UI says so, and it does
 * not ask anyone to paste a service-account key into a form.
 *
 * NOT AN ARBITRARY URL FETCHER. Only docs.google.com is reachable, only over
 * https, and only the two export paths below. Every other host — including a
 * redirect target, a private address, a link-local metadata endpoint or a
 * different Google product — is refused before any socket is opened, which is
 * what keeps this from becoming a server-side request forgery primitive.
 */

/** Anything that is not a public Google Sheets document. */
export class SheetSourceError extends Error {}

const SHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;

export type SheetSource = {
  /** The document id, as it appears in the URL. */
  documentId: string;
  /** The specific tab, when the link names one. */
  gid: string | null;
  /** The export URL that will actually be requested. */
  exportUrl: string;
};

/**
 * Parses a pasted link into the one request that may be made from it.
 *
 * The returned URL is CONSTRUCTED here from an id and a gid, never taken from
 * the input — so a query string, a fragment, a userinfo segment or an embedded
 * second URL in what was pasted cannot survive into the request.
 */
export function parseSheetUrl(raw: string): SheetSource {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SheetSourceError('الرابط غير صالح.');
  }

  if (url.protocol !== 'https:') {
    throw new SheetSourceError('يجب أن يبدأ الرابط بـ https://');
  }
  // Exact host, not a suffix test: docs.google.com.evil.example would pass a
  // naive endsWith and is refused here.
  if (url.hostname !== 'docs.google.com') {
    throw new SheetSourceError('يُقبل رابط Google Sheets فقط (docs.google.com).');
  }
  if (url.username !== '' || url.password !== '') {
    throw new SheetSourceError('الرابط غير صالح.');
  }

  const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
  if (!id || !SHEET_ID.test(id)) {
    throw new SheetSourceError('تعذّر التعرّف على معرّف الجدول في الرابط.');
  }

  // The tab may be in the fragment (#gid=0) or the query (?gid=0).
  const gidRaw =
    url.searchParams.get('gid') ?? /(?:^|[#&])gid=(\d+)/.exec(url.hash)?.[1] ?? null;
  const gid = gidRaw && /^\d{1,20}$/.test(gidRaw) ? gidRaw : null;

  const exportUrl =
    `https://docs.google.com/spreadsheets/d/${id}/export?format=csv` +
    (gid ? `&gid=${gid}` : '');

  return { documentId: id, gid, exportUrl };
}

/**
 * Fetches the export, bounded.
 *
 * `redirect: 'error'` rather than 'follow': Google answers a private sheet
 * with a redirect to a sign-in page, and following it would both leak the
 * request off the allowed host and return an HTML login form that the CSV
 * parser would happily read as data.
 */
export async function fetchSheetCsv(source: SheetSource): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let response: Response;
  try {
    response = await fetch(source.exportUrl, {
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'text/csv,text/plain' },
      cache: 'no-store',
    });
  } catch {
    throw new SheetSourceError(
      'تعذّر قراءة الجدول. تأكد أن المشاركة مضبوطة على "أي شخص لديه الرابط يمكنه الاطّلاع".',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new SheetSourceError(
      'تعذّر قراءة الجدول. تأكد أن المشاركة مضبوطة على "أي شخص لديه الرابط يمكنه الاطّلاع".',
    );
  }

  // A private sheet that answers 200 answers with HTML, not CSV.
  const contentType = response.headers.get('content-type') ?? '';
  if (!/text\/csv|text\/plain|application\/octet-stream/.test(contentType)) {
    throw new SheetSourceError(
      'الجدول ليس متاحًا للقراءة عبر الرابط. غيّر المشاركة إلى "أي شخص لديه الرابط".',
    );
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > IMPORT_LIMITS.maxBytes) {
    throw new ImportParseError('الملف أكبر من الحد المسموح.');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  // Checked again after reading: content-length is a claim, not a guarantee.
  if (buffer.length > IMPORT_LIMITS.maxBytes) {
    throw new ImportParseError('الملف أكبر من الحد المسموح.');
  }

  return buffer.toString('utf8');
}
