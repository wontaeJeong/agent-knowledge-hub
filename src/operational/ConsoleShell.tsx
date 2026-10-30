import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Bot,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Database,
  FlaskConical,
  FolderKey,
  Gauge,
  Layers3,
  ListChecks,
  Menu,
  Moon,
  Plug,
  SearchCheck,
  Settings2,
  ShieldCheck,
  Sun,
  Users,
  X,
} from "lucide-react";
import { consoleGroups, consoleLabel } from "./console";
import type { ConsoleTab } from "./console";
import { Button } from "../ui/primitives";
import { BrandMark } from "../ui/BrandMark";
import "./console.css";

const icons = {
  overview: Gauge,
  usage: Activity,
  jobs: ListChecks,
  knowledge: BookOpen,
  imports: Database,
  sources: Database,
  review: ClipboardCheck,
  query: Layers3,
  lint: SearchCheck,
  agents: Bot,
  integrations: Plug,
  users: Users,
  access: FolderKey,
  policies: ShieldCheck,
  lifecycle: Settings2,
  activity: Activity,
  evaluation: FlaskConical,
  coverage: CircleHelp,
};
export function ConsoleShell({
  preview,
  tab,
  navigate,
  account,
  children,
}: {
  preview: boolean;
  tab: ConsoleTab;
  navigate: (tab: ConsoleTab) => void;
  account: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.dataset.theme === "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  return (
    <div className="operational-app console-app">
      <a
        className="op-skip"
        href="#op-main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("op-main")?.focus();
        }}
      >
        본문으로 이동
      </a>
      <aside className="console-sidebar">
        <a className="console-brand" href="/">
          <BrandMark size={36} />
          <span>
            agent-knowledge-hub<small>Agent-native knowledge platform</small>
          </span>
        </a>
        <div className="console-space">
          <span className="console-space-icon">
            <Layers3 size={19} />
          </span>
          <div>
            <strong>
              {preview ? "Platform · 예시 공간" : "현재 지식 공간"}
            </strong>
            <small>
              {preview ? "소유·역할은 합성 예시" : "접근 범위는 서버에서 확인"}
            </small>
          </div>
        </div>
        <Button
          className="console-menu-toggle"
          aria-expanded={open}
          aria-controls="console-navigation"
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={18} /> : <Menu size={18} />}{" "}
          {open ? "탐색 닫기" : `메뉴 · ${consoleLabel(tab)}`}
        </Button>
        <nav
          id="console-navigation"
          className={open ? "is-open" : ""}
          aria-label="운영 콘솔"
        >
          {consoleGroups.map((group) => (
            <div className="console-nav-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => {
                const Icon = icons[item.id];
                return (
                  <a
                    key={item.id}
                    href={`#${item.id}`}
                    aria-current={item.id === tab ? "page" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(item.id);
                      setOpen(false);
                    }}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                    {item.id === tab && <ChevronRight size={15} />}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="console-sidebar-note">
          <ShieldCheck size={17} />
          <span>
            근거와 권한을 보존하고
            <br />
            검토한 변경만 발행합니다.
          </span>
        </div>
      </aside>
      <div className="console-workspace">
        <header className="console-topbar">
          <div>
            <span>지식 환경</span>
            <ChevronRight size={15} />
            <strong>{consoleLabel(tab)}</strong>
          </div>
          <div>
            <span
              className={`console-environment ${preview ? "is-preview" : ""}`}
            >
              {preview ? "합성 UI 목업" : "서버 연결 모드"}
            </span>
            <Button
              variant="ghost"
              aria-label={dark ? "라이트 테마" : "다크 테마"}
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </Button>
            {account}
          </div>
        </header>
        {preview && (
          <div className="console-preview-banner" role="note">
            <FlaskConical size={18} />
            <span>
              <strong>목업 미리보기</strong> · 실제 서버에 연결하지 않습니다.
              예시 데이터와 변경은 메모리에만 유지되며 새로고침하면
              초기화됩니다.
            </span>
            <a href="/?app=1">
              실제 앱 <ArrowUpRight size={15} />
            </a>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
