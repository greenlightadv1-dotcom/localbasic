import 'server-only';
import type { PoolClient } from 'pg';
import { getJsonbColumns, getRelationships, withSession } from './db';

/**
 * A small PostgREST-compatible query builder over a direct PostgreSQL
 * connection. LOCAL DEVELOPMENT ONLY — see ./db.ts.
 *
 * It implements the subset of the supabase-js surface this app actually uses,
 * including one level of embedded selects, so services and screens run against
 * it unmodified.
 */

export type PostgrestResult<T> = {
  data: T;
  error: { code?: string; message: string; details?: string } | null;
  count?: number | null;
};

type Filter = { op: string; column: string; value: unknown };

type Embed = { relation: string; columns: string[]; inner: boolean };

/** Splits a select string into top-level columns and one level of embeds. */
function parseSelect(select: string): { columns: string[]; embeds: Embed[] } {
  const columns: string[] = [];
  const embeds: Embed[] = [];
  let buffer = '';
  let depth = 0;

  const flush = () => {
    const piece = buffer.trim();
    buffer = '';
    if (!piece) return;

    const open = piece.indexOf('(');
    if (open === -1) {
      columns.push(piece);
      return;
    }

    const head = piece.slice(0, open).trim();
    const body = piece.slice(open + 1, piece.lastIndexOf(')'));
    const inner = head.endsWith('!inner');
    const relation = head.replace('!inner', '').trim();
    // Nested embeds inside an embed are flattened: the inner list is parsed
    // again when that relation is fetched.
    embeds.push({ relation, columns: body.split(',').map((c) => c.trim()), inner });
  };

  for (const char of select) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      flush();
      continue;
    }
    buffer += char;
  }
  flush();

  return { columns, embeds };
}

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`unsafe identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

const OPERATORS: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'like',
  ilike: 'ilike',
};

export class LocalQuery<T = unknown> implements PromiseLike<PostgrestResult<T>> {
  private filters: Filter[] = [];
  private orFilter: string | null = null;
  private selectColumns = '*';
  private orders: { column: string; ascending: boolean }[] = [];
  private limitValue: number | null = null;
  private rangeValue: { from: number; to: number } | null = null;
  private mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  /** jsonb columns on this table, resolved once per query. */
  private jsonbCols: Set<string> | undefined;
  private payload: Record<string, unknown>[] = [];
  private onConflict: string | null = null;
  private singleMode: 'one' | 'maybe' | null = null;
  private wantCount = false;
  private headOnly = false;
  private returning = false;

  constructor(
    private readonly table: string,
    private readonly userId: string | null,
  ) {}

  select(columns = '*', options?: { count?: 'exact'; head?: boolean }) {
    this.selectColumns = columns;
    if (options?.count) this.wantCount = true;
    if (options?.head) this.headOnly = true;
    if (this.mode !== 'select') this.returning = true;
    return this;
  }

  /**
   * Encodes a value the way PostgREST would for its column type.
   *
   * Everything bound to a jsonb column is JSON-encoded here. A bare string is
   * not valid JSON on its own, and node-postgres renders a JavaScript array as
   * a PostgreSQL array literal rather than a JSON one — so neither survives the
   * cast without this.
   */
  private encodeForColumn(column: string, value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (!this.jsonbCols?.has(column)) return value;
    return JSON.stringify(value);
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]) {
    this.mode = 'insert';
    this.payload = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values: Record<string, unknown>) {
    this.mode = 'update';
    this.payload = [values];
    return this;
  }

  upsert(values: Record<string, unknown>, options?: { onConflict?: string }) {
    this.mode = 'upsert';
    this.payload = [values];
    this.onConflict = options?.onConflict ?? null;
    return this;
  }

  delete() {
    this.mode = 'delete';
    return this;
  }

  eq(column: string, value: unknown) { this.filters.push({ op: 'eq', column, value }); return this; }
  neq(column: string, value: unknown) { this.filters.push({ op: 'neq', column, value }); return this; }
  gt(column: string, value: unknown) { this.filters.push({ op: 'gt', column, value }); return this; }
  gte(column: string, value: unknown) { this.filters.push({ op: 'gte', column, value }); return this; }
  lt(column: string, value: unknown) { this.filters.push({ op: 'lt', column, value }); return this; }
  lte(column: string, value: unknown) { this.filters.push({ op: 'lte', column, value }); return this; }
  like(column: string, value: string) { this.filters.push({ op: 'like', column, value }); return this; }
  ilike(column: string, value: string) { this.filters.push({ op: 'ilike', column, value }); return this; }
  in(column: string, values: unknown[]) { this.filters.push({ op: 'in', column, value: values }); return this; }
  is(column: string, value: null | boolean) { this.filters.push({ op: 'is', column, value }); return this; }

  /** PostgREST `or=(a.eq.1,b.ilike.x)` — only the forms this app uses. */
  or(expression: string) {
    this.orFilter = expression;
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(value: number) {
    this.limitValue = value;
    return this;
  }

  /**
   * PostgREST's `offset`/`limit`, inclusive of both bounds — the paginated
   * report reads depend on it.
   *
   * postgrest-js sets these as query PARAMETERS rather than a Range header, so
   * an offset past the end is an empty result, never a 416. This mirrors that.
   */
  range(from: number, to: number) {
    this.rangeValue = { from, to };
    return this;
  }

  maybeSingle() { this.singleMode = 'maybe'; return this; }
  single() { this.singleMode = 'one'; return this; }

  private buildWhere(params: unknown[], startIndex: number): string {
    const clauses: string[] = [];
    let index = startIndex;

    for (const filter of this.filters) {
      // A dotted column such as `roles.organization_id` filters the embedded
      // resource, not this table — PostgREST routes it to the embed, and so
      // does attachEmbeds below.
      if (filter.column.includes('.')) continue;
      const column = quote(filter.column);
      if (filter.op === 'in') {
        const list = filter.value as unknown[];
        if (list.length === 0) {
          clauses.push('false');
          continue;
        }
        const placeholders = list.map(() => `$${index++}`);
        params.push(...list);
        clauses.push(`${column} in (${placeholders.join(', ')})`);
      } else if (filter.op === 'is') {
        clauses.push(
          filter.value === null ? `${column} is null` : `${column} is ${filter.value ? 'true' : 'false'}`,
        );
      } else {
        clauses.push(`${column} ${OPERATORS[filter.op]} $${index++}`);
        params.push(filter.value);
      }
    }

    if (this.orFilter) {
      const parts = this.orFilter.split(',').map((piece) => {
        const [column, op, ...rest] = piece.split('.');
        const value = rest.join('.');
        params.push(value);
        return `${quote(column!)} ${OPERATORS[op!] ?? '='} $${index++}`;
      });
      clauses.push(`(${parts.join(' or ')})`);
    }

    return clauses.length ? `where ${clauses.join(' and ')}` : '';
  }

  private async run(client: PoolClient): Promise<PostgrestResult<T>> {
    const { columns, embeds } = parseSelect(this.selectColumns);
    const baseColumns = columns.length && columns[0] !== '*' ? columns : ['*'];

    // The embed's own foreign key column has to come back too, so rows can be
    // matched up afterwards.
    const relationships = await getRelationships();
    const extraColumns = new Set<string>();
    for (const embed of embeds) {
      const parent = relationships.find(
        (r) => r.table === this.table && r.foreignTable === embed.relation,
      );
      if (parent) extraColumns.add(parent.column);
    }
    if (embeds.length && baseColumns[0] !== '*' && !baseColumns.includes('id')) {
      extraColumns.add('id');
    }

    const selectList =
      baseColumns[0] === '*'
        ? '*'
        : [...new Set([...baseColumns, ...extraColumns])].map(quote).join(', ');

    let sql: string;
    const params: unknown[] = [];

    if (this.mode === 'insert' || this.mode === 'upsert') {
      const keys = [...new Set(this.payload.flatMap((row) => Object.keys(row)))];
      const valueRows = this.payload.map(
        (row) => `(${keys.map((key) => { params.push(this.encodeForColumn(key, row[key])); return `$${params.length}`; }).join(', ')})`,
      );
      sql = `insert into ${quote(this.table)} (${keys.map(quote).join(', ')}) values ${valueRows.join(', ')}`;
      if (this.mode === 'upsert' && this.onConflict) {
        const conflictColumns = this.onConflict.split(',').map((c) => quote(c.trim()));
        const updates = keys
          .filter((key) => !this.onConflict!.split(',').map((c) => c.trim()).includes(key))
          .map((key) => `${quote(key)} = excluded.${quote(key)}`);
        sql += ` on conflict (${conflictColumns.join(', ')}) do update set ${updates.join(', ')}`;
      }
      if (this.returning) sql += ` returning ${selectList}`;
    } else if (this.mode === 'update') {
      const row = this.payload[0] ?? {};
      const sets = Object.keys(row).map((key) => {
        params.push(this.encodeForColumn(key, row[key]));
        return `${quote(key)} = $${params.length}`;
      });
      sql = `update ${quote(this.table)} set ${sets.join(', ')} ${this.buildWhere(params, params.length + 1)}`;
      if (this.returning) sql += ` returning ${selectList}`;
    } else if (this.mode === 'delete') {
      sql = `delete from ${quote(this.table)} ${this.buildWhere(params, 1)}`;
      if (this.returning) sql += ` returning ${selectList}`;
    } else {
      sql = `select ${this.headOnly ? '1' : selectList} from ${quote(this.table)} ${this.buildWhere(params, 1)}`;
      if (this.orders.length) {
        sql += ` order by ${this.orders
          .map((o) => `${quote(o.column)} ${o.ascending ? 'asc' : 'desc'}`)
          .join(', ')}`;
      }
      if (this.rangeValue) {
        sql += ` limit ${Number(this.rangeValue.to - this.rangeValue.from + 1)}`;
        sql += ` offset ${Number(this.rangeValue.from)}`;
      } else if (this.limitValue !== null) {
        sql += ` limit ${Number(this.limitValue)}`;
      }
    }

    const result = await client.query(sql, params);
    let rows = result.rows as Record<string, unknown>[];

    /**
     * The TOTAL matching rows, which is what PostgREST reports after the slash
     * in Content-Range and what supabase-js exposes as `count`. It ignores
     * limit and offset, so it stays the same across pages — returning the page
     * length here instead would have told a paginating caller it was finished
     * after the first page.
     */
    const totalCount = async (): Promise<number> => {
      const countParams: unknown[] = [];
      const countSql = `select count(*)::int as count from ${quote(this.table)} ${this.buildWhere(countParams, 1)}`;
      const countResult = await client.query(countSql, countParams);
      return countResult.rows[0]?.count ?? 0;
    };

    if (this.wantCount && this.headOnly) {
      return { data: null as T, error: null, count: await totalCount() };
    }

    const count = this.wantCount ? await totalCount() : null;

    // Resolve embeds the way PostgREST does: parent side by foreign key, child
    // side by the reverse foreign key, recursing so a nested select such as
    // roles(role_permissions(key)) resolves at any depth and in either
    // direction.
    const embedFilters = this.filters.filter((f) => f.column.includes('.'));
    rows = await attachEmbeds(client, this.table, rows, embeds, relationships, embedFilters);

    // A parent embed that the caller wrote as `table!inner(...)` and then reads
    // as a single object is already shaped correctly above.
    if (this.singleMode === 'one') {
      if (rows.length !== 1) {
        return {
          data: null as T,
          error: { code: 'PGRST116', message: 'expected exactly one row' },
        };
      }
      return { data: rows[0] as T, error: null };
    }
    if (this.singleMode === 'maybe') {
      return { data: (rows[0] ?? null) as T, error: null };
    }

    return { data: rows as T, error: null, count };
  }

  then<TResult1 = PostgrestResult<T>, TResult2 = never>(
    onfulfilled?: ((value: PostgrestResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return withSession(this.userId, async (client) => {
      this.jsonbCols = (await getJsonbColumns()).get(this.table);
      return this.run(client);
    })
      .catch((error: { code?: string; message: string; detail?: string }) => ({
        data: null as T,
        error: { code: error.code, message: error.message, details: error.detail },
      }))
      .then(onfulfilled, onrejected);
  }
}

/**
 * Attaches embedded relations to a set of rows, recursively.
 *
 * `relation` is resolved against the foreign keys of the schema: if this table
 * points at it, the embed is a single parent object; if it points back at this
 * table, the embed is an array of children. `!inner` drops rows with no match,
 * matching PostgREST.
 */
async function attachEmbeds(
  client: PoolClient,
  table: string,
  rows: Record<string, unknown>[],
  embeds: Embed[],
  relationships: { table: string; column: string; foreignTable: string; foreignColumn: string }[],
  embedFilters: Filter[] = [],
): Promise<Record<string, unknown>[]> {
  let result = rows;

  for (const embed of embeds) {
    if (result.length === 0) break;

    const parent = relationships.find(
      (r) => r.table === table && r.foreignTable === embed.relation,
    );
    const child = relationships.find(
      (r) => r.table === embed.relation && r.foreignTable === table,
    );
    if (!parent && !child) continue;

    const { columns: embedColumns, embeds: nested } = parseSelect(embed.columns.join(','));
    const link = parent
      ? { local: parent.column, remote: parent.foreignColumn }
      : { local: child!.foreignColumn, remote: child!.column };

    const keys = [...new Set(result.map((row) => row[link.local]).filter((k) => k != null))];
    if (keys.length === 0) {
      for (const row of result) row[embed.relation] = parent ? null : [];
      if (embed.inner) result = [];
      continue;
    }

    const selectList =
      embedColumns[0] === '*' || embedColumns.length === 0
        ? '*'
        : [...new Set([...embedColumns, link.remote])].map(quote).join(', ');

    // Filters written as `relation.column` narrow the embedded fetch.
    const own = embedFilters.filter((f) => f.column.startsWith(`${embed.relation}.`));
    const params: unknown[] = [keys];
    const extra = own.map((f) => {
      const column = quote(f.column.slice(embed.relation.length + 1));
      if (f.op === 'is') {
        return f.value === null ? `${column} is null` : `${column} is ${f.value ? 'true' : 'false'}`;
      }
      if (f.op === 'in') {
        params.push(f.value);
        return `${column} = any($${params.length})`;
      }
      params.push(f.value);
      return `${column} ${OPERATORS[f.op] ?? '='} $${params.length}`;
    });

    let related = (
      await client.query(
        `select ${selectList} from ${quote(embed.relation)}
         where ${quote(link.remote)} = any($1)${extra.length ? ' and ' + extra.join(' and ') : ''}`,
        params,
      )
    ).rows as Record<string, unknown>[];

    if (nested.length) {
      related = await attachEmbeds(client, embed.relation, related, nested, relationships);
    }

    if (parent) {
      const byKey = new Map(related.map((r) => [r[link.remote], r]));
      for (const row of result) row[embed.relation] = byKey.get(row[link.local]) ?? null;
      if (embed.inner) result = result.filter((row) => row[embed.relation] !== null);
    } else {
      for (const row of result) {
        row[embed.relation] = related.filter((r) => r[link.remote] === row[link.local]);
      }
      if (embed.inner) {
        result = result.filter((row) => (row[embed.relation] as unknown[]).length > 0);
      }
    }
  }

  return result;
}
