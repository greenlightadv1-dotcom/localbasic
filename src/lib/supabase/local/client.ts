import 'server-only';
import { cookies } from 'next/headers';
import { getJsonbArguments, withAuthConnection, withServiceRole, withSession } from './db';
import { LocalQuery, type PostgrestResult } from './query';

/**
 * LOCAL DEVELOPMENT ONLY — see ./db.ts.
 *
 * Stands in for the Supabase client so the app can run without a Supabase
 * project. Queries keep RLS; auth is replaced by a signed-out-or-signed-in
 * cookie holding the developer's chosen user id.
 */
export const LOCAL_SESSION_COOKIE = 'lb_local_user';

export function getLocalUserId(): string | null {
  try {
    return cookies().get(LOCAL_SESSION_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

type LocalUser = { id: string; email: string | null; user_metadata: Record<string, unknown> };

class LocalAuth {
  async getUser(): Promise<{ data: { user: LocalUser | null }; error: null | { message: string } }> {
    const userId = getLocalUserId();
    if (!userId) return { data: { user: null }, error: { message: 'not signed in' } };

    const rows = await withAuthConnection(async (client) => {
      const result = await client.query(
        'select id, email, raw_user_meta_data from auth.users where id = $1',
        [userId],
      );
      return result.rows;
    });

    const row = rows[0];
    if (!row) return { data: { user: null }, error: { message: 'not signed in' } };

    return {
      data: {
        user: {
          id: row.id,
          email: row.email,
          user_metadata: row.raw_user_meta_data ?? {},
        },
      },
      error: null,
    };
  }

  /**
   * Development sign-in. There is no password check: the local adapter exists
   * to inspect the UI, not to model authentication, and it cannot run in
   * production. Real auth is Supabase Auth in every deployed environment.
   */
  async signInWithPassword({ email }: { email: string; password: string }) {
    const rows = await withAuthConnection(async (client) => {
      const result = await client.query('select id from auth.users where email = $1', [email]);
      return result.rows;
    });
    const user = rows[0];
    if (!user) return { data: { user: null }, error: { message: 'unknown local user' } };

    cookies().set(LOCAL_SESSION_COOKIE, user.id, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24,
    });
    return { data: { user, session: { user } }, error: null };
  }

  async signUp({ email, options }: { email: string; password: string; options?: { data?: Record<string, unknown> } }) {
    const rows = await withAuthConnection(async (client) => {
      const result = await client.query(
        `insert into auth.users (email, raw_user_meta_data) values ($1, $2)
         on conflict (email) do update set email = excluded.email
         returning id`,
        [email, JSON.stringify(options?.data ?? {})],
      );
      return result.rows;
    });
    const user = rows[0];
    if (!user) return { data: { user: null }, error: { message: 'could not create local user' } };

    cookies().set(LOCAL_SESSION_COOKIE, user.id, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24,
    });
    // A session, because one was in fact established: the cookie above is it.
    // supabase-js reports `session: null` when a project requires email
    // confirmation, and callers rightly read that as "not signed in yet" —
    // omitting it here made every local sign-up look unconfirmed.
    return { data: { user, session: { user } }, error: null };
  }

  async signOut() {
    cookies().set(LOCAL_SESSION_COOKIE, '', { path: '/', maxAge: 0 });
    return { error: null };
  }

  async exchangeCodeForSession() {
    return { data: null, error: { message: 'not supported locally' } };
  }
}

class LocalClient {
  readonly auth = new LocalAuth();
  private readonly userId: string | null;
  /** True for the service-role client; see `createLocalServiceClient`. */
  private readonly serviceRole: boolean;

  constructor(userId: string | null, serviceRole = false) {
    this.userId = userId;
    this.serviceRole = serviceRole;
  }

  from(table: string) {
    return new LocalQuery(table, this.userId);
  }

  /**
   * Calls a database function the way PostgREST does. A function returning a
   * single scalar yields that value; one returning a table yields its rows.
   */
  rpc(fn: string, args: Record<string, unknown> = {}) {
    const userId = this.userId;
    const serviceRole = this.serviceRole;
    const keys = Object.keys(args);

    const execute = async (): Promise<PostgrestResult<unknown>> => {
      try {
        // Encode a value the way PostgREST would: a json/jsonb argument
        // arrives already JSON-encoded, everything else arrives as itself.
        // Encoding every object would turn a text[] argument into a string
        // literal the parameter cannot accept, which is why the function's
        // declared argument types decide rather than the value's shape.
        const jsonArgs = (await getJsonbArguments()).get(fn.replace(/^public\./, ''));
        const placeholders = keys.map((key, index) => `${key} => $${index + 1}`);
        const values = keys.map((key) => {
          const value = args[key];
          if (value === null || value === undefined) return null;
          return jsonArgs?.has(key) ? JSON.stringify(value) : value;
        });

        const run = async (client: import('pg').PoolClient) => {
          const result = await client.query(
            `select * from ${fn}(${placeholders.join(', ')})`,
            values,
          );
          return result.rows;
        };
        const rows = serviceRole
          ? await withServiceRole(run)
          : await withSession(userId, run);

        // A one-column result whose column is named after the function is a
        // scalar return, not a row set.
        if (rows.length === 1 && rows[0] && Object.keys(rows[0]).length === 1) {
          const onlyKey = Object.keys(rows[0])[0]!;
          if (onlyKey === fn.replace(/^public\./, '')) {
            return { data: rows[0][onlyKey], error: null };
          }
        }
        return { data: rows, error: null };
      } catch (error) {
        const err = error as { code?: string; message: string; detail?: string };
        return { data: null, error: { code: err.code, message: err.message, details: err.detail } };
      }
    };

    // `.single()` / `.maybeSingle()` collapse the row set, matching supabase-js.
    const thenable = {
      then: (resolve: (value: PostgrestResult<unknown>) => unknown) => execute().then(resolve),
      single: () => ({
        then: (resolve: (value: PostgrestResult<unknown>) => unknown) =>
          execute().then((result) => {
            if (result.error) return resolve(result);
            const rows = result.data as unknown[];
            return resolve({ data: Array.isArray(rows) ? (rows[0] ?? null) : rows, error: null });
          }),
      }),
      maybeSingle: () => ({
        then: (resolve: (value: PostgrestResult<unknown>) => unknown) =>
          execute().then((result) => {
            if (result.error) return resolve(result);
            const rows = result.data as unknown[];
            return resolve({ data: Array.isArray(rows) ? (rows[0] ?? null) : rows, error: null });
          }),
      }),
    };

    return thenable;
  }
}

export function createLocalClient() {
  return new LocalClient(getLocalUserId());
}

/**
 * The local stand-in for the service-role client.
 *
 * Its queries run as `service_role` with no JWT claims, exactly as a
 * service-role request does on a real project — so a function granted only to
 * `service_role` is reachable here and a function granted to `authenticated`
 * is reached by the ordinary client, and neither test lies about which is
 * which. There is no key involved and there cannot be: this file only runs
 * under the local adapter.
 */
export function createLocalServiceClient() {
  return new LocalClient(null, true);
}
