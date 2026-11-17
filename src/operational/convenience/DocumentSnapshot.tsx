import { useEffect, useState } from "react";
import type { AttachmentReader } from "../../ui/Markdown";
import type { OperationalApi } from "../api";
import { DocumentBody } from "../document-navigation";
import { usePersonalKey } from "./personal-client";
import { searchFailure } from "./search-client";
type Props = {
  api: OperationalApi;
  identityKey: string;
  pageId: string;
  version: number;
  readAttachment?: AttachmentReader;
};
type Snapshot = {
  pageId: string;
  number: number;
  isCurrentVersion?: boolean;
  content: string;
  at: string;
  metadata: { known: boolean; snapshot: { title?: string } | null };
};
/** Exact published version route; reusable by future stable paragraph navigation. */
export function DocumentSnapshot(props: Props) {
  const key = usePersonalKey(
    props.api,
    `${props.identityKey}:${props.pageId}:${props.version}`,
  );
  return <SnapshotSession key={key} {...props} />;
}
function SnapshotSession({ api, pageId, version, readAttachment }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let generation = 0;
    const read = async (recordVisit = false) => {
      const request = ++generation;
      setSnapshot(null);
      setError("");
      try {
        const value = await api.get<Snapshot>(
          `/versions/pages/${encodeURIComponent(pageId)}/${version}${recordVisit ? "?visit=1" : ""}`,
        );
        if (value.pageId !== pageId || value.number !== version)
          throw Error("문서 버전이 일치하지 않습니다. 다시 조회하세요.");
        if (request === generation) setSnapshot(value);
      } catch (e) {
        if (request === generation) setError(searchFailure(e));
      }
    };
    const refresh = () => void read();
    void read(true);
    window.addEventListener("focus", refresh);
    return () => {
      generation++;
      window.removeEventListener("focus", refresh);
    };
  }, [api, pageId, version]);
  return (
    <section className="op-panel" aria-label="고정 문서 버전">
      <h2>
        {snapshot?.metadata.known
          ? (snapshot.metadata.snapshot?.title ?? "과거 제목 기록 없음")
          : "과거 제목 기록 없음"}{" "}
        · v{version}
      </h2>
      <p>
        {snapshot?.isCurrentVersion === true
          ? "현재 발행 기록 · 버전 고정 조회"
          : snapshot?.isCurrentVersion === false
            ? "과거 발행 기록 · 현재 권고 아님"
            : "발행 기록 · 버전 고정 조회 (현재 여부 알 수 없음)"}
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : snapshot ? (
        <DocumentBody
          content={snapshot.content}
          readAttachment={readAttachment}
        />
      ) : (
        <p role="status">고정 버전을 조회합니다.</p>
      )}
    </section>
  );
}
