import { test, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessPanel, selectedActions } from "./access";
import { OperationalApi } from "./api";
test("credential selection excludes all approval, publication and administration powers", () => {
  expect(
    selectedActions([
      "knowledge.read",
      "changeset.approve",
      "space.admin",
      "changeset.propose",
      "changeset.publish",
    ]),
  ).toEqual(["knowledge.read", "changeset.propose"]);
});
test("space management does not render admin grant controls to ordinary readers", () => {
  const html = renderToStaticMarkup(
    <AccessPanel
      api={new OperationalApi()}
      capabilities={["knowledge.read"]}
      onExpired={() => {}}
      onChanged={async () => {}}
      onSelect={() => {}}
    />,
  );
  expect(html).toContain("공간과 접근 권한");
  expect(html).not.toContain("공간 역할 부여");
  expect(html).toContain("개인 공간 만들기");
});
