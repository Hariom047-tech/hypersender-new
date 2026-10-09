-- =============================================================================
-- 0013 Lease claim for an explicit, user-initiated (re)link.
--
-- app.claim_instance_lease (0003) refuses LOGGED_OUT instances - correct for
-- automatic restores (a logged-out session must never be silently revived).
-- But "Connect" after a logout (new QR) is legitimate. This variant admits
-- LOGGED_OUT as well; SUSPENDED and deleted instances stay locked.
-- Same compare-and-set + fencing-token semantics. Only the gateway worker may
-- call it, and it is only reached through an authorised API CONNECT command.
-- =============================================================================
CREATE FUNCTION app.claim_instance_lease_for_link(p_instance_id uuid, p_worker_id uuid, p_lease_seconds integer)
RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  UPDATE app.whatsapp_instances
     SET worker_id               = p_worker_id,
         worker_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         worker_lease_token      = CASE WHEN worker_id = p_worker_id AND worker_lease_expires_at > now()
                                        THEN worker_lease_token ELSE worker_lease_token + 1 END
   WHERE id = p_instance_id
     AND deleted_at IS NULL
     AND status <> 'SUSPENDED'
     AND (worker_id IS NULL OR worker_lease_expires_at <= now() OR worker_id = p_worker_id)
  RETURNING worker_lease_token
$$;
REVOKE ALL ON FUNCTION app.claim_instance_lease_for_link(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_instance_lease_for_link(uuid, uuid, integer) TO hs_worker;
