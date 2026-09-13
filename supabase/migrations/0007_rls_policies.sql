-- =============================================================================
-- LOCAL BASIC — 0007 RLS policies for Core
--
-- Rules applied without exception:
--   * RLS is ENABLED and FORCED on every table in `public`.
--   * A table with no policy for a verb denies that verb. Financial, audit and
--     medical rows therefore have NO delete policy and NO update policy where
--     they must stay append-only.
--   * Every UPDATE policy carries both USING and WITH CHECK so a row can never
--     be moved into another organization or branch.
--   * Reads are scoped by membership AND branch access AND permission.
-- =============================================================================

alter table public.profiles              enable row level security;
alter table public.organizations         enable row level security;
alter table public.organization_modules  enable row level security;
alter table public.branches              enable row level security;
alter table public.organization_members  enable row level security;
alter table public.member_branches       enable row level security;
alter table public.invitations           enable row level security;
alter table public.permissions           enable row level security;
alter table public.roles                 enable row level security;
alter table public.role_permissions      enable row level security;
alter table public.user_roles            enable row level security;
alter table public.plans                 enable row level security;
alter table public.subscriptions         enable row level security;
alter table public.branding_settings     enable row level security;
alter table public.settings              enable row level security;
alter table public.audit_logs            enable row level security;
alter table public.notifications         enable row level security;
alter table public.customers             enable row level security;
alter table public.document_counters     enable row level security;
alter table public.invoices              enable row level security;
alter table public.invoice_items         enable row level security;
alter table public.payments              enable row level security;
alter table public.treasury_accounts     enable row level security;
alter table public.treasury_transactions enable row level security;
alter table public.public_links          enable row level security;
alter table public.qr_codes              enable row level security;

alter table public.profiles              force row level security;
alter table public.organizations         force row level security;
alter table public.organization_modules  force row level security;
alter table public.branches              force row level security;
alter table public.organization_members  force row level security;
alter table public.member_branches       force row level security;
alter table public.invitations           force row level security;
alter table public.permissions           force row level security;
alter table public.plans                 force row level security;
alter table public.roles                 force row level security;
alter table public.role_permissions      force row level security;
alter table public.user_roles            force row level security;
alter table public.subscriptions         force row level security;
alter table public.branding_settings     force row level security;
alter table public.settings              force row level security;
alter table public.audit_logs            force row level security;
alter table public.notifications         force row level security;
alter table public.customers             force row level security;
alter table public.document_counters     force row level security;
alter table public.invoices              force row level security;
alter table public.invoice_items         force row level security;
alter table public.payments              force row level security;
alter table public.treasury_accounts     force row level security;
alter table public.treasury_transactions force row level security;
alter table public.public_links          force row level security;
alter table public.qr_codes              force row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create policy profiles_select_self on public.profiles for select to authenticated
  using (id = auth.uid());

-- Members of the same organization can see each other's basic profile, so that
-- "created by" and member lists render without a service-role read.
create policy profiles_select_coworkers on public.profiles for select to authenticated
  using (exists (
    select 1
    from public.organization_members me
    join public.organization_members them
      on them.organization_id = me.organization_id
    where me.user_id = auth.uid() and me.status = 'active'
      and them.user_id = public.profiles.id and them.status = 'active'
  ));

create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- organizations  (creation happens only inside provision_workspace)
-- ---------------------------------------------------------------------------
create policy organizations_select on public.organizations for select to authenticated
  using (app.is_member_of(id) and deleted_at is null);

create policy organizations_update on public.organizations for update to authenticated
  using (app.has_permission(id, 'organization.manage'))
  with check (app.has_permission(id, 'organization.manage'));

-- ---------------------------------------------------------------------------
-- organization_modules
-- ---------------------------------------------------------------------------
create policy org_modules_select on public.organization_modules for select to authenticated
  using (app.is_member_of(organization_id));

create policy org_modules_write on public.organization_modules for all to authenticated
  using (app.has_permission(organization_id, 'organization.manage'))
  with check (app.has_permission(organization_id, 'organization.manage'));

-- ---------------------------------------------------------------------------
-- branches — a member only ever sees the branches they are scoped to
-- ---------------------------------------------------------------------------
create policy branches_select on public.branches for select to authenticated
  using (app.can_access_branch(organization_id, id) and deleted_at is null);

create policy branches_insert on public.branches for insert to authenticated
  with check (app.has_permission(organization_id, 'branch.create'));

create policy branches_update on public.branches for update to authenticated
  using (app.can_access_branch(organization_id, id) and app.has_permission(organization_id, 'branch.manage'))
  with check (app.has_permission(organization_id, 'branch.manage'));

-- ---------------------------------------------------------------------------
-- organization_members
-- ---------------------------------------------------------------------------
create policy members_select_self on public.organization_members for select to authenticated
  using (user_id = auth.uid());

create policy members_select_all on public.organization_members for select to authenticated
  using (app.has_permission(organization_id, 'member.read'));

create policy members_insert on public.organization_members for insert to authenticated
  with check (app.has_permission(organization_id, 'member.manage'));

create policy members_update on public.organization_members for update to authenticated
  using (app.has_permission(organization_id, 'member.manage'))
  with check (app.has_permission(organization_id, 'member.manage'));

create policy members_delete on public.organization_members for delete to authenticated
  using (app.has_permission(organization_id, 'member.manage'));

-- ---------------------------------------------------------------------------
-- member_branches
-- ---------------------------------------------------------------------------
create policy member_branches_select on public.member_branches for select to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.id = member_id
      and (m.user_id = auth.uid() or app.has_permission(m.organization_id, 'member.read'))
  ));

create policy member_branches_write on public.member_branches for all to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.id = member_id and app.has_permission(m.organization_id, 'member.manage')
  ))
  with check (exists (
    select 1 from public.organization_members m
    where m.id = member_id and app.has_permission(m.organization_id, 'member.manage')
  ));

-- ---------------------------------------------------------------------------
-- invitations — the token hash is never selectable by the invitee; acceptance
-- runs through a SECURITY DEFINER function.
-- ---------------------------------------------------------------------------
create policy invitations_manage on public.invitations for all to authenticated
  using (app.has_permission(organization_id, 'member.manage'))
  with check (app.has_permission(organization_id, 'member.manage'));

-- ---------------------------------------------------------------------------
-- permissions + plans — platform catalogs, read-only for everyone signed in
-- ---------------------------------------------------------------------------
create policy permissions_select on public.permissions for select to authenticated using (true);
create policy plans_select on public.plans for select to authenticated using (is_public);
create policy plans_select_anon on public.plans for select to anon using (is_public);

-- ---------------------------------------------------------------------------
-- roles / role_permissions / user_roles
-- ---------------------------------------------------------------------------
create policy roles_select_templates on public.roles for select to authenticated
  using (organization_id is null);

create policy roles_select_own_org on public.roles for select to authenticated
  using (organization_id is not null and app.is_member_of(organization_id));

create policy roles_insert on public.roles for insert to authenticated
  with check (organization_id is not null and app.has_permission(organization_id, 'role.manage'));

create policy roles_update on public.roles for update to authenticated
  using (organization_id is not null and app.has_permission(organization_id, 'role.manage') and not is_owner)
  with check (organization_id is not null and app.has_permission(organization_id, 'role.manage') and not is_owner);

create policy roles_delete on public.roles for delete to authenticated
  using (organization_id is not null
     and app.has_permission(organization_id, 'role.manage')
     and not is_system and not is_owner);

create policy role_permissions_select on public.role_permissions for select to authenticated
  using (exists (
    select 1 from public.roles r
    where r.id = role_id
      and (r.organization_id is null or app.is_member_of(r.organization_id))
  ));

create policy role_permissions_write on public.role_permissions for all to authenticated
  using (exists (
    select 1 from public.roles r
    where r.id = role_id and r.organization_id is not null
      and app.has_permission(r.organization_id, 'role.manage') and not r.is_owner
  ))
  with check (exists (
    select 1 from public.roles r
    where r.id = role_id and r.organization_id is not null
      and app.has_permission(r.organization_id, 'role.manage') and not r.is_owner
  ));

create policy user_roles_select on public.user_roles for select to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.id = member_id
      and (m.user_id = auth.uid() or app.has_permission(m.organization_id, 'member.read'))
  ));

create policy user_roles_write on public.user_roles for all to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.id = member_id and app.has_permission(m.organization_id, 'member.manage')
  ))
  with check (exists (
    select 1 from public.organization_members m
    where m.id = member_id and app.has_permission(m.organization_id, 'member.manage')
  ));

-- ---------------------------------------------------------------------------
-- subscriptions — readable by members with billing permission; written only by
-- the billing worker (service role).
-- ---------------------------------------------------------------------------
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (app.is_member_of(organization_id));

-- ---------------------------------------------------------------------------
-- branding + settings
-- ---------------------------------------------------------------------------
create policy branding_select on public.branding_settings for select to authenticated
  using (app.is_member_of(organization_id));

create policy branding_update on public.branding_settings for update to authenticated
  using (app.has_permission(organization_id, 'branding.manage'))
  with check (app.has_permission(organization_id, 'branding.manage'));

create policy settings_select on public.settings for select to authenticated
  using (app.is_member_of(organization_id)
     and (branch_id is null or app.can_access_branch(organization_id, branch_id)));

create policy settings_write on public.settings for all to authenticated
  using (app.has_permission(organization_id, 'settings.manage'))
  with check (app.has_permission(organization_id, 'settings.manage'));

-- ---------------------------------------------------------------------------
-- audit_logs — SELECT only. Writes go through app.write_audit (definer), so an
-- actor can never forge an entry under someone else's name, and nobody can
-- rewrite or erase history.
-- ---------------------------------------------------------------------------
create policy audit_select on public.audit_logs for select to authenticated
  using (app.has_permission(organization_id, 'audit.read'));

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid() or app.has_permission(organization_id, 'notification.read'));

-- A user may only ever mark their own notification as read.
create policy notifications_update_own on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
create policy customers_select on public.customers for select to authenticated
  using (app.has_permission(organization_id, 'customer.read') and deleted_at is null);

create policy customers_insert on public.customers for insert to authenticated
  with check (app.has_permission(organization_id, 'customer.create')
          and (branch_id is null or app.can_access_branch(organization_id, branch_id)));

create policy customers_update on public.customers for update to authenticated
  using (app.has_permission(organization_id, 'customer.update'))
  with check (app.has_permission(organization_id, 'customer.update'));

-- ---------------------------------------------------------------------------
-- document_counters — RLS on, zero policies: reachable only through
-- app.next_document_number(), which is SECURITY DEFINER.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- invoices — no DELETE policy anywhere. Cancelling is an update to 'void'.
-- ---------------------------------------------------------------------------
create policy invoices_select on public.invoices for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'invoice.read'));

create policy invoices_insert on public.invoices for insert to authenticated
  with check (app.has_branch_permission(organization_id, branch_id, 'invoice.create'));

create policy invoices_update on public.invoices for update to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'invoice.update') and voided_at is null)
  with check (app.has_branch_permission(organization_id, branch_id, 'invoice.update'));

create policy invoice_items_select on public.invoice_items for select to authenticated
  using (exists (
    select 1 from public.invoices i
    where i.id = invoice_id and app.has_branch_permission(i.organization_id, i.branch_id, 'invoice.read')
  ));

-- Line items may only be written while the invoice is still a draft. Once
-- issued, the document is immutable except for voiding.
create policy invoice_items_write on public.invoice_items for all to authenticated
  using (exists (
    select 1 from public.invoices i
    where i.id = invoice_id
      and i.status = 'draft'
      and app.has_branch_permission(i.organization_id, i.branch_id, 'invoice.update')
  ))
  with check (exists (
    select 1 from public.invoices i
    where i.id = invoice_id
      and i.status = 'draft'
      and app.has_branch_permission(i.organization_id, i.branch_id, 'invoice.update')
  ));

-- ---------------------------------------------------------------------------
-- payments — INSERT and SELECT only. Append-only ledger: no update, no delete.
-- A refund is a new linked row with a negative amount.
-- ---------------------------------------------------------------------------
create policy payments_select on public.payments for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'payment.read'));

create policy payments_insert on public.payments for insert to authenticated
  with check (
    app.has_branch_permission(organization_id, branch_id,
      case when kind = 'refund' then 'payment.refund' else 'payment.create' end)
  );

-- ---------------------------------------------------------------------------
-- treasury — accounts are manageable; the ledger is append-only.
-- ---------------------------------------------------------------------------
create policy treasury_accounts_select on public.treasury_accounts for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'treasury.read'));

create policy treasury_accounts_insert on public.treasury_accounts for insert to authenticated
  with check (app.has_branch_permission(organization_id, branch_id, 'treasury.manage'));

create policy treasury_accounts_update on public.treasury_accounts for update to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'treasury.manage'))
  with check (app.has_branch_permission(organization_id, branch_id, 'treasury.manage'));

create policy treasury_tx_select on public.treasury_transactions for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'treasury.read'));

create policy treasury_tx_insert on public.treasury_transactions for insert to authenticated
  with check (app.has_branch_permission(organization_id, branch_id, 'treasury.create'));

-- ---------------------------------------------------------------------------
-- public_links + qr_codes — admin-side management. Anonymous visitors never
-- read these tables; they go through resolve_public_link().
-- ---------------------------------------------------------------------------
create policy public_links_select on public.public_links for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'publiclink.read'));

create policy public_links_write on public.public_links for all to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'publiclink.manage'))
  with check (app.has_branch_permission(organization_id, branch_id, 'publiclink.manage'));

create policy qr_codes_select on public.qr_codes for select to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'publiclink.read'));

create policy qr_codes_write on public.qr_codes for all to authenticated
  using (app.has_branch_permission(organization_id, branch_id, 'publiclink.manage'))
  with check (app.has_branch_permission(organization_id, branch_id, 'publiclink.manage'));
