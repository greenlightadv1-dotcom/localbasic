import { z } from 'zod';

/**
 * Environment is parsed once, at module load, and split in two.
 *
 * `clientEnv` holds only NEXT_PUBLIC_* values and is safe to reach the browser.
 * `serverEnv` is guarded by `server-only` at its call sites; the service-role
 * key lives there and must never be imported into a client component.
 */
// .trim() everywhere a value is pasted into a dashboard (Vercel, etc.):
// a trailing newline or space from a copy-paste is invisible in the UI but
// turns a JWT-shaped secret into one that fails signature verification —
// exactly the "Invalid API key" Supabase reports for a key it can parse but
// not verify. Trimming a value that was already clean is a no-op.
const trimmed = () => z.string().transform((v) => v.trim());

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: trimmed().pipe(z.string().url()),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: trimmed().pipe(z.string().min(20)),
  NEXT_PUBLIC_APP_URL: trimmed().pipe(z.string().url()).default('http://localhost:3000'),
  NEXT_PUBLIC_APP_NAME: z.string().default('LocalBasic'),
});

const serverSchema = z.object({
  // Optional: only the admin client (background workers) needs it. The site
  // runs fine without it, and createSupabaseAdminClient() fails loudly if it
  // is ever called while unset.
  SUPABASE_SERVICE_ROLE_KEY: trimmed().pipe(z.string().min(20)).optional(),
  // Optional break-glass: enables /api/admin-bootstrap, which mints a single
  // recovery link for the one platform-owner address without sending email.
  // Absent by default, and the route answers 404 without it.
  ADMIN_BOOTSTRAP_SECRET: z.string().min(32).optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional().or(z.literal('')),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional().or(z.literal('')),
});

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown, label: string): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(
      `Invalid ${label} environment configuration: ${missing}. ` +
        'Copy .env.example to .env.local and fill in the values.',
    );
  }
  return result.data;
}

export const clientEnv = parse(
  clientSchema,
  {
    // Next.js inlines these at build time only when referenced statically.
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  },
  'client',
);

let cachedServerEnv: z.infer<typeof serverSchema> | null = null;

/** Lazily parsed so a missing service-role key never breaks a client build. */
export function serverEnv() {
  cachedServerEnv ??= parse(serverSchema, process.env, 'server');
  return cachedServerEnv;
}
