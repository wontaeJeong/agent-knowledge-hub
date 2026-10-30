import type { WorkflowAuthorizer } from "../workflows/service";
/** Explicit administrative METADATA export policy, not fallback authorization or raw-source export.
 * Must be opted into by trusted host configuration. Base authorization failures are never caught.
 */
export function operationsAuthorizer(
  base: WorkflowAuthorizer,
  policy: { adminAuditMetadataExport: boolean },
): WorkflowAuthorizer {
  if (typeof base !== "function") throw Error("AUTHORIZER_REQUIRED");
  return async (db, ctx, action, resource) => {
    if (action === "data.export" && !resource) {
      if (!policy.adminAuditMetadataExport)
        throw Error("ADMIN_AUDIT_EXPORT_POLICY_DISABLED");
      await base(db, ctx, "space.admin");
      return;
    }
    await base(db, ctx, action, resource);
  };
}
