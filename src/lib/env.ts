import { z } from 'zod';

/**
 * Environment is parsed once, at module load, and split in two.
 *
 * `clientEnv` holds only NEXT_PUBLIC_* values and is safe to reach the browser.
 * `serverEnv` is guarded by `server-only` at its call sites; the service-role
 * key lives there and must never be imported into a client component.
 */
const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_APP_NAME: z.string().default('LocalBasic'),
});

const serverSchema = z.object({
  // Optional: only the admin client (background workers) needs it. The site
  // runs fine without it, and createSupabaseAdminClient() fails loudly if it
  // is ever called while unset.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
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
