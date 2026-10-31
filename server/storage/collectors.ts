import { z } from "zod";
import { inspectContent, sha256, MAX_BYTES } from "./content";
const event = z
  .object({
    data: z
      .object({
        id: z.string().regex(/^msg_[a-zA-Z0-9]+$/),
        sessionID: z.string().regex(/^ses_[a-zA-Z0-9]+$/),
        time: z.object({ created: z.number().int().positive() }).strict(),
        type: z.literal("synthetic"),
        payload: z
          .object({
            text: z.string().min(1).max(100000),
            description: z.string().max(1000).optional(),
          })
          .strict(),
        delivery: z.enum(["steer", "queue"]).optional(),
      })
      .strict(),
  })
  .strict();
export const collectorSupport = [
  {
    tool: "opencode",
    version: "2.2.2",
    format: "api.synthetic-message",
    fixture: "opencode-2.2.2-synthetic.json",
    installationApproved: false,
    coverage:
      "selected synthetic text events only; no hidden reasoning, tools, credentials, or automatic directory scan",
  },
  {
    tool: "opencode",
    version: "2.2.2",
    format: "api.assistant-message",
    fixture: "opencode-2.2.2-assistant.json",
    installationApproved: false,
    coverage:
      "completed selected assistant text and explicitly selected completed tool text outputs; reasoning, native provider data, tool inputs, snapshots, and unselected outputs excluded",
  },
] as const;
const timestamp = z.number().int().positive().max(8640000000000000);
const timing = z
  .object({
    created: timestamp,
    ran: timestamp.optional(),
    streamed: timestamp.optional(),
    completed: timestamp.optional(),
  })
  .strict();
const textPart = z
  .object({
    type: z.literal("text"),
    text: z.string().max(100000),
    native: z.unknown().optional(),
  })
  .strict();
const reasoningPart = z
  .object({
    type: z.literal("reasoning"),
    text: z.string(),
    native: z.unknown().optional(),
    time: timing.optional(),
  })
  .strict();
const toolPart = z
  .object({
    type: z.literal("tool"),
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    executed: z.boolean().optional(),
    native: z.unknown().optional(),
    time: timing,
    state: z
      .object({
        status: z.enum(["streaming", "running", "completed", "error"]),
        input: z.unknown().optional(),
        content: z.array(z.unknown()).max(1000).optional(),
        metadata: z.unknown().optional(),
        error: z.unknown().optional(),
        rawInput: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
const assistantEvent = z
  .object({
    data: z
      .object({
        id: z.string().regex(/^msg_[a-zA-Z0-9]+$/),
        time: timing,
        type: z.literal("assistant"),
        agent: z.string(),
        model: z
          .object({
            id: z.string(),
            providerID: z.string(),
            variant: z.string().optional(),
          })
          .strict(),
        content: z
          .array(
            z.discriminatedUnion("type", [textPart, reasoningPart, toolPart]),
          )
          .max(1000),
        metadata: z.unknown().optional(),
        snapshot: z.unknown().optional(),
        finish: z.string().optional(),
        rawFinish: z.string().optional(),
        native: z.unknown().optional(),
        cost: z.number().optional(),
        tokens: z.unknown().optional(),
        error: z.unknown().optional(),
        retry: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
/** Explicit selected API artifact, not a filesystem crawler or tool execution grant. */
export function collectArtifact(
  input: unknown,
  options: {
    tool: string;
    version: string;
    format: string;
    selectedIds: string[];
    excludedSessionIds: string[];
    sessionId?: string;
    selectedToolIds?: string[];
  },
) {
  if (
    options.tool !== "opencode" ||
    options.version !== "2.2.2" ||
    !["api.synthetic-message", "api.assistant-message"].includes(options.format)
  )
    throw Error("UNSUPPORTED_COLLECTOR_VERSION");
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES)
    throw Error("PAYLOAD_TOO_LARGE");
  if (options.format === "api.assistant-message") {
    const { data: d } = assistantEvent.parse(input);
    const sessionId = z
      .string()
      .regex(/^ses_[a-zA-Z0-9]+$/)
      .parse(options.sessionId);
    if (
      !options.selectedIds.includes(d.id) ||
      options.excludedSessionIds.includes(sessionId)
    )
      throw Error("COLLECTION_EXCLUDED");
    if (
      !d.time.completed ||
      d.error ||
      d.finish === "error" ||
      d.finish === "length"
    )
      throw Error("ARTIFACT_INCOMPLETE");
    const omitted = {
      reasoning: 0,
      toolInputs: 0,
      native: 0,
      unselectedToolOutputs: 0,
      pendingToolOutputs: 0,
      nonText: 0,
    };
    const texts: string[] = [];
    let tools = 0,
      statements = 0;
    const seenTools = new Set<string>();
    for (const part of d.content) {
      if (part.native) omitted.native++;
      if (part.type === "reasoning") {
        omitted.reasoning++;
        continue;
      }
      if (part.type === "text") {
        texts.push(part.text);
        statements++;
        continue;
      }
      if (seenTools.has(part.id)) throw Error("DUPLICATE_TOOL_EVENT");
      seenTools.add(part.id);
      if (part.state.input !== undefined) omitted.toolInputs++;
      if (!options.selectedToolIds?.includes(part.id)) {
        omitted.unselectedToolOutputs++;
        continue;
      }
      if (part.state.status !== "completed") {
        omitted.pendingToolOutputs++;
        continue;
      }
      const output: string[] = [];
      for (const raw of part.state.content ?? []) {
        const text = textPart.safeParse(raw);
        if (text.success) output.push(text.data.text);
        else omitted.nonText++;
      }
      if (output.length) {
        texts.push(
          `## Tool output (unverified): ${part.name}\n${output.join("\n")}`,
        );
        tools++;
      }
    }
    if (options.selectedToolIds?.some((toolId) => !seenTools.has(toolId)))
      throw Error("SELECTED_ARTIFACT_NOT_FOUND");
    if (!texts.some((text) => text.trim())) throw Error("NO_SELECTED_TEXT");
    const content = texts.join("\n\n");
    if (content.length > 100000) throw Error("PAYLOAD_TOO_LARGE");
    const bytes = Buffer.from(content);
    inspectContent(bytes, "text/plain", "artifact.txt");
    // Changing explicit selection changes the immutable event identity, not an old source version.
    const selection = sha256(
      JSON.stringify([...new Set(options.selectedToolIds ?? [])].sort()),
    ).slice(0, 16);
    return {
      externalId: `${d.id}-${selection}`,
      sessionId,
      version: d.time.completed,
      sha256: sha256(bytes),
      content,
      tool: "opencode",
      toolVersion: "2.2.2",
      kind: tools
        ? statements
          ? "mixed-artifact"
          : "tool-output"
        : "author-statement",
      verification: "unverified",
      occurredAt: new Date(d.time.created).toISOString(),
      filename: "artifact.txt",
      mime: "text/plain",
      bytes,
      omitted,
    };
  }
  const { data: d } = event.parse(input);
  if (
    !options.selectedIds.includes(d.id) ||
    options.excludedSessionIds.includes(d.sessionID)
  )
    throw Error("COLLECTION_EXCLUDED");
  const bytes = Buffer.from(d.payload.text);
  inspectContent(bytes, "text/plain", "artifact.txt");
  return {
    externalId: d.id,
    sessionId: d.sessionID,
    version: d.time.created,
    sha256: sha256(bytes),
    content: d.payload.text,
    tool: "opencode",
    toolVersion: "2.2.2",
    kind: "author-statement",
    verification: "unverified",
    occurredAt: new Date(d.time.created).toISOString(),
    filename: "artifact.txt",
    mime: "text/plain",
    bytes,
    omitted: {
      reasoning: 0,
      toolInputs: 0,
      native: 0,
      unselectedToolOutputs: 0,
      pendingToolOutputs: 0,
      nonText: 0,
    },
  };
}
