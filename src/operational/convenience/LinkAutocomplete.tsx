import {
  useRef,
  useState,
  type TextareaHTMLAttributes,
  type ChangeEvent,
} from "react";
import type { OperationalApi } from "../api";
import { LinkCompletion } from "../document-navigation";
type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  api: OperationalApi;
  spaceId: string;
  onError: (e: unknown) => void;
  onReference?: (target: { id: string; version: number }) => void;
};
/** Same completion/authorization path as the existing explicit link picker. */
export function LinkAutocomplete({
  api,
  spaceId,
  onError,
  onReference,
  ...props
}: Props) {
  const area = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false),
    [trigger, setTrigger] = useState<{
      start: number;
      end: number;
      query: string;
    } | null>(null);
  const inspect = (node: HTMLTextAreaElement) => {
    if (composing.current || node.selectionStart !== node.selectionEnd) {
      setTrigger(null);
      return;
    }
    const prefix = node.value.slice(0, node.selectionStart),
      match = /\[\[([^\[\]\n]{1,200})$/.exec(prefix);
    // Keep fenced and inline code portable and untouched.
    const fenced = (prefix.match(/^\s*(```|~~~)/gm)?.length ?? 0) % 2 === 1;
    const line = prefix.slice(prefix.lastIndexOf("\n") + 1);
    if (!match || fenced || (line.match(/`/g)?.length ?? 0) % 2 === 1) {
      setTrigger(null);
      return;
    }
    setTrigger({
      start: prefix.length - match[0].length,
      end: prefix.length,
      query: match[1],
    });
  };
  return (
    <div
      className="op-link-autocomplete"
      onKeyDown={(e) => {
        if (composing.current || e.nativeEvent.isComposing) return;
        if (e.key === "Escape" && trigger) {
          e.preventDefault();
          setTrigger(null);
          area.current?.focus();
        }
        if (e.key === "ArrowDown" && e.target === area.current && trigger) {
          const button = e.currentTarget.querySelector<HTMLButtonElement>(
            "button[data-link-choice]",
          );
          if (button) {
            e.preventDefault();
            button.focus();
          }
        }
      }}
    >
      <textarea
        {...props}
        ref={area}
        onChange={(e) => {
          props.onChange?.(e);
          inspect(e.currentTarget);
        }}
        onSelect={(e) => {
          props.onSelect?.(e);
          inspect(e.currentTarget);
        }}
        onCompositionStart={(e) => {
          composing.current = true;
          setTrigger(null);
          props.onCompositionStart?.(e);
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          props.onCompositionEnd?.(e);
          inspect(e.currentTarget);
        }}
      />
      {trigger && !props.disabled && (
        <LinkCompletion
          key={`${spaceId}:${trigger.start}:${trigger.query}`}
          api={api}
          spaceId={spaceId}
          query={trigger.query}
          onError={onError}
          onInsert={(markdown, target) => {
            const node = area.current;
            if (
              !node ||
              composing.current ||
              node.value.slice(trigger.start, trigger.end) !==
                "[[" + trigger.query
            )
              return;
            onReference?.(target);
            const suffix = node.value.slice(trigger.end),
              next =
                node.value.slice(0, trigger.start) +
                markdown +
                suffix.replace(/^\]\]/, "");
            // Deliver the changed Markdown through the editor's existing autosave/recovery handler.
            Object.getOwnPropertyDescriptor(
              HTMLTextAreaElement.prototype,
              "value",
            )!.set!.call(node, next);
            props.onChange?.({
              target: node,
              currentTarget: node,
            } as ChangeEvent<HTMLTextAreaElement>);
            setTrigger(null);
            node.focus();
            node.setSelectionRange(
              trigger.start + markdown.length,
              trigger.start + markdown.length,
            );
          }}
        />
      )}
      {trigger && (
        <p>
          동명 문서는 ID를 확인하고 선택하세요. 선택하지 않은 [[제목]]은 미해결
          텍스트로 남습니다.
        </p>
      )}
    </div>
  );
}
