import { useEffect } from "react";
import type { Identity } from "../api";
import type { ConsoleTab } from "../console";
import { consoleLabel } from "../console";
import { convenienceHref } from "./route";
import { convenienceSections, type NavigationItem } from "./types";
export function navigationItems(identity: Identity): NavigationItem[] {
  const capabilities = identity.capabilities ?? [];
  const can = (capability: string) => capabilities.includes(capability);
  const items: NavigationItem[] = [];
  const add = (id: ConsoleTab, group: NavigationItem["group"]) =>
    items.push({ id, label: consoleLabel(id), group });
  if (can("knowledge.read")) {
    for (const id of [
      "home",
      "discovery",
      "knowledge",
      "search",
      "tasks",
    ] as const)
      add(id, "지식 공간");
    for (const id of [
      "favorites",
      "recent",
      "subscriptions",
      "saved-views",
    ] as const)
      add(id, "내 문서");
    for (const id of [
      "workflows",
      "versions",
      "notifications",
      "query",
      "boards",
      "refinement",
    ] as const)
      add(id, "지식 도구");
  }
  if (can("knowledge.read")) {
    add("agents", "내 도구");
    add("integrations", "내 도구");
  }
  if (can("changeset.approve") && identity.canReviewKnowledge !== false)
    add("evaluation", "지식 도구");
  if (can("draft.write")) add("compose", "지식 공간");
  if (can("changeset.propose")) {
    add("imports", "지식 공간");
    add("sources", "지식 도구");
  }
  if (can("queue.triage") || can("changeset.approve"))
    add("review", "지식 도구");
  if (can("lint.run")) add("lint", "지식 도구");
  if (can("jobs.read")) add("jobs", "관리·운영");
  if (can("usage.read_aggregate")) add("usage", "관리·운영");
  if (can("knowledge.protect")) add("policies", "관리·운영");
  if (can("lifecycle.manage")) add("lifecycle", "관리·운영");
  if (can("space.admin"))
    for (const id of ["overview", "access", "activity", "coverage"] as const)
      add(id, "관리·운영");
  return items;
}
export function Navigation({
  identity,
  active,
  navigate,
  onSelected,
}: {
  identity: Identity;
  active: ConsoleTab;
  navigate: (tab: ConsoleTab) => boolean | void;
  onSelected: () => void;
}) {
  const items = navigationItems(identity);
  return (
    <>
      {(
        ["지식 공간", "내 문서", "지식 도구", "내 도구", "관리·운영"] as const
      ).map((group) => {
        const members = items.filter((item) => item.group === group);
        if (!members.length) return null;
        return (
          <div className="console-nav-group" key={group}>
            <p>{group}</p>
            {members.map((item) => {
              const section = convenienceSections.find(
                (section) => section === item.id,
              );
              const href = section
                ? convenienceHref({
                    kind: "section",
                    spaceId: identity.workspaceId,
                    section,
                  })
                : convenienceHref({
                    kind: "console",
                    spaceId: identity.workspaceId,
                    tab: item.id,
                  });
              return (
                <a
                  key={item.id}
                  href={href}
                  aria-current={active === item.id ? "page" : undefined}
                  onClick={(e) => {
                    if (
                      e.button !== 0 ||
                      e.metaKey ||
                      e.ctrlKey ||
                      e.shiftKey ||
                      e.altKey
                    )
                      return;
                    e.preventDefault();
                    if (navigate(item.id) !== false) onSelected();
                  }}
                >
                  <span>{item.label}</span>
                </a>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

/** Reuses the editor's unsaved-content predicate; never stores draft content. */
export function NavigationProtection({ dirty }: { dirty: boolean }) {
  useEffect(() => {
    const beforeNavigate = (event: Event) => {
      if (dirty && !window.confirm("저장하지 않은 입력을 닫을까요?"))
        event.preventDefault();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("akh:before-navigate", beforeNavigate);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("akh:before-navigate", beforeNavigate);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty]);
  return null;
}
