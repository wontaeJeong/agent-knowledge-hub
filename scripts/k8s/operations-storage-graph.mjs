/** Every durable CAS reference, including private staged imports and old immutable attachment versions.
 * Keep aligned with fixed storage migrations021/027. Withdrawal is NOT legal deletion.
 */
const graph = `WITH refs AS (
 SELECT b.workspace_id,'resource'::text AS owner_kind,b.parent_kind,b.parent_id AS owner_id,b.sha256,b.size FROM storage_blobs b
 UNION ALL SELECT s.workspace_id,'resource',s.parent_kind,s.parent_id,b.sha256,b.size FROM storage_attachment_slots s JOIN storage_blobs b ON b.workspace_id=s.workspace_id AND b.id=s.head_id
 UNION ALL SELECT s.workspace_id,'resource',s.parent_kind,s.parent_id,b.sha256,b.size FROM storage_attachment_versions v JOIN storage_attachment_slots s ON s.workspace_id=v.workspace_id AND s.id=v.slot_id JOIN storage_blobs b ON b.workspace_id=v.workspace_id AND b.id=v.blob_id
 UNION ALL SELECT l.workspace_id,'resource','page',l.page_id,b.sha256,b.size FROM storage_attachment_links l JOIN storage_blobs b ON b.workspace_id=l.workspace_id AND b.id=l.blob_id
 UNION ALL SELECT s.workspace_id,'resource','source',s.source_id,b.sha256,b.size FROM storage_snapshots s JOIN storage_blobs b ON b.workspace_id=s.workspace_id AND b.id=s.blob_id
 UNION ALL SELECT i.workspace_id,'import','import',i.id,p.value->>'sha256',(p.value->>'size')::integer FROM storage_imports i CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.manifest->'stagedBlobs')='array' THEN i.manifest->'stagedBlobs' ELSE '[]'::jsonb END) p WHERE p.value->>'sha256' ~ '^[a-f0-9]{64}$' AND p.value->>'size' ~ '^[0-9]{1,8}$'
 UNION ALL SELECT e.workspace_id,'import','import',e.import_id,b.sha256,b.size FROM storage_import_effects e CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(e.result->'blobMap')='object' THEN e.result->'blobMap' ELSE '{}'::jsonb END) m JOIN storage_blobs b ON b.workspace_id=e.workspace_id AND b.id=m.value
 UNION ALL SELECT e.workspace_id,'import','import',e.import_id,b.sha256,b.size FROM storage_import_effects e CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(e.result->'slotMap')='object' THEN e.result->'slotMap' ELSE '{}'::jsonb END) m JOIN storage_attachment_versions v ON v.workspace_id=e.workspace_id AND v.slot_id=m.value JOIN storage_blobs b ON b.workspace_id=v.workspace_id AND b.id=v.blob_id
), live AS (SELECT r.* FROM refs r WHERE
 EXISTS(SELECT 1 FROM operations_legal_holds h WHERE h.workspace_id=r.workspace_id AND h.active AND (h.resource_kind='workspace' OR r.owner_kind='import' OR h.resource_kind=r.parent_kind AND h.resource_id=r.owner_id))
 OR (r.owner_kind='resource' AND NOT EXISTS(SELECT 1 FROM operations_tombstones t WHERE t.workspace_id=r.workspace_id AND t.resource_kind=r.parent_kind AND t.resource_id=r.owner_id AND t.delete_content AND t.blob_hashes ? r.sha256))
 OR (r.owner_kind='import' AND NOT EXISTS(SELECT 1 FROM operations_erased_artifacts e WHERE e.workspace_id=r.workspace_id AND e.artifact_kind='import' AND e.artifact_id=r.owner_id AND e.hashes ? r.sha256)))`;
export async function allContentReferences(db) {
  const rows = (
    await db.query(
      `${graph} SELECT * FROM refs ORDER BY workspace_id,owner_kind,parent_kind,owner_id,sha256 LIMIT 100001`,
    )
  ).rows;
  if (rows.length > 100000) throw Error("CONTENT_REFERENCE_GRAPH_BOUND");
  return rows;
}
export async function backupReferenceRows(db) {
  const rows = (
    await db.query(
      `${graph} SELECT DISTINCT sha256,size FROM live ORDER BY sha256 LIMIT 100001`,
    )
  ).rows;
  if (rows.length > 100000) throw Error("MANIFEST_REFERENCE_BOUND");
  return rows;
}
export async function hashHasLiveReference(db, sha256) {
  return !!(
    await db.query(`${graph} SELECT 1 FROM live WHERE sha256=$1 LIMIT 1`, [
      sha256,
    ])
  ).rowCount;
}
