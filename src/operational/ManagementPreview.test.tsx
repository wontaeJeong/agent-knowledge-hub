import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { Management } from "./ManagementPreview";
import { ConsoleTable } from "./ConsoleTable";

test("live management boundary does not render synthetic accounts or edit forms", () => {
  const network = vi.spyOn(globalThis, "fetch");
  try {
    const html = renderToStaticMarkup(<Management section="users" preview={false} navigate={() => {}}/>);
    expect(html).toContain("/?preview=1#users");
    expect(html).not.toContain("example.test");
    expect(html).not.toContain("김하늘");
    expect(html).not.toContain("<input");
    expect(network).not.toHaveBeenCalled();
  } finally {network.mockRestore();}
});
test("management preview exposes distinguishable accounts and a table viewport", () => {
  const html = renderToStaticMarkup(<Management section="users" preview navigate={() => {}}/>);
  expect(html).toContain("example.test");
  expect(html).toContain("팀 구성원과 초대");
  expect(html).toContain("가로 스크롤 가능");
});
test("long lists render only 25 rows while preserving navigation and total", () => {
  const html = renderToStaticMarkup(<ConsoleTable caption="항목" columns={["이름"]} rows={Array.from({length: 251}, (_, i) => ({id: String(i), search: `item-${i}`, cells: [`item-${i}`]}))}/>);
  expect(html.match(/<tr>/g)).toHaveLength(26);
  expect(html).toContain("251");
  expect(html).toContain("다음 25건");
  expect(html).not.toContain("item-25<");
});
