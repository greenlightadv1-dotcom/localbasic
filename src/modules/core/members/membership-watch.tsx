'use client';

import { useEffect } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { signOutAction } from '@/app/(auth)/actions';

/**
 * Instant sign-out when this account is removed from the organization.
 *
 * THE SERVER SIDE WAS ALREADY CORRECT WITHOUT THIS. member_remove() (0064)
 * deletes the row and every permission check in this codebase reads
 * organization_members/user_roles live, on every request — the removed
 * member's very next action already fails authorization. This component
 * changes nothing about that; it exists only so a tab left open does not
 * have to attempt one more action and get a 403 to find out. It is UX, not
 * the security boundary.
 *
 * The subscription is scoped by the SAME RLS organization_members already
 * carries (members_select_self, 0007): a postgres_changes feed only ever
 * delivers rows the subscriber's own session could SELECT directly, so this
 * grants no read access beyond what a member could already fetch by polling
 * their own membership row.
 */
export function MembershipWatch({ userId }: { userId: string }) {
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();

    const channel = supabase
      .channel(`membership-watch:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'organization_members',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void signOutAction();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  return null;
}
