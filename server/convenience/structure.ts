import { z } from "zod";
import type { Context } from "../service";
import type { WorkflowService } from "../workflows/service";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const structureQuery = z
  .object({
    parentId: id.nullable().default(null),
    cursor: z.string().max(4096).nullable().optional(),
    limit: z.number().int().min(1).max(25).default(25),
  })
  .strict();
export const structureMoveSchema = z
  .object({
    pageId: id,
    parentId: id.nullable(),
    beforeId: id.nullable().default(null),
    expectedRevision: z.number().int().min(0),
    expectedStructureRevision: z.string().max(4096).optional(),
    mutationId: z.string().uuid(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export const duplicateSchema = z
  .object({
    pageId: id,
    version: z.number().int().positive(),
    parentId: id.nullable(),
    mutationId: z.string().uuid(),
  })
  .strict();
export interface StructureNode {
  id: string;
  title: string;
  version: number;
  revision: number;
  hasChildren: boolean;
}
/** All reads/writes share the canonical workflow authorization, gate and transaction. */
export class DocumentStructureService {
  constructor(readonly workflows: WorkflowService) {}
  children(
    ctx: Context,
    input: { parentId?: string | null; cursor?: string | null; limit?: number },
  ) {
    return this.workflows.structureChildren(ctx, input);
  }
  path(ctx: Context, pageId: string) {
    return this.workflows.structurePath(ctx, pageId);
  }
  move(ctx: Context, input: unknown) {
    return this.workflows.moveDocument(ctx, input);
  }
  duplicateToDraft(ctx: Context, input: unknown) {
    return this.workflows.duplicateDocument(ctx, input);
  }
}
