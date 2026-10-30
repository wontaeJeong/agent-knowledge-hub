import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportPreview, previewRecords } from "./ImportPreview";

test("input preview preserves raw text but never turns completion claims into evidence", () => {
  const records = previewRecords(
    "제안: 별도 저장소 사용\n\n완료: 배포 성공\n질문: 버전 차이는?",
  );
  expect(records).toEqual([
    { line: 1, text: "제안: 별도 저장소 사용", kind: "원문 진술 · 검증 전" },
    { line: 3, text: "완료: 배포 성공", kind: "원문 진술 · 검증 전" },
    { line: 4, text: "질문: 버전 차이는?", kind: "원문 진술 · 검증 전" },
  ]);
});
test("import preview requires explicit input and does not call live APIs", () => {
  const network = vi.spyOn(globalThis, "fetch");
  try {
    const html = renderToStaticMarkup(
      <ImportPreview register={async () => {}} />,
    );
    expect(html).toContain("실제 파일 업로드·모델 정리 없음");
    expect(html).toContain("붙여넣기");
    expect(html).toContain("required");
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
