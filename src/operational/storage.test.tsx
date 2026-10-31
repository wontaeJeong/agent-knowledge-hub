import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OperationalApi } from "./api";
import {
  StoragePanel,
  storageUploadHeaders,
  AttachmentPreview,
} from "./storage";
it("explains real limits, scanning, and non-publication import contract", () => {
  const html = renderToStaticMarkup(
    <StoragePanel
      api={new OperationalApi()}
      parent={{ kind: "source", id: "source-a" }}
      canCreate
      canExport
    />,
  );
  expect(html).toContain("5 MiB");
  expect(html).toContain("검사 승인 전");
  expect(html).toContain("즉시 발행하지 않습니다");
  expect(html).toContain("원본 ID·권한·이력");
  expect(html).not.toContain("공개 링크");
});
it("replacement headers carry exact head CAS and preview escapes HTML as inert text", () => {
  const headers = storageUploadHeaders(
    { kind: "page", id: "topic" },
    { name: "한글.txt", type: "" },
    { slotId: "slot", headId: "old-head", revision: 2 },
  );
  expect(headers["X-Attachment-Slot"]).toBe("slot");
  expect(headers["X-Expected-Head"]).toBe("old-head");
  expect(headers["X-Expected-Revision"]).toBe("2");
  expect(headers["Content-Type"]).toBe("text/plain");
  const html = renderToStaticMarkup(
    <AttachmentPreview
      preview={{
        text: "<script>alert(1)</script>",
        complete: false,
        omittedCharacters: 50,
      }}
    />,
  );
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("부분 텍스트 미리보기");
  expect(html).toContain("50자는 생략");
});
it("encodes Korean filenames without choosing a caller space or identity", () => {
  const headers = storageUploadHeaders(
    { kind: "page", id: "topic" },
    { name: "한글.md", type: "" },
  );
  expect(decodeURIComponent(headers["X-Filename"])).toBe("한글.md");
  expect(headers["Content-Type"]).toBe("text/markdown");
  expect(headers).not.toHaveProperty("X-Space-Id");
});
