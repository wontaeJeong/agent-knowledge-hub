import { useEffect, useRef, useState, useId } from "react";
import { Markdown, type AttachmentReader } from "../../ui/Markdown";
import { Button } from "../../ui/primitives";
import { convenienceHref } from "./route";
import {
  buildDocumentOutline,
  blockForElement,
  searchableText,
  matchLimit,
  type BlockReference,
} from "./document-reader";
export type ReaderProps = {
  document: {
    content: string;
    id?: string;
    spaceId?: string;
    publishedAt?: string;
  };
  version?: number;
  blocks?: BlockReference[];
  targetAnchor?: string;
  readAttachment?: AttachmentReader;
};
const emptyBlocks: BlockReference[] = [];
export function DocumentReader({
  document: doc,
  version,
  blocks = emptyBlocks,
  targetAnchor,
  readAttachment,
}: ReaderProps) {
  const content = doc.content;
  const [shareBlock, setShareBlock] = useState<string | null>(null);
  const [copyResult, setCopyResult] = useState<{
    status: string;
    fallback?: string;
  } | null>(null);
  const [anchorMissing, setAnchorMissing] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setShareBlock(null);
    setCopyResult(null);
    return () => {
      generation.current++;
    };
  }, [content, doc.id, doc.spaceId, version, blocks]);
  const copy = async (value: string) => {
    const current = generation.current;
    try {
      await navigator.clipboard.writeText(value);
      if (current === generation.current)
        setCopyResult({ status: "복사했습니다." });
    } catch {
      if (current === generation.current)
        setCopyResult({
          status: "복사하지 못했습니다. 아래 내용을 선택해 직접 복사하세요.",
          fallback: value,
        });
    }
  };
  const href = (fixed: boolean, anchor?: string) =>
    new URL(
      convenienceHref({
        kind: "document",
        spaceId: doc.spaceId!,
        document: doc.id!,
        ...(fixed && version ? { version } : {}),
        ...(anchor ? { anchor } : {}),
      }),
      window.location.origin,
    ).href;

  const body = useRef<HTMLDivElement>(null);
  const readerId = useId().replaceAll(":", "");
  const [outline, setOutline] = useState<
    { id: string; title: string; level: number }[]
  >([]);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0),
    [position, setPosition] = useState(0);
  const jump = (target: HTMLElement) => {
    target.scrollIntoView?.({ block: "center" });
    target.focus({ preventScroll: true });
  };
  useEffect(() => {
    const element = body.current!;
    for (const old of element.querySelectorAll("[data-reader-control]"))
      old.remove();
    for (const wrapper of element.querySelectorAll<HTMLElement>(
      "[data-document-start]",
    )) {
      wrapper.removeAttribute("data-block-id");
      wrapper.removeAttribute("tabindex");
      const block = blockForElement(wrapper, blocks);
      if (block) {
        wrapper.dataset.blockId = block.id;
        wrapper.tabIndex = -1;
      }
      if (block && doc.id && doc.spaceId) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "부분 링크";
        button.dataset.readerControl = "true";
        button.dataset.blockShare = block.id;
        button.className = "reader-block-link";
        button.onclick = () => {
          setShareBlock(block.id);
          setCopyResult(null);
        };
        wrapper.append(button);
      }
    }
    for (const pre of element.querySelectorAll<HTMLElement>("pre")) {
      const value = pre.querySelector("code")?.textContent ?? "";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "코드 복사";
      button.dataset.readerControl = "true";
      button.onclick = () => void copy(value.replace(/\n$/, ""));
      pre.after(button);
    }
    const target = targetAnchor
      ? Array.from(
          element.querySelectorAll<HTMLElement>("[data-block-id]"),
        ).find((el) => el.dataset.blockId === targetAnchor)
      : undefined;
    setAnchorMissing(!!targetAnchor && !target);
    if (target) jump(target);
  }, [content, blocks, doc.id, doc.spaceId, version, targetAnchor]);
  useEffect(() => {
    const element = body.current!;
    // Decorate the canonical safe renderer without replacing its event-bound DOM.
    for (const mark of element.querySelectorAll("mark[data-match]")) {
      const parent = mark.parentNode!;
      mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
      parent.normalize();
    }
    const headings = Array.from(
      element.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"),
    ).slice(0, 1000);
    const outlineModel = buildDocumentOutline(content, blocks, element);
    setOutline(
      headings.map((heading, i) => {
        heading.id = `${readerId}-document-section-${i}`;
        heading.tabIndex = -1;
        return {
          id: heading.id,
          title: outlineModel[i]?.title ?? heading.textContent ?? "",
          level: outlineModel[i]?.level ?? Number(heading.tagName[1]),
        };
      }),
    );
    const needle = query.trim().toLocaleLowerCase();
    const nodes = searchableText(element);
    let matches = 0;
    if (needle)
      for (const node of nodes) {
        const text = node.textContent ?? "",
          lower = text.toLocaleLowerCase();
        let start = 0,
          index = lower.indexOf(needle);
        if (index < 0 || matches >= matchLimit) continue;
        const fragment = document.createDocumentFragment();
        while (index >= 0 && matches < matchLimit) {
          fragment.append(text.slice(start, index));
          const mark = document.createElement("mark");
          mark.textContent = text.slice(index, index + needle.length);
          mark.tabIndex = -1;
          mark.dataset.match = String(matches++);
          fragment.append(mark);
          start = index + needle.length;
          index = lower.indexOf(needle, start);
        }
        fragment.append(text.slice(start));
        node.replaceWith(fragment);
      }
    setCount(matches);
    setPosition(0);
  }, [content, query]);
  useEffect(() => {
    body.current
      ?.querySelectorAll<HTMLElement>("mark[data-match]")
      .forEach((mark, i) => {
        if (i === position) mark.setAttribute("aria-current", "true");
        else mark.removeAttribute("aria-current");
      });
  }, [count, position, query]);
  const move = (step: number) => {
    const next = (position + step + count) % count;
    setPosition(next);
    const target = body.current?.querySelector<HTMLElement>(
      `mark[data-match="${next}"]`,
    );
    if (target) jump(target);
  };
  return (
    <section className="op-document-reader" aria-label="문서 읽기">
      {doc.id && doc.spaceId && version && (
        <div className="op-actions">
          <Button onClick={() => void copy(href(false))}>
            최신 문서 링크 복사
          </Button>
          <Button onClick={() => void copy(href(true))}>
            v{version} 고정 링크 복사
          </Button>
        </div>
      )}
      {version && (
        <dl className="reader-metadata">
          <div>
            <dt>발행 시점</dt>
            <dd>{doc.publishedAt ?? "미확인"}</dd>
          </div>
          <div>
            <dt>검토 시점</dt>
            <dd>미확인</dd>
          </div>
          <div>
            <dt>공식 문서 여부</dt>
            <dd>미확인</dd>
          </div>
        </dl>
      )}
      {doc.id && !blocks.length && (
        <p>부분 위치 기록이 없습니다. 문서 전체 링크를 사용하세요.</p>
      )}
      {anchorMissing && (
        <p role="alert">
          위치가 변경되었거나 사라졌습니다. 다른 문단으로 이동하지 않았습니다.
        </p>
      )}
      {blocks.some((b) => !b.stable) && (
        <p>
          반복되거나 범위가 큰 블록은 위치를 확정할 수 없어 부분 링크를 제공하지
          않습니다.
        </p>
      )}
      {shareBlock && (
        <section aria-label="선택한 부분 링크">
          <p>
            선택한 블록 · v{version}. 최신 링크는 다음 발행에서 위치가
            변경되거나 사라질 수 있습니다.
          </p>
          <div className="op-actions">
            <Button onClick={() => void copy(href(false, shareBlock))}>
              최신 부분 링크 복사
            </Button>
            <Button onClick={() => void copy(href(true, shareBlock))}>
              고정 부분 링크 복사
            </Button>
            <Button onClick={() => setShareBlock(null)}>부분 링크 닫기</Button>
          </div>
        </section>
      )}
      {copyResult && (
        <div>
          <p role="status">{copyResult.status}</p>
          {copyResult.fallback !== undefined && (
            <label>
              직접 복사할 내용
              <textarea
                readOnly
                value={copyResult.fallback}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
          )}
        </div>
      )}
      <nav aria-label="문서 목차">
        <h4>목차</h4>
        {outline.length ? (
          <ol>
            {outline.map((item) => (
              <li
                key={item.id}
                style={{ marginInlineStart: `${(item.level - 1) * 0.65}rem` }}
              >
                <Button
                  onClick={() => {
                    const target = body.current?.querySelector<HTMLElement>(
                      `#${item.id}`,
                    );
                    if (target) jump(target);
                  }}
                >
                  {item.title}
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          <p>제목 없음</p>
        )}
      </nav>
      <div className="op-actions">
        <label>
          문서 내 검색
          <input
            value={query}
            maxLength={200}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && count) {
                e.preventDefault();
                move(e.shiftKey ? -1 : 1);
              }
            }}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span role="status">
          {count ? `${position + 1} / ${count}` : "일치 0건"}
        </span>
        <Button disabled={!count} onClick={() => move(-1)}>
          이전 일치
        </Button>
        <Button disabled={!count} onClick={() => move(1)}>
          다음 일치
        </Button>
        <Button disabled={!count} onClick={() => move(0)}>
          현재 위치로 이동
        </Button>
      </div>
      {count === matchLimit && (
        <p>
          검색 결과는 처음 {matchLimit}건까지 표시합니다. 검색어를 좁히세요.
        </p>
      )}
      <div ref={body}>
        <Markdown text={content} readAttachment={readAttachment} />
      </div>
    </section>
  );
}
