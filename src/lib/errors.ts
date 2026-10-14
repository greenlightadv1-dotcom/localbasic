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
  internal: 500,
};

const PUBLIC_MESSAGE: Record<AppErrorCode, string> = {
  unauthenticated: 'يلزم تسجيل الدخول للمتابعة.',
  forbidden: 'غير موجود.',
  not_found: 'غير موجود.',
  validation: 'تحقق من البيانات المدخلة.',
  conflict: 'هذه البيانات مستخدمة بالفعل.',
  rate_limited: 'محاولات كثيرة. برجاء المحاولة بعد قليل.',
  internal: 'حدث خطأ غير متوقع. تمت المحاولة وتسجيل المشكلة.',
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(
    code: AppErrorCode,
    message?: string,
    options?: { cause?: unknown; fieldErrors?: Record<string, string[]> },
  ) {
    super(message ?? PUBLIC_MESSAGE[code], { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.fieldErrors = options?.fieldErrors;
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
