CREATE FUNCTION enforce_artifact_state() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.cipher_sha256<>OLD.cipher_sha256 OR NEW.manifest_sha256<>OLD.manifest_sha256 OR NEW.plain_commitment<>OLD.plain_commitment OR NEW.public_manifest<>OLD.public_manifest OR NEW.key_envelope_id<>OLD.key_envelope_id) THEN RAISE EXCEPTION 'Immutable artifact payload'; END IF;
 IF TG_OP='UPDATE' AND OLD.indexed_payload_sha256 IS NOT NULL AND NEW.indexed_payload_sha256 IS DISTINCT FROM OLD.indexed_payload_sha256 THEN RAISE EXCEPTION 'Immutable verified plaintext digest'; END IF;
 IF NEW.state='indexed' AND NEW.indexed_payload_sha256 IS NULL THEN RAISE EXCEPTION 'Indexed content needs a verifier-derived plaintext digest'; END IF;
 IF NEW.state IN ('verified','indexed') AND NOT EXISTS(SELECT 1 FROM irys_transactions tx WHERE tx.artifact_id=NEW.id AND tx.verified_at IS NOT NULL AND tx.manifest_tx_id IS NOT NULL AND tx.storage_verification_evidence IS NOT NULL AND tx.verified_cipher_sha256=NEW.cipher_sha256 AND tx.verified_manifest_sha256=NEW.manifest_sha256) THEN RAISE EXCEPTION 'Artifact is not storage verified'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER artifact_state_gate BEFORE INSERT OR UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION enforce_artifact_state();
CREATE FUNCTION enforce_preview() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM capsule_versions v WHERE v.id=NEW.capsule_version_id AND v.artifact_id=NEW.artifact_id) THEN RAISE EXCEPTION 'Preview must be a separate artifact'; END IF;
 IF NOT EXISTS(SELECT 1 FROM artifacts a JOIN irys_transactions tx ON tx.artifact_id=a.id WHERE a.id=NEW.artifact_id AND a.tenant_id=NEW.owner_tenant_id AND a.state='indexed' AND a.indexed_payload_sha256=NEW.safe_content_sha256 AND tx.verified_at IS NOT NULL AND tx.permanence_verified) THEN RAISE EXCEPTION 'Preview must be independently indexed and permanently verified'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preview_gate BEFORE INSERT OR UPDATE ON capsule_previews FOR EACH ROW EXECUTE FUNCTION enforce_preview();
CREATE FUNCTION enforce_entitlement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.state='active' AND NOT EXISTS(SELECT 1 FROM orders o JOIN chain_events ce ON ce.id=o.event_id AND ce.deployment_id=o.deployment_id JOIN listings l ON l.id=o.listing_row_id AND l.deployment_id=o.deployment_id JOIN wallet_bindings wb ON wb.address=o.buyer_wallet AND wb.user_id=NEW.user_id WHERE o.id=NEW.order_id AND o.buyer_user_id=NEW.user_id AND o.buyer_wallet=NEW.buyer_wallet AND l.capsule_version_id=NEW.capsule_version_id AND ce.state='confirmed' AND o.state='confirmed' AND wb.revoked_at IS NULL) THEN RAISE EXCEPTION 'Only confirmed buyer-specific exact-version orders grant access'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER entitlement_gate BEFORE INSERT OR UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION enforce_entitlement();
CREATE FUNCTION enforce_citation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM irys_transactions tx JOIN artifacts a ON a.id=tx.artifact_id WHERE tx.tx_id=NEW.irys_tx_id AND a.id=NEW.artifact_id AND a.state='indexed' AND tx.verified_at IS NOT NULL) THEN RAISE EXCEPTION 'Citation must map to its verified indexed artifact'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER citation_gate BEFORE INSERT OR UPDATE ON answer_citations FOR EACH ROW EXECUTE FUNCTION enforce_citation();
CREATE FUNCTION immutable_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append-only content: create a new version'; END $$;
CREATE TRIGGER immutable_memory_revision BEFORE UPDATE OR DELETE ON memory_revisions FOR EACH ROW EXECUTE FUNCTION immutable_revision();
CREATE TRIGGER immutable_approved_version BEFORE UPDATE OR DELETE ON capsule_versions FOR EACH ROW WHEN (OLD.review_state='approved') EXECUTE FUNCTION immutable_revision();
CREATE FUNCTION enforce_irys_immutability() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.verified_at IS NOT NULL THEN RAISE EXCEPTION 'Verified storage records are append-only'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.verified_at IS NOT NULL AND (NEW.verified_at IS NULL OR NEW.tx_id<>OLD.tx_id OR NEW.artifact_id<>OLD.artifact_id OR NEW.network<>OLD.network OR NEW.storage_product<>OLD.storage_product OR NEW.gateway_base_url<>OLD.gateway_base_url OR NEW.manifest_tx_id IS DISTINCT FROM OLD.manifest_tx_id OR NEW.verified_cipher_sha256 IS DISTINCT FROM OLD.verified_cipher_sha256 OR NEW.verified_manifest_sha256 IS DISTINCT FROM OLD.verified_manifest_sha256 OR NEW.permanence_verified<>OLD.permanence_verified) THEN RAISE EXCEPTION 'Verified storage bindings are immutable'; END IF;
 IF NEW.verified_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM artifacts a WHERE a.id=NEW.artifact_id AND a.cipher_sha256=NEW.verified_cipher_sha256 AND a.manifest_sha256=NEW.verified_manifest_sha256) THEN RAISE EXCEPTION 'Storage verification must match immutable artifact hashes'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER irys_immutable BEFORE UPDATE OR DELETE ON irys_transactions FOR EACH ROW EXECUTE FUNCTION enforce_irys_immutability();
REVOKE ALL ON FUNCTION enforce_irys_immutability(),enforce_artifact_state(),enforce_preview(),enforce_entitlement(),enforce_citation(),immutable_revision() FROM PUBLIC;
