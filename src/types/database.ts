// AUTO-GENERATED — do not edit by hand.
// Regenerate with: PGPORT=5433 python3 scripts/gen-db-types.py
// Source of truth is supabase/migrations/*.sql.
//
// Relationships are emitted only for the tables listed in EMBEDDED_TABLES in
// the generator — see the comment there for why emitting them everywhere
// breaks type inference.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      audit_logs: {
        Row: {
          id: number;
          organization_id: string;
          branch_id: string | null;
          actor_id: string | null;
          actor_label: string | null;
          action: string;
          entity_type: string;
          entity_id: string | null;
          before: Json | null;
          after: Json | null;
          ip: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          organization_id: string;
          branch_id?: string | null;
          actor_id?: string | null;
          actor_label?: string | null;
          action: string;
          entity_type: string;
          entity_id?: string | null;
          before?: Json | null;
          after?: Json | null;
          ip?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          organization_id?: string;
          branch_id?: string | null;
          actor_id?: string | null;
          actor_label?: string | null;
          action?: string;
          entity_type?: string;
          entity_id?: string | null;
          before?: Json | null;
          after?: Json | null;
          ip?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      branches: {
        Row: {
          id: string;
          organization_id: string;
          slug: string;
          name: string;
          address: string | null;
          phone: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          slug: string;
          name: string;
          address?: string | null;
          phone?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          slug?: string;
          name?: string;
          address?: string | null;
          phone?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      branding_settings: {
        Row: {
          organization_id: string;
          logo_url: string | null;
          display_name: string | null;
          primary_color: string;
          secondary_color: string;
          phone: string | null;
          whatsapp: string | null;
          email: string | null;
          white_label: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          organization_id: string;
          logo_url?: string | null;
          display_name?: string | null;
          primary_color?: string;
          secondary_color?: string;
          phone?: string | null;
          whatsapp?: string | null;
          email?: string | null;
          white_label?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          organization_id?: string;
          logo_url?: string | null;
          display_name?: string | null;
          primary_color?: string;
          secondary_color?: string;
          phone?: string | null;
          whatsapp?: string | null;
          email?: string | null;
          white_label?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      customers: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string | null;
          name: string;
          phone: string | null;
          email: string | null;
          tax_id: string | null;
          address: string | null;
          notes: string | null;
          user_id: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id?: string | null;
          name: string;
          phone?: string | null;
          email?: string | null;
          tax_id?: string | null;
          address?: string | null;
          notes?: string | null;
          user_id?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          branch_id?: string | null;
          name?: string;
          phone?: string | null;
          email?: string | null;
          tax_id?: string | null;
          address?: string | null;
          notes?: string | null;
          user_id?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      document_counters: {
        Row: {
          organization_id: string;
          branch_id: string;
          doc_type: string;
          prefix: string;
          next_number: number;
        };
        Insert: {
          organization_id: string;
          branch_id: string;
          doc_type: string;
          prefix?: string;
          next_number?: number;
        };
        Update: {
          organization_id?: string;
          branch_id?: string;
          doc_type?: string;
          prefix?: string;
          next_number?: number;
        };
        Relationships: [];
      };
      invitations: {
        Row: {
          id: string;
          organization_id: string;
          email: string;
          token_hash: string;
          role_ids: string[];
          branch_ids: string[];
          all_branches: boolean;
          invited_by: string;
          expires_at: string;
          accepted_at: string | null;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          email: string;
          token_hash: string;
          role_ids?: string[];
          branch_ids?: string[];
          all_branches?: boolean;
          invited_by: string;
          expires_at: string;
          accepted_at?: string | null;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          email?: string;
          token_hash?: string;
          role_ids?: string[];
          branch_ids?: string[];
          all_branches?: boolean;
          invited_by?: string;
          expires_at?: string;
          accepted_at?: string | null;
          revoked_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      invoice_items: {
        Row: {
          id: string;
          invoice_id: string;
          organization_id: string;
          ref_type: string | null;
          ref_id: string | null;
          description: string;
          quantity: number;
          unit_price_cents: number;
          discount_cents: number;
          tax_rate_bp: number;
          total_cents: number;
          position: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          invoice_id: string;
          organization_id: string;
          ref_type?: string | null;
          ref_id?: string | null;
          description: string;
          quantity: number;
          unit_price_cents: number;
          discount_cents?: number;
          tax_rate_bp?: number;
          total_cents: number;
          position?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          invoice_id?: string;
          organization_id?: string;
          ref_type?: string | null;
          ref_id?: string | null;
          description?: string;
          quantity?: number;
          unit_price_cents?: number;
          discount_cents?: number;
          tax_rate_bp?: number;
          total_cents?: number;
          position?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      invoices: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string;
          number: string;
          customer_id: string | null;
          status: string;
          source: string;
          currency: string;
          subtotal_cents: number;
          discount_cents: number;
          tax_cents: number;
          total_cents: number;
          paid_cents: number;
          notes: string | null;
          issued_at: string | null;
          due_at: string | null;
          voided_at: string | null;
          void_reason: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id: string;
          number: string;
          customer_id?: string | null;
          status?: string;
          source?: string;
          currency: string;
          subtotal_cents?: number;
          discount_cents?: number;
          tax_cents?: number;
          total_cents?: number;
          paid_cents?: number;
          notes?: string | null;
          issued_at?: string | null;
          due_at?: string | null;
          voided_at?: string | null;
          void_reason?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          branch_id?: string;
          number?: string;
          customer_id?: string | null;
          status?: string;
          source?: string;
          currency?: string;
          subtotal_cents?: number;
          discount_cents?: number;
          tax_cents?: number;
          total_cents?: number;
          paid_cents?: number;
          notes?: string | null;
          issued_at?: string | null;
          due_at?: string | null;
          voided_at?: string | null;
          void_reason?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
        };
        Relationships: [];
      };
      member_branches: {
        Row: {
          member_id: string;
          branch_id: string;
          created_at: string;
        };
        Insert: {
          member_id: string;
          branch_id: string;
          created_at?: string;
        };
        Update: {
          member_id?: string;
          branch_id?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      notifications: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string | null;
          user_id: string | null;
          recipient: string | null;
          channel: string;
          template: string;
          payload: Json;
          status: string;
          attempts: number;
          last_error: string | null;
          scheduled_for: string;
          sent_at: string | null;
          read_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id?: string | null;
          user_id?: string | null;
          recipient?: string | null;
          channel: string;
          template: string;
          payload?: Json;
          status?: string;
          attempts?: number;
          last_error?: string | null;
          scheduled_for?: string;
          sent_at?: string | null;
          read_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          branch_id?: string | null;
          user_id?: string | null;
          recipient?: string | null;
          channel?: string;
          template?: string;
          payload?: Json;
          status?: string;
          attempts?: number;
          last_error?: string | null;
          scheduled_for?: string;
          sent_at?: string | null;
          read_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      organization_members: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          status: string;
          all_branches: boolean;
          invited_by: string | null;
          invited_at: string | null;
          joined_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          status?: string;
          all_branches?: boolean;
          invited_by?: string | null;
          invited_at?: string | null;
          joined_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          status?: string;
          all_branches?: boolean;
          invited_by?: string | null;
          invited_at?: string | null;
          joined_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "organization_members_invited_by_fkey"; columns: ["invited_by"]; isOneToOne: false; referencedRelation: "profiles"; referencedColumns: ["id"] },
          { foreignKeyName: "organization_members_organization_id_fkey"; columns: ["organization_id"]; isOneToOne: false; referencedRelation: "organizations"; referencedColumns: ["id"] },
          { foreignKeyName: "organization_members_user_id_fkey"; columns: ["user_id"]; isOneToOne: false; referencedRelation: "profiles"; referencedColumns: ["id"] },
        ];
      };
      organization_modules: {
        Row: {
          id: string;
          organization_id: string;
          module_key: string;
          is_primary: boolean;
          enabled: boolean;
          settings: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          module_key: string;
          is_primary?: boolean;
          enabled?: boolean;
          settings?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          module_key?: string;
          is_primary?: boolean;
          enabled?: boolean;
          settings?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      organizations: {
        Row: {
          id: string;
          slug: string;
          name: string;
          primary_module: string;
          status: string;
          country: string;
          currency: string;
          timezone: string;
          default_locale: string;
          owner_user_id: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          primary_module: string;
          status?: string;
          country?: string;
          currency?: string;
          timezone?: string;
          default_locale?: string;
          owner_user_id: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          slug?: string;
          name?: string;
          primary_module?: string;
          status?: string;
          country?: string;
          currency?: string;
          timezone?: string;
          default_locale?: string;
          owner_user_id?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      payments: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string;
          invoice_id: string | null;
          customer_id: string | null;
          kind: string;
          method: string;
          amount_cents: number;
          currency: string;
          status: string;
          treasury_account_id: string | null;
          reference: string | null;
          provider: string | null;
          provider_ref: string | null;
          refund_of_id: string | null;
          created_at: string;
          created_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id: string;
          invoice_id?: string | null;
          customer_id?: string | null;
          kind?: string;
          method: string;
          amount_cents: number;
          currency: string;
          status?: string;
          treasury_account_id?: string | null;
          reference?: string | null;
          provider?: string | null;
          provider_ref?: string | null;
          refund_of_id?: string | null;
          created_at?: string;
          created_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          branch_id?: string;
          invoice_id?: string | null;
          customer_id?: string | null;
          kind?: string;
          method?: string;
          amount_cents?: number;
          currency?: string;
          status?: string;
          treasury_account_id?: string | null;
          reference?: string | null;
          provider?: string | null;
          provider_ref?: string | null;
          refund_of_id?: string | null;
          created_at?: string;
          created_by?: string | null;
        };
        Relationships: [];
      };
      permissions: {
        Row: {
          key: string;
          group_key: string;
          module_key: string | null;
          description: string;
          is_elevated: boolean;
          created_at: string;
        };
        Insert: {
          key: string;
          group_key: string;
          module_key?: string | null;
          description: string;
          is_elevated?: boolean;
          created_at?: string;
        };
        Update: {
          key?: string;
          group_key?: string;
          module_key?: string | null;
          description?: string;
          is_elevated?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      plans: {
        Row: {
          id: string;
          key: string;
          name_ar: string;
          name_en: string;
          price_cents: number;
          currency: string;
          interval: string;
          limits: Json;
          features: Json;
          is_public: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          key: string;
          name_ar: string;
          name_en: string;
          price_cents?: number;
          currency?: string;
          interval?: string;
          limits?: Json;
          features?: Json;
          is_public?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          key?: string;
          name_ar?: string;
          name_en?: string;
          price_cents?: number;
          currency?: string;
          interval?: string;
          limits?: Json;
          features?: Json;
          is_public?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          full_name: string | null;
          phone: string | null;
          avatar_url: string | null;
          locale: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          full_name?: string | null;
          phone?: string | null;
          avatar_url?: string | null;
          locale?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          full_name?: string | null;
          phone?: string | null;
          avatar_url?: string | null;
          locale?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      public_links: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string;
          kind: string;
          token: string;
          target: Json;
          label: string | null;
          is_active: boolean;
          expires_at: string | null;
          revoked_at: string | null;
          last_used_at: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id: string;
          kind: string;
          token: string;
          target?: Json;
          label?: string | null;
          is_active?: boolean;
          expires_at?: string | null;
          revoked_at?: string | null;
          last_used_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          branch_id?: string;
          kind?: string;
          token?: string;
          target?: Json;
          label?: string | null;
          is_active?: boolean;
          expires_at?: string | null;
          revoked_at?: string | null;
          last_used_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
        };
        Relationships: [];
      };
      qr_codes: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string;
          public_link_id: string;
          label: string;
          entity_type: string | null;
          entity_id: string | null;
          is_active: boolean;
          printed_at: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id: string;
          public_link_id: string;
          label: string;
          entity_type?: string | null;
          entity_id?: string | null;
          is_active?: boolean;
          printed_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          branch_id?: string;
          public_link_id?: string;
          label?: string;
          entity_type?: string | null;
          entity_id?: string | null;
          is_active?: boolean;
          printed_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
        };
        Relationships: [];
      };
      role_permissions: {
        Row: {
          role_id: string;
          permission_key: string;
          created_at: string;
        };
        Insert: {
          role_id: string;
          permission_key: string;
          created_at?: string;
        };
        Update: {
          role_id?: string;
          permission_key?: string;
          created_at?: string;
        };
        Relationships: [
          { foreignKeyName: "role_permissions_permission_key_fkey"; columns: ["permission_key"]; isOneToOne: false; referencedRelation: "permissions"; referencedColumns: ["key"] },
          { foreignKeyName: "role_permissions_role_id_fkey"; columns: ["role_id"]; isOneToOne: false; referencedRelation: "roles"; referencedColumns: ["id"] },
        ];
      };
      roles: {
        Row: {
          id: string;
          organization_id: string | null;
          key: string;
          name_ar: string;
          name_en: string;
          description: string | null;
          is_system: boolean;
          is_owner: boolean;
          module_key: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          key: string;
          name_ar: string;
          name_en: string;
          description?: string | null;
          is_system?: boolean;
          is_owner?: boolean;
          module_key?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string | null;
          key?: string;
          name_ar?: string;
          name_en?: string;
          description?: string | null;
          is_system?: boolean;
          is_owner?: boolean;
          module_key?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      settings: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string | null;
          key: string;
          value: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id?: string | null;
          key: string;
          value: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          branch_id?: string | null;
          key?: string;
          value?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          id: string;
          organization_id: string;
          plan_id: string;
          status: string;
          current_period_start: string;
          current_period_end: string;
          cancel_at_period_end: boolean;
          provider: string | null;
          provider_ref: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          plan_id: string;
          status?: string;
          current_period_start?: string;
          current_period_end: string;
          cancel_at_period_end?: boolean;
          provider?: string | null;
          provider_ref?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          plan_id?: string;
          status?: string;
          current_period_start?: string;
          current_period_end?: string;
          cancel_at_period_end?: boolean;
          provider?: string | null;
          provider_ref?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "subscriptions_organization_id_fkey"; columns: ["organization_id"]; isOneToOne: true; referencedRelation: "organizations"; referencedColumns: ["id"] },
          { foreignKeyName: "subscriptions_plan_id_fkey"; columns: ["plan_id"]; isOneToOne: false; referencedRelation: "plans"; referencedColumns: ["id"] },
        ];
      };
      treasury_accounts: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string;
          name: string;
          type: string;
          currency: string;
          is_default: boolean;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id: string;
          name: string;
          type?: string;
          currency: string;
          is_default?: boolean;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          branch_id?: string;
          name?: string;
          type?: string;
          currency?: string;
          is_default?: boolean;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      treasury_transactions: {
        Row: {
          id: string;
          organization_id: string;
          branch_id: string;
          account_id: string;
          direction: string;
          amount_cents: number;
          currency: string;
          category: string;
          reason: string | null;
          ref_type: string | null;
          ref_id: string | null;
          occurred_at: string;
          created_at: string;
          created_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          branch_id: string;
          account_id: string;
          direction: string;
          amount_cents: number;
          currency: string;
          category: string;
          reason?: string | null;
          ref_type?: string | null;
          ref_id?: string | null;
          occurred_at?: string;
          created_at?: string;
          created_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          branch_id?: string;
          account_id?: string;
          direction?: string;
          amount_cents?: number;
          currency?: string;
          category?: string;
          reason?: string | null;
          ref_type?: string | null;
          ref_id?: string | null;
          occurred_at?: string;
          created_at?: string;
          created_by?: string | null;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          id: string;
          member_id: string;
          role_id: string;
          branch_id: string | null;
          granted_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          member_id: string;
          role_id: string;
          branch_id?: string | null;
          granted_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          member_id?: string;
          role_id?: string;
          branch_id?: string | null;
          granted_by?: string | null;
          created_at?: string;
        };
        Relationships: [
          { foreignKeyName: "user_roles_branch_id_fkey"; columns: ["branch_id"]; isOneToOne: false; referencedRelation: "branches"; referencedColumns: ["id"] },
          { foreignKeyName: "user_roles_granted_by_fkey"; columns: ["granted_by"]; isOneToOne: false; referencedRelation: "profiles"; referencedColumns: ["id"] },
          { foreignKeyName: "user_roles_member_id_fkey"; columns: ["member_id"]; isOneToOne: false; referencedRelation: "organization_members"; referencedColumns: ["id"] },
          { foreignKeyName: "user_roles_role_id_fkey"; columns: ["role_id"]; isOneToOne: false; referencedRelation: "roles"; referencedColumns: ["id"] },
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      is_org_slug_available: { Args: Record<string, unknown>; Returns: Json };
      provision_workspace: { Args: Record<string, unknown>; Returns: Json };
      resolve_public_link: { Args: Record<string, unknown>; Returns: Json };
      treasury_account_balance: { Args: Record<string, unknown>; Returns: Json };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];
