import { it, expect } from "vitest";
import { seed } from "./seed";
import { retrieve } from "./wiki";
it("retrieves Korean nouns with common particles in a natural question", () => {
  const s = structuredClone(seed);
  s.pages = [
    {
      ...s.pages[0],
      id: "backup-test",
      title: "백업",
      summary: "합성 복원 기준",
      versions: [
        {
          ...s.pages[0].versions[0],
          content: "매일 독립 저장소에 백업하고 복원 시험을 수행한다.",
        },
      ],
    },
  ];
  expect(
    retrieve(s, "백업은 어떻게 수행해야 하나요?").map((p) => p.id),
  ).toEqual(["backup-test"]);
  expect(retrieve(s, "무관한질문은?")).toHaveLength(0);
});
