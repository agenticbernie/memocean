-- Bootstrap NOLOGIN roles separately before migrations (see OPERATIONS.md).
-- The migration owner owns tables; runtime logins must never own them or BYPASSRLS.
CREATE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id',true),'')::uuid $$;
CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::uuid $$;
CREATE FUNCTION app_member(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=t AND m.user_id=app_user() AND m.revoked_at IS NULL AND u.disabled_at IS NULL) $$;
CREATE FUNCTION app_project(p uuid,t uuid,write_access boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT app_member(t) AND EXISTS(SELECT 1 FROM project_acl a WHERE a.project_id=p AND a.tenant_id=t AND a.user_id=app_user() AND (NOT write_access OR a.permission IN ('write','admin'))) $$;
CREATE FUNCTION app_entitled(v uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM entitlements e JOIN orders o ON o.id=e.order_id JOIN chain_events ce ON ce.id=o.event_id JOIN wallet_bindings wb ON wb.user_id=e.user_id AND wb.address=e.buyer_wallet WHERE e.user_id=app_user() AND e.capsule_version_id=v AND e.state='active' AND e.last_chain_check_at>now()-interval '60 seconds' AND o.state='confirmed' AND ce.state='confirmed' AND wb.revoked_at IS NULL AND o.buyer_wallet=e.buyer_wallet AND o.buyer_user_id=e.user_id) $$;

DO $policies$
DECLARE t text; owner_name text := current_user;
BEGIN
  -- A narrowly granted SECURITY DEFINER function can act as the migration owner.
  -- Ordinary request SQL always sees FORCE RLS and cannot assume that role.
  FOREACH t IN ARRAY ARRAY['users','tenants','memberships','wallet_bindings','auth_challenges','auth_sessions','projects','project_acl','api_keys','key_envelopes','artifacts','irys_transactions','approval_drafts','memories','memory_revisions','capsules','capsule_versions','capsule_previews','memory_chunks','capsule_chunks','chain_deployments','capsule_root_bindings','listings','chain_events','orders','entitlements','project_capsules','trial_counters','trial_attempts','paid_query_attempts','jobs','outbox','inference_budgets','chat_answers','answer_citations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY migration_owner ON %I TO %I USING (true) WITH CHECK (true)',t,owner_name);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='memocean_worker') THEN
      EXECUTE format('CREATE POLICY background_worker ON %I TO memocean_worker USING (true) WITH CHECK (true)',t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['projects','project_acl','api_keys','key_envelopes','artifacts','approval_drafts','memories','memory_revisions','memory_chunks','paid_query_attempts','jobs','outbox','chat_answers','project_capsules'] LOOP
    EXECUTE format('CREATE POLICY tenant_scope ON %I AS RESTRICTIVE USING (tenant_id=app_tenant() AND app_member(tenant_id)) WITH CHECK (tenant_id=app_tenant() AND app_member(tenant_id))',t);
  END LOOP;
END $policies$;
-- Restrictive tenant scope must not apply to owner/worker: use only request-role targeting.
-- Retarget restrictive policies to memocean_request when provisioned; otherwise no role is granted access.
DO $policies$
DECLARE t text;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='memocean_request') THEN
  FOREACH t IN ARRAY ARRAY['projects','project_acl','api_keys','key_envelopes','artifacts','approval_drafts','memories','memory_revisions','memory_chunks','paid_query_attempts','jobs','outbox','chat_answers','project_capsules'] LOOP
    EXECUTE format('ALTER POLICY tenant_scope ON %I TO memocean_request',t);
  END LOOP;
 ELSE
  -- No request role yet: remove the restrictive policies; rerun provisioning before migration.
  RAISE EXCEPTION 'Provision memocean_request and memocean_worker NOLOGIN roles before migration';
 END IF;
END $policies$;
CREATE POLICY own_membership ON memberships FOR SELECT USING(user_id=app_user() AND tenant_id=app_tenant());
CREATE POLICY own_tenant ON tenants FOR SELECT USING(id=app_tenant() AND app_member(id));
CREATE POLICY project_access ON projects USING(app_project(id,tenant_id)) WITH CHECK(tenant_id=app_tenant() AND app_member(tenant_id));
CREATE POLICY own_acl ON project_acl USING(user_id=app_user()) WITH CHECK(user_id=app_user() AND app_member(tenant_id));
CREATE POLICY own_key ON api_keys USING(user_id=app_user()) WITH CHECK(user_id=app_user());
CREATE POLICY tenant_envelope ON key_envelopes USING(app_member(tenant_id)) WITH CHECK(app_member(tenant_id));
CREATE POLICY artifact_private_read ON artifacts FOR SELECT USING(app_member(tenant_id) AND EXISTS(SELECT 1 FROM memory_revisions r JOIN memories m ON m.id=r.memory_id AND m.tenant_id=r.tenant_id WHERE r.artifact_id=artifacts.id AND app_project(m.project_id,m.tenant_id)));
CREATE POLICY artifact_insert ON artifacts FOR INSERT WITH CHECK(tenant_id=app_tenant() AND reviewed_by=app_user() AND app_member(tenant_id));
CREATE POLICY artifact_seller_read ON artifacts FOR SELECT USING(EXISTS(SELECT 1 FROM capsule_versions cv WHERE cv.artifact_id=artifacts.id AND app_member(cv.owner_tenant_id)));
CREATE POLICY artifact_paid ON artifacts FOR SELECT USING(EXISTS(SELECT 1 FROM capsule_versions cv WHERE cv.artifact_id=artifacts.id AND app_entitled(cv.id)));
-- Public previews are independently reviewed derivatives, never paid-corpus rows.
CREATE POLICY preview_artifact ON artifacts FOR SELECT USING(EXISTS(SELECT 1 FROM capsule_previews cp WHERE cp.artifact_id=artifacts.id));
-- Artifacts also need cross-tenant licensed read: tenant_scope is replaced by the explicit union.
DROP POLICY tenant_scope ON artifacts;
CREATE POLICY own_draft ON approval_drafts USING(requested_by=app_user() AND app_project(project_id,tenant_id,true)) WITH CHECK(requested_by=app_user() AND app_project(project_id,tenant_id,true));
CREATE POLICY memory_access ON memories USING(app_project(project_id,tenant_id)) WITH CHECK(created_by=app_user() AND app_project(project_id,tenant_id,true));
CREATE POLICY revision_access ON memory_revisions USING(EXISTS(SELECT 1 FROM memories m WHERE m.id=memory_id AND app_project(m.project_id,m.tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM memories m WHERE m.id=memory_id AND app_project(m.project_id,m.tenant_id,true)));
CREATE POLICY chunk_access ON memory_chunks FOR SELECT USING(EXISTS(SELECT 1 FROM memory_revisions r JOIN memories m ON m.id=r.memory_id WHERE r.id=revision_id AND app_project(m.project_id,m.tenant_id)));
CREATE POLICY transaction_access ON irys_transactions FOR SELECT USING(EXISTS(SELECT 1 FROM artifacts a WHERE a.id=artifact_id));
CREATE POLICY own_job ON jobs USING(requested_by=app_user()) WITH CHECK(requested_by=app_user());
CREATE POLICY own_outbox ON outbox USING(tenant_id=app_tenant() AND app_member(tenant_id)) WITH CHECK(tenant_id=app_tenant() AND app_member(tenant_id));
CREATE POLICY own_chat ON chat_answers USING(user_id=app_user() AND app_project(project_id,tenant_id)) WITH CHECK(user_id=app_user() AND app_project(project_id,tenant_id));
CREATE POLICY own_citation ON answer_citations USING(EXISTS(SELECT 1 FROM chat_answers a WHERE a.id=answer_id AND a.user_id=app_user()));
CREATE POLICY capsule_metadata ON capsules FOR SELECT USING(true);
CREATE POLICY version_metadata ON capsule_versions FOR SELECT USING(review_state='approved' OR app_member(owner_tenant_id));
CREATE POLICY preview_read ON capsule_previews FOR SELECT USING(EXISTS(SELECT 1 FROM capsule_versions v WHERE v.id=capsule_version_id AND v.review_state='approved'));
CREATE POLICY licensed_chunks ON capsule_chunks FOR SELECT USING(app_entitled(capsule_version_id) OR app_member(owner_tenant_id));
CREATE POLICY public_deployment ON chain_deployments FOR SELECT USING(true);
CREATE POLICY public_root_binding ON capsule_root_bindings FOR SELECT USING(true);
CREATE POLICY public_listing ON listings FOR SELECT USING(true);
CREATE POLICY own_order ON orders FOR SELECT USING(buyer_user_id=app_user());
CREATE POLICY own_entitlement ON entitlements FOR SELECT USING(user_id=app_user());
CREATE POLICY own_mapping ON project_capsules USING(user_id=app_user() AND app_project(project_id,tenant_id)) WITH CHECK(user_id=app_user() AND app_project(project_id,tenant_id,true) AND EXISTS(SELECT 1 FROM entitlements e WHERE e.id=entitlement_id AND e.user_id=app_user() AND e.capsule_version_id=project_capsules.capsule_version_id AND app_entitled(e.capsule_version_id)));
CREATE POLICY own_trial_counter ON trial_counters USING(user_id=app_user()) WITH CHECK(user_id=app_user());
CREATE POLICY own_trial ON trial_attempts USING(user_id=app_user()) WITH CHECK(user_id=app_user());
CREATE POLICY own_paid_attempt ON paid_query_attempts USING(user_id=app_user() AND app_project(project_id,tenant_id)) WITH CHECK(user_id=app_user() AND app_project(project_id,tenant_id));

CREATE FUNCTION memocean_create_challenge(n hash32,a evm_address,d text,u text,c bigint,m hash32,e timestamptz) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF e>now()+interval '6 minutes' OR e<=now() OR c<=0 THEN RAISE EXCEPTION 'Invalid challenge'; END IF;
 INSERT INTO auth_challenges(nonce_hash,expected_address,domain,uri,chain_id,message_sha256,expires_at) VALUES(n,a,d,u,c,m,e);
END $$;
CREATE FUNCTION memocean_finish_login(n hash32,m hash32,a evm_address,c bigint,th hash32) RETURNS TABLE(user_id uuid,tenant_id uuid,project_id uuid,expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE challenge auth_challenges%ROWTYPE; uid uuid; tid uuid; pid uuid; exp timestamptz:=now()+interval '1 hour';
BEGIN
 SELECT * INTO challenge FROM auth_challenges ac WHERE ac.nonce_hash=n FOR UPDATE;
 IF NOT FOUND OR challenge.consumed_at IS NOT NULL OR challenge.expires_at<=now() OR challenge.message_sha256<>m OR challenge.expected_address<>a OR challenge.chain_id<>c THEN RAISE EXCEPTION 'Invalid or expired challenge' USING ERRCODE='28000'; END IF;
 -- Serialize first-login creation for this wallet; hash collisions only serialize unrelated wallets.
 PERFORM pg_advisory_xact_lock(hashtextextended(a,0));
 SELECT wb.user_id INTO uid FROM wallet_bindings wb JOIN users us ON us.id=wb.user_id WHERE wb.address=a AND wb.revoked_at IS NULL AND us.disabled_at IS NULL;
 IF uid IS NULL THEN
  IF EXISTS(SELECT 1 FROM wallet_bindings wb WHERE wb.address=a) THEN RAISE EXCEPTION 'Wallet unavailable' USING ERRCODE='28000'; END IF;
  INSERT INTO users(external_subject) VALUES('wallet:'||a) RETURNING id INTO uid;
  INSERT INTO tenants(name) VALUES('Personal workspace') RETURNING id INTO tid;
  INSERT INTO memberships(tenant_id,user_id,role) VALUES(tid,uid,'owner');
  INSERT INTO wallet_bindings(user_id,address,verified_at) VALUES(uid,a,now());
  INSERT INTO projects(tenant_id,name) VALUES(tid,'Personal project') RETURNING id INTO pid;
  INSERT INTO project_acl(project_id,tenant_id,user_id,permission) VALUES(pid,tid,uid,'admin');
 ELSE
  SELECT ms.tenant_id INTO tid FROM memberships ms WHERE ms.user_id=uid AND ms.revoked_at IS NULL ORDER BY ms.tenant_id LIMIT 1;
  SELECT p.id INTO pid FROM projects p JOIN project_acl acl ON acl.project_id=p.id WHERE p.tenant_id=tid AND acl.user_id=uid ORDER BY p.created_at LIMIT 1;
 END IF;
 IF tid IS NULL THEN RAISE EXCEPTION 'No active workspace' USING ERRCODE='28000'; END IF;
 UPDATE auth_challenges SET consumed_at=now() WHERE nonce_hash=n;
 INSERT INTO auth_sessions(user_id,tenant_id,token_hash,expires_at) VALUES(uid,tid,th,exp);
 RETURN QUERY SELECT uid,tid,pid,exp;
END $$;
CREATE FUNCTION memocean_authenticate(th hash32) RETURNS TABLE(user_id uuid,tenant_id uuid,scopes text[],project_ids uuid[],token_id uuid,token_kind text) LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT s.user_id,s.tenant_id,ARRAY['memory:read','memory:write','capsule:query','provenance:read','account:manage'],ARRAY[]::uuid[],s.id,'session'::text FROM auth_sessions s JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id JOIN users u ON u.id=s.user_id WHERE s.token_hash=th AND s.expires_at>now() AND s.revoked_at IS NULL AND m.revoked_at IS NULL AND u.disabled_at IS NULL
 UNION ALL
 SELECT k.user_id,k.tenant_id,k.scopes,k.project_ids,k.id,'pat'::text FROM api_keys k JOIN memberships m ON m.tenant_id=k.tenant_id AND m.user_id=k.user_id JOIN users u ON u.id=k.user_id WHERE k.token_hash=th AND k.expires_at>now() AND k.revoked_at IS NULL AND m.revoked_at IS NULL AND u.disabled_at IS NULL LIMIT 1
$$;
CREATE FUNCTION memocean_reserve_budget(uid uuid,user_limit integer,global_limit integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k text; changed integer;
BEGIN
 IF uid<>app_user() OR user_limit<1 OR global_limit<1 THEN RETURN false; END IF;
 user_limit:=least(user_limit,100); global_limit:=least(global_limit,1000);
 -- One global row lock first gives a deterministic lock order across all callers.
 FOREACH k IN ARRAY ARRAY['global','user:'||uid::text] LOOP
  INSERT INTO inference_budgets(budget_key,day) VALUES(k,current_date) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM inference_budgets WHERE budget_key=k AND day=current_date FOR UPDATE;
 END LOOP;
 IF EXISTS(SELECT 1 FROM inference_budgets WHERE day=current_date AND ((budget_key='global' AND used>=global_limit) OR (budget_key='user:'||uid::text AND used>=user_limit))) THEN RETURN false; END IF;
 UPDATE inference_budgets SET used=used+1 WHERE day=current_date AND budget_key IN ('global','user:'||uid::text);
 RETURN true;
END $$;
-- Runtime cannot alter provider budgets: limits are clamped in the function at deployment.
-- Defense against request-SQL abuse: fixed upper bounds still apply even if arguments are higher.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON FUNCTION app_user(),app_tenant(),app_member(uuid),app_project(uuid,uuid,boolean),app_entitled(uuid),memocean_create_challenge(hash32,evm_address,text,text,bigint,hash32,timestamptz),memocean_finish_login(hash32,hash32,evm_address,bigint,hash32),memocean_authenticate(hash32),memocean_reserve_budget(uuid,integer,integer) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO memocean_request,memocean_worker;
GRANT EXECUTE ON FUNCTION app_user(),app_tenant(),app_member(uuid),app_project(uuid,uuid,boolean),app_entitled(uuid),memocean_create_challenge(hash32,evm_address,text,text,bigint,hash32,timestamptz),memocean_finish_login(hash32,hash32,evm_address,bigint,hash32),memocean_authenticate(hash32),memocean_reserve_budget(uuid,integer,integer) TO memocean_request;
GRANT SELECT ON tenants,memberships,projects,project_acl,api_keys,key_envelopes,artifacts,irys_transactions,approval_drafts,memories,memory_revisions,memory_chunks,capsules,capsule_versions,capsule_previews,capsule_chunks,chain_deployments,capsule_root_bindings,listings,orders,entitlements,project_capsules,trial_counters,trial_attempts,paid_query_attempts,jobs,outbox,chat_answers,answer_citations TO memocean_request;
GRANT INSERT ON projects,project_acl,api_keys,key_envelopes,artifacts,approval_drafts,memories,memory_revisions,jobs,outbox,project_capsules,trial_counters,trial_attempts,paid_query_attempts,chat_answers,answer_citations TO memocean_request;
GRANT UPDATE(state,content_ciphertext,key_envelope_id,candidate_sha256,egress_approved_at,approved_by,approved_at,approval_token_hash,approval_expires_at,consumed_at) ON approval_drafts TO memocean_request;
GRANT UPDATE(revoked_at) ON api_keys TO memocean_request;
GRANT UPDATE(used_count) ON trial_counters TO memocean_request;
GRANT UPDATE(state,response_ciphertext,response_key_envelope_id,lease_until,lease_token,delivered_at) ON trial_attempts TO memocean_request;
GRANT UPDATE(state,response_ciphertext,response_key_envelope_id,lease_until,lease_token) ON paid_query_attempts TO memocean_request;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO memocean_request;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO memocean_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO memocean_worker;
GRANT EXECUTE ON FUNCTION app_user(),app_tenant(),app_member(uuid),app_project(uuid,uuid,boolean),app_entitled(uuid) TO memocean_worker;
