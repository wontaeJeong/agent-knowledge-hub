import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OperationalApi } from "./api";
import { StoragePanel, storageUploadHeaders } from "./storage";
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
it("encodes Korean filenames without choosing a caller space or identity", () => {
  const headers = storageUploadHeaders(
    { kind: "page", id: "topic" },
    { name: "한글.md", type: "" },
  );
  expect(decodeURIComponent(headers["X-Filename"])).toBe("한글.md");
  expect(headers["Content-Type"]).toBe("text/markdown");
  expect(headers).not.toHaveProperty("X-Space-Id");
});
