import { useState, useEffect, useRef } from "react";
import type { OperationalApi } from "./api";
export type StorageParent = { kind: "source" | "page"; id: string };
export type StorageTransport = (
  path: string,
  init: RequestInit,
) => Promise<Response>;
type Attachment = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  scan_state: string;
};
export function storageUploadHeaders(
  parent: StorageParent,
  file: { name: string; type: string },
) {
  return {
    "X-Parent-Kind": parent.kind,
    "X-Parent-Id": parent.id,
    "X-Filename": encodeURIComponent(file.name),
    "Content-Type":
      file.type ||
      (/\.md$/i.test(file.name) ? "text/markdown" : "application/octet-stream"),
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
}: {
  api: OperationalApi;
  parent: StorageParent;
  transport?: StorageTransport;
  canCreate?: boolean;
  canExport?: boolean;
  onChanged?: () => Promise<void>;
}) {
  const [items, setItems] = useState<Attachment[]>([]),
    [message, setMessage] = useState("첨부 목록을 조회하세요."),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(0),
    [total, setTotal] = useState(0),
    [importText, setImportText] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setItems([]);
    setTotal(0);
    setPage(0);
    setImportText("");
    setMessage("첨부 목록을 조회하세요.");
  }, [api, parent.kind, parent.id]);
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
        <label>
          파일 업로드{" "}
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
                  headers: storageUploadHeaders(parent, file),
                  body: file,
                });
                if (!res.ok)
                  throw Error(
                    "업로드에 실패했습니다. 원본 권한과 파일 형식을 확인하세요.",
                  );
                await refresh();
                await onChanged();
              });
              event.currentTarget.value = "";
            }}
          />
        </label>
      )}
      {items.map((item) => (
        <div key={item.id}>
          <strong>{item.filename}</strong> · {item.size.toLocaleString()} bytes
          ·{" "}
          {item.scan_state === "clean"
            ? "형식 검사 또는 지정 검사 통과"
            : "검사 대기 또는 차단"}{" "}
          <button
            disabled={busy || !transport || item.scan_state !== "clean"}
            onClick={() =>
              void perform(() =>
                saveFile(`/storage/blobs/${item.id}`, item.filename),
              )
            }
          >
            내려받기
          </button>
        </div>
      ))}
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
                setMessage(
                  `${result.duplicate ? "기존 제안" : "검토 제안"} ${result.id}`,
                );
              })
            }
          >
            가져오기 제안 확인
          </button>
        </details>
      )}
    </section>
  );
}
