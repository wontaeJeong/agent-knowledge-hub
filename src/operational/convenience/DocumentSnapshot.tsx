import { useEffect, useState, useRef } from "react";
import type { AttachmentReader } from "../../ui/Markdown";
import type { OperationalApi } from "../api";
import { DocumentReader, type ReadingSession } from "./DocumentReader";
import type { BlockReference } from "./document-reader";
import { usePersonalKey } from "./personal-client";
import { searchFailure } from "./search-client";
type Props = {
  api: OperationalApi;
  identityKey: string;
  pageId: string;
  version?: number;
  spaceId?: string;
  targetAnchor?: string;
  readAttachment?: AttachmentReader;
};
type Snapshot = {
  pageId: string;
  number: number;
  isCurrentVersion?: boolean;
  content: string;
  currentTitle?: string;
  at: string;
  anchors?: { anchors: BlockReference[] };
  metadata: { known: boolean; snapshot: { title?: string } | null };
};
/** Current and exact published reads share current authorization and stable block navigation. */
export function DocumentSnapshot(props: Props) {
  const key = usePersonalKey(
    props.api,
    JSON.stringify([
      props.identityKey,
      props.spaceId,
      props.pageId,
      props.version,
      props.targetAnchor,
    ]),
  );
  return <SnapshotSession key={key} {...props} />;
}
function SnapshotSession({
  api,
  pageId,
  version,
  spaceId,
  targetAnchor,
  readAttachment,
}: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  const reading = useRef<ReadingSession>({});
  useEffect(() => {
    let generation = 0;
    const read = async (recordVisit = false) => {
      const request = ++generation;
      reading.current.capture?.();
      setSnapshot(null);
      setError("");
      try {
        const value = await api.get<Snapshot>(
          `/versions/pages/${encodeURIComponent(pageId)}/${version ?? "latest"}${recordVisit ? "?visit=1" : ""}`,
        );
        if (
          value.pageId !== pageId ||
          (version !== undefined && value.number !== version)
        )
          throw Error("문서 버전이 일치하지 않습니다. 다시 조회하세요.");
        if (request === generation) setSnapshot(value);
      } catch (e) {
        if (request === generation) {
          reading.current.state = undefined;
          setError(searchFailure(e));
        }
      }
    };
    const refresh = () => void read();
    void read(true);
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 60000);
    return () => {
      generation++;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [api, pageId, version]);
  return (
    <section
      className="op-panel"
      aria-label={version ? "고정 문서 버전" : "최신 문서 버전"}
    >
      <h2>
        {version === undefined && snapshot?.currentTitle
          ? snapshot.currentTitle
          : snapshot?.metadata.known
            ? (snapshot.metadata.snapshot?.title ?? "과거 제목 기록 없음")
            : "과거 제목 기록 없음"}{" "}
        · v{snapshot?.number ?? version ?? "…"}
      </h2>
      <p>
        {snapshot?.isCurrentVersion === true
          ? version
            ? "현재 발행 기록 · 버전 고정 조회"
            : "현재 발행 기록 · 최신 조회"
          : snapshot?.isCurrentVersion === false
            ? "과거 발행 기록 · 현재 권고 아님"
            : "발행 기록 · 버전 고정 조회 (현재 여부 알 수 없음)"}
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : snapshot ? (
        <DocumentReader
          document={{
            id: pageId,
            spaceId,
            content: snapshot.content,
            publishedAt: snapshot.at,
          }}
          version={snapshot.number}
          blocks={snapshot.anchors?.anchors}
          targetAnchor={targetAnchor}
          readAttachment={readAttachment}
          readingSession={reading.current}
        />
      ) : (
        <p role="status">현재 권한으로 발행 버전을 조회합니다.</p>
      )}
    </section>
  );
}
