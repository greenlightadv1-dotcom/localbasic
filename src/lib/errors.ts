/**
 * Typed application errors.
 *
 * Every error carries a message that is safe to show a user. Details that
 * would help an attacker (row ids, SQL, stack traces) stay in `cause` and are
 * logged server-side only.
 */
export type AppErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'rate_limited'
  | 'approval_required'
  | 'internal';

const STATUS: Record<AppErrorCode, number> = {
  unauthenticated: 401,
  // Resources the caller may not reach are reported as 404, never 403, so that
  // ids and slugs cannot be probed for existence.
  forbidden: 404,
  not_found: 404,
  validation: 422,
  conflict: 409,
  rate_limited: 429,
  approval_required: 403,
  internal: 500,
};

const PUBLIC_MESSAGE: Record<AppErrorCode, string> = {
  unauthenticated: 'يلزم تسجيل الدخول للمتابعة.',
  forbidden: 'غير موجود.',
  not_found: 'غير موجود.',
  validation: 'تحقق من البيانات المدخلة.',
  conflict: 'هذه البيانات مستخدمة بالفعل.',
  rate_limited: 'محاولات كثيرة. برجاء المحاولة بعد قليل.',
  approval_required: 'هذا الإجراء يحتاج موافقة المدير.',
  internal: 'حدث خطأ غير متوقع. تمت المحاولة وتسجيل المشكلة.',
};

/** Which manager-PIN gate refused, and for how much (LB403's HINT, 0108). */
export type ApprovalNeeded = { action: string; amount: number | null };

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly fieldErrors?: Record<string, string[]>;
  readonly approval?: ApprovalNeeded;

  constructor(
    code: AppErrorCode,
    message?: string,
    options?: { cause?: unknown; fieldErrors?: Record<string, string[]>; approval?: ApprovalNeeded },
  ) {
    super(message ?? PUBLIC_MESSAGE[code], { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.fieldErrors = options?.fieldErrors;
    this.approval = options?.approval;
  }
}

export const unauthenticated = () => new AppError('unauthenticated');
/** Deliberately indistinguishable from `notFound` to the caller. */
export const forbidden = (cause?: unknown) => new AppError('forbidden', undefined, { cause });
export const notFound = () => new AppError('not_found');
export const conflict = (message: string) => new AppError('conflict', message);

/**
 * Normalises anything thrown into an AppError, logging the original so the
 * cause survives without ever being sent to the client.
 */
export function toAppError(error: unknown, context: string): AppError {
  if (error instanceof AppError) return error;
  if (isRateLimitedDbError(error)) return rateLimited(error as { message?: string });
  if (isApprovalRequiredDbError(error)) return approvalRequired(error);
  console.error(`[localbasic] ${context}`, error);
  return new AppError('internal', undefined, { cause: error });
}

/**
 * A read that failed for a reason the page can explain (usually a database
 * migration that has not been applied yet), so it can render a message in
 * place instead of the generic error screen.
 */
export class DataUnavailableError extends AppError {
  readonly reason: 'missing_migration' | 'denied' | 'failed';

  constructor(reason: DataUnavailableError['reason'], message: string, cause?: unknown) {
    super('internal', message, { cause });
    this.name = 'DataUnavailableError';
    this.reason = reason;
  }
}

/** Postgres / PostgREST codes for "that function, table or column does not exist". */
const MISSING_OBJECT_CODES = new Set(['42883', '42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205']);

/**
 * Classifies a Supabase error from a read so the caller can show the right
 * message: an unapplied migration, a permission/RLS refusal, or a plain failure.
 */
export function toDataUnavailable(error: { code?: string; message?: string } | null | undefined, context: string): DataUnavailableError {
  console.error(`[localbasic] ${context}`, error);
  const code = error?.code ?? '';
  if (MISSING_OBJECT_CODES.has(code)) {
    return new DataUnavailableError(
      'missing_migration',
      'هذه الصفحة تحتاج تحديثًا لقاعدة البيانات لم يُطبَّق بعد. شغّل أحدث ملفات الـ migrations في Supabase ثم أعد تحميل الصفحة.',
      error,
    );
  }
  if (code === '42501') {
    return new DataUnavailableError('denied', 'لا تملك صلاحية عرض هذه البيانات.', error);
  }
  return new DataUnavailableError('failed', 'تعذّر تحميل البيانات حاليًا. حاول مرة أخرى بعد قليل.', error);
}

/**
 * SQLSTATE raised by the database's own abuse limits (0100). Those limits run
 * inside the anonymous functions, so they hold even for callers who skip
 * Next.js and hit the REST API directly.
 */
export const DB_RATE_LIMITED = 'LB429';

/** The database's own Arabic reason when it gave one ("verify your number first"), else the default. */
function rateLimited(error: { message?: string }): AppError {
  return new AppError('rate_limited', /[\u0600-\u06FF]/.test(error.message ?? '') ? error.message : undefined);
}

function isRateLimitedDbError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DB_RATE_LIMITED;
}

/** Text Postgres itself generates: table, column and constraint names, SQL fragments. */
const INTERNAL_DETAIL = /relation|column|constraint|violates|duplicate key|syntax|does not exist|permission denied|invalid input|null value|operator|function /i;

/**
 * For errors from a public (guest-facing) checkout function. Messages the
 * function raises on purpose ("order below the minimum") reach the guest;
 * anything Postgres generated is logged and replaced, so a guest never sees
 * table names, constraint names or SQL.
 */
export function guestFacingDbError(
  error: { code?: string; message?: string },
  context: string,
  fallback = 'تعذّر إتمام الطلب. حاول مرة أخرى.',
): AppError {
  if (error.code === DB_RATE_LIMITED) return rateLimited(error);
  const message = error.message ?? '';
  const raisedOnPurpose = ['22023', '23514', 'P0001'].includes(error.code ?? '');
  if (message && raisedOnPurpose && !INTERNAL_DETAIL.test(message)) {
    return new AppError('validation', message);
  }
  console.error(`[localbasic] ${context}`, error);
  return new AppError('validation', fallback);
}

/**
 * SQLSTATE raised when a sensitive action needs a manager's PIN (0103). The
 * screens answer it by opening the approval dialog and retrying.
 */
export const DB_APPROVAL_REQUIRED = 'LB403';

function isApprovalRequiredDbError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DB_APPROVAL_REQUIRED;
}

/** "order.discount:1500" → { action, amount }; anything else → undefined. */
export function parseApprovalHint(hint: unknown): ApprovalNeeded | undefined {
  if (typeof hint !== 'string') return undefined;
  const m = /^([a-z]+\.[a-z_]+):(\d*)$/.exec(hint.trim());
  if (!m) return undefined;
  return { action: m[1]!, amount: m[2] ? Number(m[2]) : null };
}

function approvalRequired(error: unknown): AppError {
  return new AppError('approval_required', undefined, { approval: parseApprovalHint((error as { hint?: unknown }).hint) });
}

/**
 * For staff-facing database calls whose functions raise their own Arabic
 * reasons ("الرصيد غير كافٍ في المخزن"). Those reach the screen; anything
 * Postgres generated is logged and replaced; approval and rate limits keep
 * their own codes.
 */
export function staffDbError(error: { code?: string; message?: string; hint?: string }, context: string): AppError {
  if (error.code === DB_APPROVAL_REQUIRED) return approvalRequired(error);
  if (error.code === DB_RATE_LIMITED) return rateLimited(error);
  const message = error.message ?? '';
  // A refusal the function explained ("لا يمكن لنفس الشخص الصرف والاستلام")
  // is shown; a bare "not permitted" stays the generic not-found answer.
  if (error.code === '42501' || error.code === '28000') {
    return /[\u0600-\u06FF]/.test(message) ? new AppError('forbidden', message) : toAppError(error, context);
  }
  if (/[\u0600-\u06FF]/.test(message) && !INTERNAL_DETAIL.test(message)) {
    return new AppError('validation', message);
  }
  return toAppError(error, context);
}
