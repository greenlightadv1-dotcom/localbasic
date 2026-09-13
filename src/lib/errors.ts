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
