import { useEffect, useRef, useState } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import katex from "katex";
import "./markdown.css";

export type ImagePreview = {
  render: "raster-image";
  mime: string;
  base64: string;
  width: number;
  height: number;
};
export type AttachmentReader = (blobId: string) => Promise<ImagePreview>;
const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
export const presentationFormats =
  "Markdown 표·코드·내부 링크, PNG/JPEG/WebP 첨부, $…$·$$…$$ 수식, Mermaid flowchart·sequenceDiagram을 지원합니다. 외부 이미지·HTML·스크립트·다이어그램 설정과 클릭 동작은 지원하지 않습니다.";
function math(source: string, displayMode: boolean) {
  try {
    if (source.length > 4000) throw Error();
    return katex
      .renderToString(source, {
        displayMode,
        output: "mathml",
        trust: false,
        strict: "error",
        throwOnError: true,
        maxExpand: 200,
        maxSize: 10,
      })
      .replace(/<annotation\b[^>]*>[^]*?<\/annotation>/g, "");
  } catch {
    return `<code title="지원하지 않는 수식">${escape(source)}</code>`;
  }
}
function markdownParser() {
  let formulas = 0,
    diagrams = 0;
  const formula = (source: string, display: boolean) =>
    ++formulas <= 128
      ? math(source, display)
      : `<code title="수식 표시 128개 상한">${escape(source)}</code>`;
  return new Marked({
    renderer: {
      html: () => "",
      image: ({ href, text }) => {
        const match =
          /^\/api\/v1\/storage\/blobs\/([a-zA-Z0-9_-]{1,100})$/.exec(href);
        return match
          ? `<button type="button" class="markdown-image" data-attachment="${escape(match[1])}" data-label="${escape(text)}">첨부 이미지: ${escape(text)}</button>`
          : `<span>외부 또는 미지원 이미지: ${escape(text)}</span>`;
      },
      code: ({ text, lang }) =>
        lang?.trim() === "mermaid" && ++diagrams <= 10
          ? `<pre class="markdown-diagram" data-diagram="true"><code>${escape(text)}</code></pre>`
          : `<pre><code${lang ? ` class="language-${escape(lang.split(/\s/)[0])}"` : ""}>${escape(text)}\n</code></pre>`,
    },
    extensions: [
      {
        name: "blockMath",
        level: "block",
        start: (source: string) => source.indexOf("$$"),
        tokenizer(source: string) {
          const m = /^\$\$([^]*?)\$\$(?:\n|$)/.exec(source);
          if (m) return { type: "blockMath", raw: m[0], text: m[1] };
        },
        renderer: (token) => formula(token.text, true),
      },
      {
        name: "inlineMath",
        level: "inline",
        start: (source: string) => source.indexOf("$"),
        tokenizer(source: string) {
          const m = /^\$(?!\$)([^$\n]+?)\$(?!\$)/.exec(source);
          if (m) return { type: "inlineMath", raw: m[0], text: m[1] };
        },
        renderer: (token) => formula(token.text, false),
      },
    ],
  });
}
/** Read-only transformation: canonical Markdown is never serialized from the rendered DOM. */
export function renderMarkdown(text: string) {
  return DOMPurify.sanitize(markdownParser().parse(text, { async: false }), {
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: [
      "img",
      "svg",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
    ],
    FORBID_ATTR: ["style", "src", "srcset"],
  });
}
export function validateDiagram(source: string) {
  if (
    source.length > 10000 ||
    !/^\s*(?:flowchart\s+(?:TB|TD|BT|RL|LR)\b|sequenceDiagram\b)/.test(
      source,
    ) ||
    /%%\{|^\s*---|\b(?:click|link|links|href|callback|image|img|icon|classDef|style|linkStyle)\b|<\/?[a-z!]|(?:https?|data|javascript|file):|@\{|url\s*\(/im.test(
      source,
    )
  )
    throw Error(
      "지원하지 않는 Mermaid 구문입니다. flowchart와 sequenceDiagram의 텍스트·연결만 허용합니다.",
    );
}
/** Even a library-generated SVG cannot install links, external images, HTML or style imports. */
export function sanitizeDiagram(svg: string) {
  const safe = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      "foreignObject",
      "image",
      "a",
      "style",
      "script",
      "use",
      "animate",
      "set",
    ],
    FORBID_ATTR: ["href", "xlink:href"],
  });
  const template = document.createElement("template");
  template.innerHTML = safe;
  for (const element of template.content.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (
        (attribute.name === "style" &&
          /(?:url\s*\(|@import|expression\s*\()/i.test(attribute.value)) ||
        (/url\s*\(/i.test(attribute.value) &&
          !/^url\(#[a-zA-Z0-9_-]+\)$/.test(attribute.value))
      )
        element.removeAttribute(attribute.name);
    }
  }
  return template.innerHTML;
}
let diagramId = 0;
async function diagram(source: string) {
  validateDiagram(source);
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    maxTextSize: 10000,
    maxEdges: 100,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: "base",
  });
  const { svg } = await mermaid.render(`akh-diagram-${++diagramId}`, source);
  return sanitizeDiagram(svg);
}
export function RasterImage({
  preview,
  label,
}: {
  preview: ImagePreview;
  label: string;
}) {
  const valid =
    ["image/png", "image/jpeg", "image/webp"].includes(preview.mime) &&
    /^[A-Za-z0-9+/]+=*$/.test(preview.base64) &&
    preview.base64.length <= 7_000_000 &&
    preview.width > 0 &&
    preview.height > 0 &&
    preview.width <= 4096 &&
    preview.height <= 4096;
  return valid ? (
    <img
      className="markdown-raster"
      src={`data:${preview.mime};base64,${preview.base64}`}
      alt={label}
      width={preview.width}
      height={preview.height}
    />
  ) : (
    <p role="alert">검증된 이미지 형식이 아닙니다.</p>
  );
}
export function Markdown({
  text,
  readAttachment,
  className = "op-markdown",
}: {
  text: string;
  readAttachment?: AttachmentReader;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<{
    preview: ImagePreview;
    label: string;
  } | null>(null);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const previewRequest = useRef(0);
  const [previewPending, setPreviewPending] = useState(false);
  const closePreview = () => {
    previewRequest.current++;
    setPreviewPending(false);
    setImage(null);
    setMessage("");
  };
  useEffect(() => {
    const epoch = ++generation.current;
    previewRequest.current++;
    setPreviewPending(false);
    setImage(null);
    setMessage("");
    for (const element of root.current?.querySelectorAll<HTMLElement>(
      "[data-diagram]",
    ) ?? []) {
      const source = element.querySelector("code")?.textContent ?? "";
      void diagram(source)
        .then((svg) => {
          if (epoch === generation.current) {
            element.innerHTML = svg;
            element.setAttribute("role", "img");
            element.setAttribute("aria-label", "Mermaid 다이어그램");
          }
        })
        .catch((error) => {
          if (epoch === generation.current) {
            const note = document.createElement("p");
            note.textContent =
              error instanceof Error && error.message.startsWith("지원하지")
                ? error.message
                : "다이어그램을 표시할 수 없습니다. 원본 구문을 확인하세요.";
            element.before(note);
          }
        });
    }
    return () => {
      generation.current++;
      previewRequest.current++;
    };
  }, [text, readAttachment]);
  return (
    <div className={className}>
      <div
        ref={root}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
        onClick={(event) => {
          const target = (event.target as Element).closest<HTMLElement>(
            "[data-attachment]",
          );
          if (!target) return;
          const request = ++previewRequest.current;
          if (!readAttachment) {
            setImage(null);
            setPreviewPending(false);
            setMessage("인증된 첨부 미리보기 연결이 필요합니다.");
            return;
          }
          const epoch = generation.current;
          setPreviewPending(true);
          setImage(null);
          setMessage("현재 권한을 확인하고 있습니다.");
          void readAttachment(target.dataset.attachment!)
            .then((preview) => {
              if (
                epoch === generation.current &&
                request === previewRequest.current
              ) {
                setPreviewPending(false);
                setImage({
                  preview,
                  label: target.dataset.label || "첨부 이미지",
                });
                setMessage("");
              }
            })
            .catch(() => {
              if (
                epoch === generation.current &&
                request === previewRequest.current
              ) {
                setPreviewPending(false);
                setImage(null);
                setMessage(
                  "현재 권한 또는 검사 상태로 이미지를 표시할 수 없습니다.",
                );
              }
            });
        }}
      />
      {readAttachment &&
        /!\[[^]*?\]\(\/api\/v1\/storage\/blobs\//.test(text) && (
          <p className="markdown-help">
            첨부 이미지의 이름을 선택하면 현재 권한을 확인해 표시합니다.
          </p>
        )}
      {message && <p role="status">{message}</p>}
      {(image || previewPending) && (
        <figure>
          {image && <RasterImage {...image} />}
          <button onClick={closePreview}>이미지 닫기</button>
        </figure>
      )}
    </div>
  );
}
