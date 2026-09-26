# Excel/CSV menu import — column schema

This is the schema `src/modules/restaurant/import/fields.ts` actually reads.
It is derived from the columns `restaurant_products`, `restaurant_variants`
and `restaurant_categories` really have — not a wish list — so every column
below maps to a real, load-bearing field, and nothing else is accepted.

Column **order does not matter**. The importer's mapping step lets an admin
point at whichever column holds each field, with a header-name auto-guess
(Arabic and English aliases) as a starting suggestion the admin always
confirms before anything is read.

## Columns

| Column (suggested header) | Field       | Required | Type & rules |
|---|---|---|---|
| اسم الصنف / Name          | `name`         | **Yes** | Text, 1–200 characters. |
| السعر / Price             | `price`        | **Yes** | A number. Accepts Arabic-Indic digits, `,` or `٫` as decimal separator, stray currency text. Stored as integer minor units (e.g. `45.50` → 4550). |
| الوصف / Description       | `description`  | No | Text, up to 2000 characters. |
| التصنيف / Category        | `category`     | No | Text, up to 120 characters. A name that does not already exist in the menu is offered as a **new category** — the admin confirms creating it before anything is written. |
| رابط الصورة / Image URL   | `image_url`    | No | Must start with `https://`. This is the one place in the platform a URL is still accepted for an image — a bulk spreadsheet import has no file to upload, unlike every other screen in the product, which uses direct file upload only. |
| الترتيب / Sort order      | `sort_order`   | No | Whole number, 0–100000. Leave blank to just append at the end. |
| زمن التحضير / Prep minutes | `prep_minutes` | No | Whole number, 0–600. Shown on the kitchen display. |
| مطبخ / بار / Kitchen or Bar | `station`    | No | Exactly `مطبخ`/`kitchen` or `بار`/`bar`. Only takes effect for a **category being created by this import** — it sets that category's default routing (drinks → bar, food → kitchen; see the kitchen/bar station feature). It never changes the routing of a category that already exists; do that from Menu → the category's own toggle instead. |
| الأكثر مبيعًا / Best seller | `best_seller` | No | One of `1`, `true`, `yes`, `نعم`, `صح` marks the item as a best seller (shown in the "الأكثر مبيعًا" section on the storefront and Site Engine). Anything else, or blank, means no. |

## What is deliberately **not** importable, and why

- **SKU / external ID** — `restaurant_products` has no such column. This is
  also why the importer only ever *creates* products, never updates them: a
  row whose name already exists in this organization is reported as a
  duplicate and skipped, visibly, with a count. Nothing is silently merged
  or overwritten.
- **Per-language name** (`name_ar` / `name_en`) — the catalog stores one
  name. Splitting it is a schema change with consequences for every screen
  that reads a product, not an import concern.
- **Per-branch availability** — availability lives in
  `restaurant_branch_availability`, scoped to one branch. A menu import is
  organization-wide (the menu is shared across branches), so it has no
  single branch to write availability against; mark an item unavailable at
  a specific branch afterward, from Menu → توافر الفرع.
- **A specific kitchen/bar station** (as opposed to just its kind) — a
  branch's stations are named per-branch ("المطبخ الرئيسي", "بار العصائر"…)
  and an org-wide import has no one branch to match a station name against
  reliably. Assign a product to one exact station from Menu → المحطة after
  import, if the category's default kind isn't precise enough.
- **Variants/sizes and modifiers** — the importer creates one product with
  one default-priced variant per row. Add sizes, modifier groups and their
  prices from the menu screen afterward; representing an arbitrary number of
  variants and modifier groups per spreadsheet row does not fit a flat
  column schema without a second, linked sheet, which is out of scope here.

## A ready-to-fill template

`docs/menu-import-template.csv` in this repository has the header row above
with a couple of example rows. Duplicate it, fill in your menu, and upload it
from Menu → استيراد الأصناف.
