-- Recover conservative provenance for versions published before input envelopes existed.
-- Publications retain batch input snapshots and contextDependencyIds, even when a model omitted links.
WITH recovered AS (
 SELECT v.workspace_id,v.page_id,v.number,
  (SELECT coalesce(jsonb_agg(source_id ORDER BY source_id),'[]'::jsonb)
   FROM (
    SELECT jsonb_array_elements_text(coalesce(v.data->'sourceIds','[]')) AS source_id
    UNION SELECT s->>'id' FROM jsonb_array_elements(coalesce(b.data->'snapshots','[]')) s
    UNION SELECT jsonb_array_elements_text(coalesce(v.data#>'{provenance,sourceIds}','[]'))
   ) ids) AS source_ids,
  (SELECT coalesce(jsonb_agg(dependency_id ORDER BY dependency_id),'[]'::jsonb)
   FROM (
    SELECT jsonb_array_elements_text(coalesce(b.data->'contextDependencyIds','[]')) AS dependency_id
    UNION SELECT jsonb_array_elements_text(coalesce(v.data#>'{provenance,pageIds}','[]'))
   ) ids WHERE dependency_id<>v.page_id) AS page_ids
 FROM versions v
 JOIN publications p ON p.workspace_id=v.workspace_id
  AND (p.result->'versions'->>v.page_id)::integer=v.number
 JOIN batches b ON b.workspace_id=p.workspace_id AND b.id=p.batch_id
)
UPDATE versions v SET data=jsonb_set(jsonb_set(v.data,'{sourceIds}',r.source_ids),'{provenance}',jsonb_build_object('sourceIds',r.source_ids,'pageIds',r.page_ids))
FROM recovered r WHERE v.workspace_id=r.workspace_id AND v.page_id=r.page_id AND v.number=r.number;

-- Unreviewed pre-envelope model results cannot prove complete influencing inputs.
-- Require a new run instead of certifying those unsafe candidates after upgrade.
UPDATE batches SET data=jsonb_set(data,'{status}','"conflict"')
 WHERE data->>'mode'='model' AND data->>'status' IN ('pending','approved')
 AND NOT data ? 'inputEnvelope';
DELETE FROM approvals a USING batches b
 WHERE a.workspace_id=b.workspace_id AND a.batch_id=b.id
 AND b.data->>'mode'='model' AND b.data->>'status'='conflict';
