REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER TABLE chain_events ADD COLUMN last_checked_at timestamptz;
GRANT SELECT ON schema_migrations TO memocean_request;
REVOKE ALL ON schema_migrations FROM memocean_worker;
GRANT UPDATE(entitlement_id) ON project_capsules TO memocean_request;
-- The backfill is safe only on a new database: v1 created no trial attempts before this migration.
ALTER TABLE trial_attempts ADD COLUMN tenant_id uuid NOT NULL REFERENCES tenants;
ALTER TABLE trial_attempts ADD COLUMN project_id uuid NOT NULL;
ALTER TABLE trial_attempts ADD CONSTRAINT trial_project_fk FOREIGN KEY(project_id,tenant_id) REFERENCES projects(id,tenant_id);
ALTER POLICY own_trial ON trial_attempts WITH CHECK(user_id=app_user() AND tenant_id=app_tenant() AND app_project(project_id,tenant_id));
CREATE TABLE request_rate_windows (rate_key text NOT NULL, window_start timestamptz NOT NULL, used integer NOT NULL CHECK(used>0), PRIMARY KEY(rate_key,window_start));
ALTER TABLE request_rate_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_rate_windows FORCE ROW LEVEL SECURITY;
DO $$ BEGIN EXECUTE format('CREATE POLICY rate_owner ON request_rate_windows TO %I USING (true) WITH CHECK (true)',current_user); END $$;
CREATE POLICY rate_worker ON request_rate_windows TO memocean_worker USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON request_rate_windows TO memocean_worker;
CREATE FUNCTION memocean_request_limit(th hash32) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE principal record; minute timestamptz:=date_trunc('minute',now()); k text; lim integer; changed integer;
BEGIN
 SELECT * INTO principal FROM memocean_authenticate(th);
 IF NOT FOUND THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['tenant:'||principal.tenant_id::text,'user:'||principal.user_id::text] LOOP
  lim:=CASE WHEN left(k,7)='tenant:' THEN 600 ELSE 120 END;
  INSERT INTO request_rate_windows(rate_key,window_start,used) VALUES(k,minute,1) ON CONFLICT(rate_key,window_start) DO UPDATE SET used=request_rate_windows.used+1 WHERE request_rate_windows.used<lim;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed=0 THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE FUNCTION memocean_revoke_session(th hash32) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=th $$;
CREATE FUNCTION memocean_catalog() RETURNS TABLE(capsule_root_id uuid,capsule_version_id uuid,version bigint,title text,license text,listing_id text,price_wei text,seller text,contract_address text,chain_id bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.root_id,v.id,v.version,c.title,v.license_spdx_or_custom,l.listing_id::text,l.price_wei::text,l.seller::text,d.contract_address::text,d.chain_id
 FROM capsules c JOIN capsule_versions v ON v.root_id=c.root_id JOIN listings l ON l.capsule_version_id=v.id JOIN chain_deployments d ON d.id=l.deployment_id
 JOIN artifacts a ON a.id=v.artifact_id JOIN irys_transactions tx ON tx.artifact_id=a.id JOIN capsule_previews p ON p.capsule_version_id=v.id
 JOIN artifacts pa ON pa.id=p.artifact_id JOIN irys_transactions ptx ON ptx.artifact_id=pa.id
 WHERE l.active AND v.review_state='approved' AND a.state='indexed' AND tx.permanence_verified AND tx.verified_at IS NOT NULL AND tx.verified_cipher_sha256=a.cipher_sha256 AND tx.verified_manifest_sha256=a.manifest_sha256
 AND pa.id<>a.id AND pa.state='indexed' AND ptx.permanence_verified AND ptx.verified_at IS NOT NULL AND ptx.verified_cipher_sha256=pa.cipher_sha256 AND ptx.verified_manifest_sha256=pa.manifest_sha256
 ORDER BY c.created_at DESC,c.root_id,v.version DESC LIMIT 50
$$;
REVOKE ALL ON FUNCTION memocean_request_limit(hash32),memocean_revoke_session(hash32),memocean_catalog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memocean_request_limit(hash32),memocean_revoke_session(hash32),memocean_catalog() TO memocean_request;
