import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Badge, Button } from "../ui/primitives";

export interface PreviewField {
  name: string;
  label: string;
  type?: "text" | "email" | "number" | "textarea";
  options?: readonly string[];
  value?: string;
  required?: boolean;
}
export interface PreviewOperation {
  title: string;
  description: string;
  fields?: PreviewField[];
  submit?: string;
  run: (data: FormData) => void;
}
export function PreviewDialog({
  operation: op,
  close,
}: {
  operation: PreviewOperation;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    previousFocus.current ??= document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previousFocus.current?.focus();
    };
  }, []);
  return (
    <dialog
      className="console-dialog"
      ref={ref}
      aria-labelledby="preview-dialog-title"
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const controls = [
          ...e.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]",
          ),
        ];
        const first = controls[0],
          last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            op.run(new FormData(e.currentTarget));
            close();
          } catch (e) {
            setError(e instanceof Error ? e.message : "입력을 확인하세요.");
          }
        }}
      >
        <header>
          <div>
            <Badge tone="plum">목업 · 실제 권한 변경 없음</Badge>
            <h2 id="preview-dialog-title">{op.title}</h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            aria-label="대화상자 닫기"
            onClick={close}
          >
            <X size={20} />
          </Button>
        </header>
        <p>{op.description}</p>
        {op.fields?.map((f) => (
          <label key={f.name}>
            {f.label}
            {f.options ? (
              <select name={f.name} defaultValue={f.value ?? f.options[0]}>
                {f.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : f.type === "textarea" ? (
              <textarea
                name={f.name}
                rows={5}
                defaultValue={f.value}
                maxLength={10000}
                required={f.required !== false}
              />
            ) : (
              <input
                name={f.name}
                type={f.type ?? "text"}
                defaultValue={f.value}
                maxLength={200}
                required={f.required !== false}
                {...(f.type === "number" ? { min: 1, max: 10000 } : {})}
              />
            )}
          </label>
        ))}
        {error && (
          <p role="alert" className="console-form-error">
            {error}
          </p>
        )}
        <div className="op-actions">
          <Button type="submit" variant="primary">
            {op.submit ?? "목업에서 확인"}
          </Button>
          <Button type="button" onClick={close}>
            취소
          </Button>
        </div>
        <small>
          합성 데이터만 입력하세요. 자격증명·실제 사용자 정보·업무 자료를
          입력하지 마세요.
        </small>
      </form>
    </dialog>
  );
}
