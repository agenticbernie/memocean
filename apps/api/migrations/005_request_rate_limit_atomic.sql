-- Preserve 004's applied checksum while making the two quota dimensions atomic.
CREATE OR REPLACE FUNCTION memocean_request_limit(th hash32) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 principal record;
 minute timestamptz := date_trunc('minute',now());
 tenant_key text;
 user_key text;
 tenant_lock bigint;
 user_lock bigint;
 tenant_used integer;
 user_used integer;
BEGIN
 SELECT * INTO principal FROM memocean_authenticate(th);
 IF NOT FOUND THEN RETURN false; END IF;

 tenant_key := 'tenant:'||principal.tenant_id::text;
 user_key := 'user:'||principal.user_id::text;
 -- Serialize each quota dimension, including windows whose rows do not exist yet.
 -- Sorting the advisory-lock keys gives all callers the same lock order.
 tenant_lock := hashtextextended(tenant_key,0);
 user_lock := hashtextextended(user_key,0);
 IF tenant_lock < user_lock THEN
  PERFORM pg_advisory_xact_lock(tenant_lock);
  PERFORM pg_advisory_xact_lock(user_lock);
 ELSIF tenant_lock > user_lock THEN
  PERFORM pg_advisory_xact_lock(user_lock);
  PERFORM pg_advisory_xact_lock(tenant_lock);
 ELSE
  PERFORM pg_advisory_xact_lock(tenant_lock);
 END IF;

 SELECT used INTO tenant_used FROM request_rate_windows WHERE rate_key=tenant_key AND window_start=minute FOR UPDATE;
 SELECT used INTO user_used FROM request_rate_windows WHERE rate_key=user_key AND window_start=minute FOR UPDATE;
 IF coalesce(tenant_used,0)>=600 OR coalesce(user_used,0)>=120 THEN RETURN false; END IF;

 INSERT INTO request_rate_windows(rate_key,window_start,used)
 VALUES(tenant_key,minute,1),(user_key,minute,1)
 ON CONFLICT(rate_key,window_start) DO UPDATE SET used=request_rate_windows.used+1;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION memocean_request_limit(hash32) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memocean_request_limit(hash32) TO memocean_request;
