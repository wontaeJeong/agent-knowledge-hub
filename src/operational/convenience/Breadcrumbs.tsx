import { useEffect, useState } from "react";
import { documentHref, type OperationalApi } from "../api";
import { usePersonalKey } from "./personal-client";
import type { StructureNode } from "./PageTree";
export function Breadcrumbs(props: {
  api: OperationalApi;
  spaceId: string;
  principalId: string;
  pageId: string;
  refreshKey?: string;
  onSelect?: (id: string) => boolean | void;
}) {
  const key = usePersonalKey(
    props.api,
    `${props.spaceId}:${props.principalId}:${props.pageId}:${props.refreshKey ?? ""}`,
  );
  return <Path key={key} {...props} />;
}
function Path({
  api,
  spaceId,
  pageId,
  onSelect,
}: {
  api: OperationalApi;
  spaceId: string;
  pageId: string;
  onSelect?: (id: string) => boolean | void;
}) {
  const [items, setItems] = useState<StructureNode[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void api
      .get<{ items: StructureNode[] }>(`/convenience/pages/${pageId}/path`)
      .then((x) => {
        if (live) setItems(x.items);
      })
      .catch(() => {
        if (live) {
          setItems([]);
          setError("문서 경로를 확인할 수 없습니다.");
        }
      });
    return () => {
      live = false;
    };
  }, [api, pageId]);
  return (
    <nav className="document-breadcrumbs" aria-label="문서 경로">
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <ol>
          {items.map((item, index) => (
            <li key={item.id}>
              <a
                href={documentHref(spaceId, item.id)}
                aria-current={index === items.length - 1 ? "page" : undefined}
                onClick={(e) => {
                  if (
                    onSelect &&
                    !e.ctrlKey &&
                    !e.metaKey &&
                    !e.shiftKey &&
                    !e.altKey
                  ) {
                    e.preventDefault();
                    onSelect(item.id);
                  }
                }}
              >
                {item.title}
              </a>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
