import { parseImport, type ParserFile } from "./parser";
import type { ImportSelection } from "../../src/domain/imports";
process.once(
  "message",
  async (input: { files: ParserFile[]; selection: ImportSelection }) => {
    try {
      const result = await parseImport(input.files, input.selection);
      process.send?.({ ok: true, result }, () => process.disconnect?.());
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : "PARSER_FAILED";
      process.send?.({ ok: false, code }, () => process.disconnect?.());
    }
  },
);
