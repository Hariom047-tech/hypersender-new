-- =============================================================================
-- 0014 SaaS application (Phase 3) - additive only.
--   * team invitations for EXISTING accounts (accepted in-app)
--   * WEBHOOK_TEST event type for the "Send test event" button
-- =============================================================================

-- Admin-only: resolve an ACTIVE, registered account by email for an invitation.
-- Unlike find_or_create_invited_user (0002) it never creates users, so it cannot
-- be used to squat emails. Callable only by an OWNER/ADMIN of the current org.
CREATE FUNCTION app_auth.find_active_user_for_invite(p_email text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT app.tenant_context_valid() OR NOT app.is_org_admin(app.current_org_id()) THEN
    RAISE EXCEPTION 'insufficient privilege to invite users' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT id INTO v_id FROM app.users
   WHERE email_normalized = lower(btrim(p_email)) AND deleted_at IS NULL AND status = 'ACTIVE';
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app_auth.find_active_user_for_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_auth.find_active_user_for_invite(text) TO hs_app;

-- The invited user cannot read the organization row yet (not an ACTIVE member),
-- so pending invitations are exposed through this narrow function: only the
-- caller's own INVITED memberships, only name + role + inviter name.
CREATE FUNCTION app_auth.my_pending_invitations()
RETURNS TABLE (organization_id uuid, organization_name text, role text, invited_by text, invited_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT m.organization_id, o.name, m.role,
         nullif(btrim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), ''), m.created_at
    FROM app.organization_members m
    JOIN app.organizations o ON o.id = m.organization_id AND o.deleted_at IS NULL
    LEFT JOIN app.users u ON u.id = m.invited_by_user_id
   WHERE m.user_id = app.current_user_id() AND m.status = 'INVITED'
   ORDER BY m.created_at
$$;
REVOKE ALL ON FUNCTION app_auth.my_pending_invitations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_auth.my_pending_invitations() TO hs_app;

-- Accept: the invitee flips ONLY their own INVITED row to ACTIVE (members_update
-- is admin-only, so this narrow SECURITY DEFINER path is required).
CREATE FUNCTION app_auth.accept_invitation(p_org uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.organization_members SET status = 'ACTIVE', joined_at = now()
   WHERE organization_id = p_org AND user_id = app.current_user_id() AND status = 'INVITED';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app_auth.accept_invitation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_auth.accept_invitation(uuid) TO hs_app;

-- Decline: remove only the caller's own INVITED row.
CREATE FUNCTION app_auth.decline_invitation(p_org uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM app.organization_members
   WHERE organization_id = p_org AND user_id = app.current_user_id() AND status = 'INVITED';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app_auth.decline_invitation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_auth.decline_invitation(uuid) TO hs_app;

-- Platform lookup row for the webhook "Send test event" action.
INSERT INTO app.webhook_event_types (code, description)
VALUES ('WEBHOOK_TEST', 'Synthetic event sent by the "Send test event" action')
ON CONFLICT (code) DO NOTHING;
