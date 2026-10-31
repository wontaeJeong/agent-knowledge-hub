import { useState } from "react";
import { Badge, Button } from "../ui/primitives";
import { ConsoleTable } from "./ConsoleTable";

export const previewRecords = (text: string) =>
  text
    .split("\n")
    .flatMap((text, i) =>
      text.trim() ? [{ line: i + 1, text, kind: "원문 진술 · 검증 전" }] : [],
    );
export function ImportPreview({
  register,
}: {
  register: (title: string, text: string) => Promise<void>;
}) {
  const [text, setText] = useState(""),
    [title, setTitle] = useState("합성 대화 자료"),
    [reviewed, setReviewed] = useState(false),
    [ack, setAck] = useState(false),
    [error, setError] = useState("");
  const records = previewRecords(text);
  return (
    <>
      <section className="op-panel">
        <div className="op-section-head">
          <h2>자료 넣기 · 선택 범위 확인</h2>
          <Badge tone="plum">실제 파일 업로드·모델 정리 없음</Badge>
        </div>
        <p>
          실제 앱의 TXT/Markdown·JSON/CSV·Slack/카카오 지원 입력과 영속 정리
          작업은 서버 경로에서 제공합니다. 여기서는 붙여넣은 합성 입력의 줄과
          원본 등록 흐름만 시연합니다. 자연어 의미 분석을 하지 않습니다.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setReviewed(true);
            setAck(false);
          }}
        >
          <label>
            자료 제목
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
            />
          </label>
          <label>
            붙여넣기 · 합성 원문
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setReviewed(false);
                setAck(false);
              }}
              required
              maxLength={10000}
              rows={8}
              placeholder="[2026-10-30 09:00] 개발자: 제안과 실행 결과를 구분해야 합니다."
            />
          </label>
          <div className="op-actions">
            <Button type="submit" variant="primary">
              입력 구조 미리보기
            </Button>
            <Button
              type="button"
              onClick={() => {
                setText(
                  "[2026-10-30 09:00] 개발자: Ubuntu 이미지에는 승인된 루트 CA를 추가하자.\n[2026-10-30 09:10] 에이전트: 배포를 완료했다고 보고합니다.\n[2026-10-30 09:20] 검토자: 실행 증거는 아직 없으므로 별도 확인이 필요합니다.",
                );
                setReviewed(false);
                setAck(false);
              }}
            >
              합성 대화 채우기
            </Button>
          </div>
        </form>
      </section>
      {reviewed && (
        <section className="op-panel">
          <h2>선택 원문 · 줄 위치와 한계</h2>
          <p>
            빈 줄을 제외한 {records.length}개 원문 진술입니다. 완료 주장도 실행
            증거로 승격하지 않습니다. 날짜/작성자 자동 해석·누락 탐지·모델
            종합은 이 간단 목업에 없습니다.
          </p>
          <ConsoleTable
            caption="붙여넣기 원문 확인"
            columns={["줄", "원문", "근거 상태"]}
            rows={records.map((r) => ({
              id: String(r.line),
              search: `${r.line} · ${r.text}`,
              cells: [String(r.line), r.text, r.kind],
            }))}
          />
          <label className="op-check">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>
              선택 입력과 한계를 확인했습니다. 실제 업로드·공개 결정·모델 처리
              없이 목업 원본에만 등록합니다.
            </span>
          </label>
          {error && <p role="alert">{error}</p>}
          <Button
            variant="primary"
            disabled={!ack || !records.length}
            onClick={() => {
              void register(title, text).catch((e) =>
                setError(e instanceof Error ? e.message : "목업 등록 실패"),
              );
            }}
          >
            목업 원본 등록 · 편입 화면으로
          </Button>
        </section>
      )}
    </>
  );
}
