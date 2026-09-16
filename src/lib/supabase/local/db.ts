import 'server-only';
import { Pool, types, type PoolClient } from 'pg';

// node-postgres returns bigint (int8) and numeric as STRINGS by default, to
// avoid silent precision loss. Supabase's API returns them as JSON numbers, so
// without this every money value would arrive as a string and `a + b` would
// concatenate instead of adding. Our amounts are minor units well inside
// Number.MAX_SAFE_INTEGER, and quantities are small decimals.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));
types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));

/**
 * LOCAL DEVELOPMENT ONLY.
 *
 * A direct PostgreSQL connection used in place of Supabase's hosted API when
 * LOCALBASIC_LOCAL_DB=1. It exists so the app can be run and inspected without
 * a Supabase project — nothing more.
 *
 * Crucially it does NOT bypass security: every query runs as the `authenticated`
 * role with the caller's id in request.jwt.claims, exactly as PostgREST does, so
 * RLS, FORCE RLS and every policy apply unchanged. The only thing replaced is
 * the transport.
 */
let pool: Pool | null = null;

export function isLocalDb(): boolean {
  return process.env.LOCALBASIC_LOCAL_DB === '1' && process.env.NODE_ENV !== 'production';
}

export function getPool(): Pool {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('the local database adapter must never run in production');
  }
  pool ??= new Pool({
    connectionString:
      process.env.LOCAL_DATABASE_URL ?? 'postgresql://postgres@localhost:5433/localbasic_dev',
    max: 8,
  });
  return pool;
}

/**
 * Runs a unit of work with the session identity PostgREST would have set:
 * role `authenticated` (or `anon` when signed out) plus the JWT claims that
 * auth.uid() reads. Wrapped in a transaction so `set_local` is scoped to it.
 */
export async function withSession<T>(
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    if (userId) {
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
      await client.query("select set_config('role', 'authenticated', true)");
    } else {
      await client.query("select set_config('role', 'anon', true)");
    }
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs outside the tenant session, for the few things Supabase does out of
 * band: reading the auth user record. In a real deployment this is GoTrue's
 * own database connection, not a tenant query, which is why it is not subject
 * to RLS. Nothing tenant-scoped may use this.
 */
export async function withAuthConnection<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Foreign keys, cached, so embedded selects can be resolved like PostgREST. */
type Relationship = {
  table: string;
  column: string;
  foreignTable: string;
  foreignColumn: string;
};

let relationships: Relationship[] | null = null;

/**
 * Which columns are jsonb, by table.
 *
 * PostgREST receives a JSON body, so a string destined for a jsonb column
 * arrives already JSON-encoded. This adapter binds JavaScript values straight
 * to placeholders, where node-postgres sends a string as text and PostgreSQL
 * then fails to cast a bare word to jsonb. Knowing the column types lets the
 * adapter encode exactly what PostgREST would, for every table rather than for
 * the one that happened to break.
 *
 * Cached for the process, like the relationship map above.
 */
let jsonbColumns: Map<string, Set<string>> | null = null;

export async function getJsonbColumns(): Promise<Map<string, Set<string>>> {
  if (jsonbColumns) return jsonbColumns;
  const { rows } = await getPool().query<{ table: string; column: string }>(`
    select c.relname as table, a.attname as column
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_type t on t.oid = a.atttypid
    where n.nspname = 'public' and c.relkind = 'r'
      and a.attnum > 0 and not a.attisdropped
      and t.typname in ('json', 'jsonb')
  `);
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = map.get(r.table) ?? new Set<string>();
    set.add(r.column);
    map.set(r.table, set);
  }
  jsonbColumns = map;
  return map;
}

export async function getRelationships(): Promise<Relationship[]> {
  if (relationships) return relationships;
  const { rows } = await getPool().query<Relationship>(`
    select
      src.relname  as table,
      sa.attname   as column,
      tgt.relname  as "foreignTable",
      ta.attname   as "foreignColumn"
    from pg_constraint c
    join pg_class src on src.oid = c.conrelid
    join pg_class tgt on tgt.oid = c.confrelid
    join pg_namespace n on n.oid = src.relnamespace
    join pg_attribute sa on sa.attrelid = c.conrelid and sa.attnum = c.conkey[1]
    join pg_attribute ta on ta.attrelid = c.confrelid and ta.attnum = c.confkey[1]
    where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 1
  `);
  relationships = rows;
  return rows;
}
