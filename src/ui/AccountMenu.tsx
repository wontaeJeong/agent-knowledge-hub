import { useEffect, useRef, useState } from "react";
import { ChevronUp, LogOut, Moon, Settings2, Sun } from "lucide-react";
import "./account-menu.css";

export function AccountMenu({
  name,
  detail,
  dark,
  onTheme,
  onSettings,
  onLogout,
  busy = false,
}: {
  name: string;
  detail: string;
  dark: boolean;
  onTheme: () => void;
  onSettings: () => void;
  onLogout?: () => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="account-menu" ref={container}>
      {open && (
        <div className="account-menu-panel" aria-label="사용자 메뉴">
          <div className="account-menu-heading">
            <strong>{name}</strong>
            <small>{detail}</small>
          </div>
          <button type="button" onClick={onTheme}>
            {dark ? <Sun size={16} /> : <Moon size={16} />}
            {dark ? "라이트 모드" : "다크 모드"}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            <Settings2 size={16} />
            사용자 설정
          </button>
          {onLogout && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
            >
              <LogOut size={16} />
              로그아웃
            </button>
          )}
        </div>
      )}
      <button
        ref={trigger}
        type="button"
        className="account-menu-trigger"
        aria-expanded={open}
        aria-label={`${name} 사용자 메뉴`}
        onClick={() => setOpen(!open)}
      >
        <span className="account-menu-avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="account-menu-identity">
          <strong>{name}</strong>
          <small>{detail}</small>
        </span>
        <ChevronUp size={16} />
      </button>
    </div>
  );
}
