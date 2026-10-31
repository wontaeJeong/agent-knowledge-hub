import { useState, useEffect, useRef } from "react";
import type { OperationalApi } from "./api";
export type StorageParent = { kind: "source" | "page"; id: string };
export type StorageTransport = (
  path: string,
  init: RequestInit,
) => Promise<Response>;
export function AttachmentPreview({
  preview,
  onClose = () => {},
}: {
  preview: { text: string; complete: boolean; omittedCharacters: number };
  onClose?: () => void;
}) {
  return (
    <details open>
      <summary>
        {preview.complete ? "텍스트 미리보기" : "부분 텍스트 미리보기"}
      </summary>
      <p>
        HTML·스크립트를 실행하지 않는 일반 텍스트입니다.
        {!preview.complete &&
          ` ${preview.omittedCharacters.toLocaleString()}자는 생략했습니다. 전체 원문은 내려받기로 확인하세요.`}
      </p>
      <pre
        tabIndex={0}
        style={{
          maxHeight: "24rem",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {preview.text}
      </pre>
      <button onClick={onClose}>미리보기 닫기</button>
    </details>
  );
}
type Attachment = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  scan_state: string;
  slot_id?: string;
  file_revision?: number;
  head_revision?: number;
  head_id?: string;
  withdrawn?: boolean;
  is_head?: boolean;
};
export function storageUploadHeaders(
  parent: StorageParent,
  file: { name: string; type: string },
  replacement?: { slotId: string; headId: string; revision: number },
) {
  return {
    "X-Parent-Kind": parent.kind,
    "X-Parent-Id": parent.id,
    "X-Filename": encodeURIComponent(file.name),
    "Content-Type":
      file.type ||
      (/\.md$/i.test(file.name)
        ? "text/markdown"
        : /\.txt$/i.test(file.name)
          ? "text/plain"
          : /\.json$/i.test(file.name)
            ? "application/json"
            : /\.pdf$/i.test(file.name)
              ? "application/pdf"
              : "application/octet-stream"),
    ...(replacement
      ? {
          "X-Attachment-Slot": replacement.slotId,
          "X-Expected-Head": replacement.headId,
          "X-Expected-Revision": String(replacement.revision),
        }
      : {}),
  };
}
/** transport is host-owned: inject current selected-space, credentials and CSRF headers. */
export function StoragePanel({
  api,
  parent,
  transport,
  canCreate = false,
  canExport = false,
  onChanged = async () => {},
  baseVersion,
  editorPageId,
}: {
  api: OperationalApi;
  parent: StorageParent;
  transport?: StorageTransport;
  canCreate?: boolean;
  canExport?: boolean;
  onChanged?: () => Promise<void>;
  baseVersion?: number;
  editorPageId?: string;
}) {
  const [items, setItems] = useState<Attachment[]>([]),
    [message, setMessage] = useState("첨부 목록을 조회하세요."),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(0),
    [total, setTotal] = useState(0),
    [importText, setImportText] = useState("");
  const [replacement, setReplacement] = useState<
      { slotId: string; headId: string; revision: number } | undefined
    >(),
    [preview, setPreview] = useState<{
      text: string;
      complete: boolean;
      omittedCharacters: number;
    } | null>(null),
    [reason, setReason] = useState(""),
    [editorBase, setEditorBase] = useState(baseVersion ?? 0),
    [archiveId, setArchiveId] = useState(""),
    [baseVersions, setBaseVersions] = useState("{}"),
    [sourceMap, setSourceMap] = useState("{}");
  const generation = useRef(0);
  const editorPage = parent.kind === "page" ? parent.id : editorPageId;
  useEffect(() => {
    generation.current++;
    setItems([]);
    setTotal(0);
    setPage(0);
    setImportText("");
    setReplacement(undefined);
    setPreview(null);
    setArchiveId("");
    setBaseVersions("{}");
    setSourceMap("{}");
    setReason("");
    setEditorBase(baseVersion ?? 0);
    setMessage("첨부 목록을 조회하세요.");
  }, [api, parent.kind, parent.id, baseVersion, editorPageId]);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }
  async function refresh(offset = 0) {
    const epoch = generation.current;
    const result = await api.post<{ items: Attachment[]; total: number }>(
      "/storage/list",
      { ...parent, offset },
    );
    if (epoch !== generation.current) return;
    setItems(result.items);
    setTotal(result.total);
    setPage(Math.floor(offset / 25));
    setMessage(
      result.items.length
        ? "현재 권한으로 조회했습니다."
        : "등록된 첨부가 없습니다.",
    );
  }
  async function saveFile(path: string, name: string) {
    if (!transport) throw Error("파일 전송 연결이 필요합니다.");
    const res = await transport(path, { method: "GET" });
    if (!res.ok)
      throw Error("현재 권한 또는 검사 상태로 내려받을 수 없습니다.");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="panel" aria-label="첨부 및 가져오기·내보내기">
      <h2>첨부 및 자료 이동</h2>
      <p>
        파일당 최대 5 MiB. 원본은 덮어쓰지 않으며 PDF는 검사 승인 전 내려받을 수
        없습니다. PDF 변환은 지원하지 않습니다.
      </p>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <button disabled={busy} onClick={() => void perform(refresh)}>
        첨부 조회
      </button>
      {canCreate && (
        <div>
          {replacement && (
            <p>
              교체 대상 버전 {replacement.revision} · 새 파일로 교체해도 기존
              원본은 보존됩니다.{" "}
              <button onClick={() => setReplacement(undefined)}>
                교체 취소
              </button>
            </p>
          )}
          <label>
            {replacement ? "선택한 첨부 교체" : "파일 업로드"}{" "}
            <input
              type="file"
              disabled={busy || !transport}
              accept=".txt,.md,.json,.pdf"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void perform(async () => {
                  if (file.size > 5 * 1024 * 1024)
                    throw Error("5 MiB를 초과한 파일입니다.");
                  if (!transport) throw Error("파일 전송 연결이 필요합니다.");
                  const res = await transport("/storage/blobs", {
                    method: "PUT",
                    headers: storageUploadHeaders(parent, file, replacement),
                    body: file,
                  });
                  if (!res.ok)
                    throw Error(
                      "업로드에 실패했습니다. 원본 권한과 파일 형식을 확인하세요.",
                    );
                  setReplacement(undefined);
                  await refresh();
                  await onChanged();
                });
                event.currentTarget.value = "";
              }}
            />
          </label>
          <label>
            검토·철회 사유
            <input
              value={reason}
              maxLength={2000}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {editorPage && (
            <label>
              문서 기준 버전
              <input
                type="number"
                min={1}
                value={editorBase || ""}
                onChange={(event) => setEditorBase(Number(event.target.value))}
              />
            </label>
          )}
        </div>
      )}
      {items.map((item) => (
        <div key={item.id}>
          <strong>{item.filename}</strong> · {item.size.toLocaleString()} bytes
          {item.slot_id && (
            <>
              {" "}
              · 파일 버전 {item.file_revision} ·{" "}
              {item.withdrawn
                ? "철회됨"
                : item.is_head
                  ? "현재 첨부"
                  : "이전 원본"}
            </>
          )}
          ·{" "}
          {item.scan_state === "clean"
            ? "형식 검사 또는 지정 검사 통과"
            : "검사 대기 또는 차단"}{" "}
          <button
            disabled={
              busy ||
              !transport ||
              item.scan_state !== "clean" ||
              item.withdrawn
            }
            onClick={() =>
              void perform(() =>
                saveFile(`/storage/blobs/${item.id}`, item.filename),
              )
            }
          >
            내려받기
          </button>
          {item.slot_id && (
            <button
              disabled={
                busy ||
                item.withdrawn ||
                item.scan_state !== "clean" ||
                !["text/plain", "text/markdown", "application/json"].includes(
                  item.mime,
                )
              }
              onClick={() =>
                void perform(async () => {
                  const result = await api.get<{
                    text: string;
                    complete: boolean;
                    omittedCharacters: number;
                  }>(
                    `/storage/attachments/${item.slot_id}/versions/${item.file_revision}/preview`,
                  );
                  setPreview(result);
                })
              }
            >
              안전한 텍스트 미리보기
            </button>
          )}
          {canCreate && item.slot_id && item.is_head && !item.withdrawn && (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  setReplacement({
                    slotId: item.slot_id!,
                    headId: item.id,
                    revision: item.head_revision!,
                  })
                }
              >
                새 버전으로 교체
              </button>
              {editorPage && (
                <button
                  disabled={
                    busy ||
                    !reason.trim() ||
                    editorBase < 1 ||
                    item.scan_state !== "clean"
                  }
                  onClick={() =>
                    void perform(async () => {
                      const result = await api.post<{ id: string }>(
                        `/storage/attachments/${item.slot_id}/propose-link`,
                        {
                          expectedHead: item.id,
                          ...(parent.kind === "source"
                            ? { pageId: editorPage }
                            : {}),
                          baseVersion: editorBase,
                          reason,
                        },
                      );
                      setMessage(
                        `검토 변경 집합 ${result.id} · 승인 전 발행본은 유지됩니다.`,
                      );
                      await onChanged();
                    })
                  }
                >
                  편집 본문에 첨부 연결 제안
                </button>
              )}
              <details>
                <summary>첨부 철회 확인</summary>
                <p>
                  현재 첨부와 모든 이전 버전의 내려받기·미리보기·기존 링크가
                  차단됩니다. 원본 파일은 보존 정책에 따라 유지합니다.
                </p>
                <button
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    void perform(async () => {
                      await api.post(
                        `/storage/attachments/${item.slot_id}/withdraw`,
                        { expectedRevision: item.head_revision, reason },
                      );
                      setPreview(null);
                      await refresh();
                    })
                  }
                >
                  모든 버전 접근 차단 확인
                </button>
              </details>
            </>
          )}
        </div>
      ))}
      {preview && (
        <AttachmentPreview preview={preview} onClose={() => setPreview(null)} />
      )}
      {total > 25 && (
        <nav aria-label="첨부 페이지">
          <button
            disabled={busy || page === 0}
            onClick={() => void perform(() => refresh((page - 1) * 25))}
          >
            이전
          </button>
          <span>
            {page + 1} / {Math.ceil(total / 25)}
          </span>
          <button
            disabled={busy || (page + 1) * 25 >= total}
            onClick={() => void perform(() => refresh((page + 1) * 25))}
          >
            다음
          </button>
        </nav>
      )}
      {canExport && (
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const manifest = await api.post("/storage/export", {
                pageIds: parent.kind === "page" ? [parent.id] : [],
                sourceIds: parent.kind === "source" ? [parent.id] : [],
              });
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(manifest, null, 2)], {
                  type: "application/json",
                }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "knowledge-export.json";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setMessage("현재 권한과 원본 반출 정책을 확인해 내보냈습니다.");
            })
          }
        >
          근거·버전 포함 내보내기
        </button>
      )}
      {canCreate && (
        <details>
          <summary>검토용 가져오기 제안</summary>
          <p>
            원본 ID·권한·이력을 보존하는 제안입니다. 기존 발행본·권한을
            덮어쓰거나 즉시 발행하지 않습니다.
          </p>
          <label>
            내보내기 JSON
            <textarea
              value={importText}
              maxLength={5 * 1024 * 1024}
              onChange={(event) => setImportText(event.target.value)}
            />
          </label>
          <button
            disabled={busy || !importText.trim()}
            onClick={() =>
              void perform(async () => {
                const result = await api.post<{
                  id: string;
                  duplicate: boolean;
                }>("/storage/import", JSON.parse(importText));
                setArchiveId(result.id);
                setMessage(
                  `${result.duplicate ? "기존 제안" : "검토 제안"} ${result.id}`,
                );
              })
            }
          >
            가져오기 제안 확인
          </button>
          <p>
            가져온 과거 이력은 읽기 전용 보관본입니다. 현재 내용은 아래 기준
            버전으로 별도 검토를 요청합니다. 새 ID는 소유한 개인 공간에서만
            허용하며 팀 공간의 미등록 원본은 거부합니다.
          </p>
          <label>
            검토할 보관본 ID
            <input
              value={archiveId}
              onChange={(event) => setArchiveId(event.target.value)}
              maxLength={100}
            />
          </label>
          <label>
            문서 기준 버전 JSON (새 개인 문서는 0)
            <textarea
              value={baseVersions}
              onChange={(event) => setBaseVersions(event.target.value)}
              maxLength={20000}
            />
          </label>
          <label>
            등록된 원본 정정 매핑 JSON (없으면 빈 객체)
            <textarea
              value={sourceMap}
              onChange={(event) => setSourceMap(event.target.value)}
              maxLength={20000}
            />
          </label>
          <button
            disabled={busy || !archiveId.trim() || !reason.trim()}
            onClick={() =>
              void perform(async () => {
                const result = await api.post<{ id: string; hash: string }>(
                  `/storage/imports/${encodeURIComponent(archiveId)}/propose`,
                  {
                    baseVersions: JSON.parse(baseVersions),
                    sourceMap: JSON.parse(sourceMap),
                    reason,
                  },
                );
                setMessage(
                  `실제 검토 변경 집합 ${result.id} · 발행하지 않았습니다.`,
                );
                await onChanged();
              })
            }
          >
            가져온 현재 내용의 검토 변경 집합 만들기
          </button>
        </details>
      )}
    </section>
  );
}
