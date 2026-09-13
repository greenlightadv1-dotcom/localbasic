#!/usr/bin/env python3
"""Generate src/types/database.ts from a live PostgreSQL schema.

Used against the local test cluster (supabase/tests/run.sh) so the generated
types always match the committed migrations, with no Supabase project needed.

  PGPORT=5433 PGHOST=/tmp python3 scripts/gen-db-types.py
"""
import json, os, subprocess, sys, pathlib

# Tables whose foreign keys are emitted as postgrest `Relationships`.
#
# Relationships are only needed to type an EMBEDDED select such as
# `roles!inner(key, role_permissions(permission_key))`. Emitting them for every
# table makes postgrest-js's recursive type resolution exceed TypeScript's
# instantiation depth, at which point every query silently degrades to `never`
# with no error — so this is an allowlist, not an oversight.
#
# Add a table here when, and only when, you write an embedded select against it.
EMBEDDED_TABLES = {
    "organization_members",
    "user_roles",
    "role_permissions",
    "subscriptions",
    "retail_variants",
}

PG = ["psql", "-h", os.environ.get("PGHOST", "/tmp"), "-p", os.environ.get("PGPORT", "5433"),
      "-U", os.environ.get("PGUSER", "postgres"), "-d", os.environ.get("TEST_DB", "localbasic_test"),
      "-tAX", "-c"]

TYPE_MAP = {
    "uuid": "string", "text": "string", "citext": "string", "bpchar": "string",
    "character": "string", "character varying": "string", "inet": "string",
    "timestamp with time zone": "string", "timestamp without time zone": "string",
    "date": "string", "time without time zone": "string",
    "boolean": "boolean",
    "smallint": "number", "integer": "number", "bigint": "number",
    "numeric": "number", "real": "number", "double precision": "number",
    "jsonb": "Json", "json": "Json",
    "ARRAY": "string[]",
}

def q(sql):
    out = subprocess.run(PG + [sql], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"psql failed: {out.stderr}")
    return [l for l in out.stdout.strip().split("\n") if l]

cols = q("""
select json_agg(row_to_json(t)) from (
  select c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable,
         (c.column_default is not null or c.is_identity = 'YES') as has_default
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
  order by c.table_name, c.ordinal_position
) t;
""")
rows = json.loads(cols[0]) if cols and cols[0] != "" else []

# Foreign keys become Relationships entries. Without them postgrest-js cannot
# type an embedded select such as `organizations!inner(slug, name)` and every
# joined query silently degrades to `never`.
fks = q("""
select json_agg(row_to_json(t)) from (
  select
    con.conname as fk_name,
    src.relname as table_name,
    tgt.relname as referenced_relation,
    (select array_agg(a.attname order by k.ord)
       from unnest(con.conkey) with ordinality k(attnum, ord)
       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as columns,
    (select array_agg(a.attname order by k.ord)
       from unnest(con.confkey) with ordinality k(attnum, ord)
       join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as referenced_columns,
    exists (
      select 1 from pg_index i
      where i.indrelid = con.conrelid and i.indisunique
        and i.indkey::int2[] @> con.conkey and con.conkey @> i.indkey::int2[]
    ) as is_one_to_one
  from pg_constraint con
  join pg_class src on src.oid = con.conrelid
  join pg_class tgt on tgt.oid = con.confrelid
  join pg_namespace n on n.oid = src.relnamespace
  where con.contype = 'f' and n.nspname = 'public'
  order by src.relname, con.conname
) t;
""")
fk_rows = json.loads(fks[0]) if fks and fks[0] != "" else []
rels = {}
for r in fk_rows:
    rels.setdefault(r["table_name"], []).append(r)

funcs = q("""
select json_agg(row_to_json(t)) from (
  select p.proname as name
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    -- exclude functions installed by extensions (citext, pgcrypto)
    and not exists (
      select 1 from pg_depend d
      where d.objid = p.oid and d.deptype = 'e'
    )
  order by p.proname
) t;
""")
fn_rows = json.loads(funcs[0]) if funcs and funcs[0] != "" else []

tables = {}
for r in rows:
    tables.setdefault(r["table_name"], []).append(r)

def ts_type(r):
    # Domain and extension types (citext) surface as USER-DEFINED, so fall back
    # to the underlying type name.
    data_type = r["data_type"]
    if data_type == "USER-DEFINED":
        data_type = r["udt_name"]
    base = TYPE_MAP.get(data_type, "unknown")
    return base + (" | null" if r["is_nullable"] == "YES" else "")

lines = [
    "// AUTO-GENERATED — do not edit by hand.",
    "// Regenerate with: PGPORT=5433 python3 scripts/gen-db-types.py",
    "// Source of truth is supabase/migrations/*.sql.",
    "//",
    "// Relationships are emitted only for the tables listed in EMBEDDED_TABLES in",
    "// the generator — see the comment there for why emitting them everywhere",
    "// breaks type inference.",
    "",
    "export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];",
    "",
    "export type Database = {",
    "  public: {",
    "    Tables: {",
]
for name in sorted(tables):
    cs = tables[name]
    lines.append(f"      {name}: {{")
    lines.append("        Row: {")
    for c in cs:
        lines.append(f"          {c['column_name']}: {ts_type(c)};")
    lines.append("        };")
    lines.append("        Insert: {")
    for c in cs:
        optional = c["has_default"] or c["is_nullable"] == "YES"
        lines.append(f"          {c['column_name']}{'?' if optional else ''}: {ts_type(c)};")
    lines.append("        };")
    lines.append("        Update: {")
    for c in cs:
        lines.append(f"          {c['column_name']}?: {ts_type(c)};")
    lines.append("        };")
    entries = rels.get(name, []) if name in EMBEDDED_TABLES else []
    if not entries:
        lines.append("        Relationships: [];")
    else:
        lines.append("        Relationships: [")
        for r in entries:
            cols = ", ".join(f'"{c}"' for c in r["columns"])
            refs = ", ".join(f'"{c}"' for c in r["referenced_columns"])
            lines.append(
                f'          {{ foreignKeyName: "{r["fk_name"]}"; '
                f'columns: [{cols}]; isOneToOne: {str(r["is_one_to_one"]).lower()}; '
                f'referencedRelation: "{r["referenced_relation"]}"; '
                f'referencedColumns: [{refs}] }},'
            )
        lines.append("        ];")
    lines.append("      };")
lines += [
    "    };",
    "    Views: { [_ in never]: never };",
    "    Functions: {",
]
for f in fn_rows:
    lines.append(f"      {f['name']}: {{ Args: Record<string, unknown>; Returns: Json }};")
lines += [
    "    };",
    "    Enums: { [_ in never]: never };",
    "    CompositeTypes: { [_ in never]: never };",
    "  };",
    "};",
    "",
    "export type Tables<T extends keyof Database['public']['Tables']> =",
    "  Database['public']['Tables'][T]['Row'];",
    "export type TablesInsert<T extends keyof Database['public']['Tables']> =",
    "  Database['public']['Tables'][T]['Insert'];",
    "export type TablesUpdate<T extends keyof Database['public']['Tables']> =",
    "  Database['public']['Tables'][T]['Update'];",
    "",
]
out = pathlib.Path("src/types/database.ts")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("\n".join(lines))
print(f"wrote {out} — {len(tables)} tables, {len(fn_rows)} functions")
