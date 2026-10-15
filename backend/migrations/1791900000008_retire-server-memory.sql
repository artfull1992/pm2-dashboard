-- Up Migration
-- ADR-023: host monitoring belongs to Zabbix; the server_memory alert rule is taken out of service. Forward-only and
-- compatible with the previous release (it never writes 'retired' and ignores the closed rows' resolution value).
-- Nothing is dropped: the rule stays a valid value of alert_incidents.rule / alert_conditions.rule so its history
-- remains readable, and alert_settings.memory_* stay (NOT NULL, inactive) — no destructive schema change.
-- Objects are unqualified: the runner sets search_path (public in production, a per-run schema in tests).

-- 1. A resolution that says "the rule was retired" — never a fake "recovered".
ALTER TABLE alert_incidents DROP CONSTRAINT alert_incidents_resolution;
ALTER TABLE alert_incidents ADD CONSTRAINT alert_incidents_resolution CHECK ((status = 'resolved') = (resolution IS NOT NULL AND resolved_at IS NOT NULL)
  AND (resolution IS NULL OR resolution IN ('recovered', 'process_gone', 'excluded', 'retired')));

-- 2. Close open server_memory incidents as retired (no recovery notification is created).
UPDATE alert_incidents SET status = 'resolved', resolution = 'retired', resolved_at = now(), last_observed_at = GREATEST(last_observed_at, now())
 WHERE rule = 'server_memory' AND status = 'firing';

-- 3. Cancel their notifications that are not being delivered right now. A row leased by the running (old) worker
--    finishes normally; the new API cancels it if it comes back to the queue or its lease expires.
UPDATE alert_outbox o SET status = 'cancelled', finished_at = now(), lease_until = NULL, last_error = 'rule_retired'
  FROM alert_incidents i
 WHERE i.id = o.incident_id AND i.rule = 'server_memory'
   AND (o.status = 'queued' OR (o.status = 'sending' AND o.lease_until < now()));

-- 4. Drop the evaluation state of the retired rule (debounce counters only; incidents and audit stay).
DELETE FROM alert_conditions WHERE rule = 'server_memory';
