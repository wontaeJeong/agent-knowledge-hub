// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";

afterEach(() => {
  document.body.innerHTML = "";
});
test("account menu opens and provides theme, settings and logout actions", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const theme = vi.fn(),
    settings = vi.fn(),
    logout = vi.fn();
  await act(async () =>
    root.render(
      <AccountMenu
        name="민서"
        detail="검토자"
        dark={false}
        onTheme={theme}
        onSettings={settings}
        onLogout={logout}
      />,
    ),
  );
  const button = host.querySelector<HTMLButtonElement>(
    "button[aria-expanded]",
  )!;
  expect(button.getAttribute("aria-expanded")).toBe("false");
  await act(async () => button.click());
  expect(button.getAttribute("aria-expanded")).toBe("true");
  const click = async (label: string) => {
    const item = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(label),
    )!;
    await act(async () => item.click());
  };
  await click("다크 모드");
  expect(theme).toHaveBeenCalledOnce();
  await click("사용자 설정");
  expect(settings).toHaveBeenCalledOnce();
  await act(async () => button.click());
  await click("로그아웃");
  expect(logout).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});
