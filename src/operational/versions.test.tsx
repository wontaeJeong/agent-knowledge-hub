import {expect,test} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {VersionsPanel,decisionInput} from "./versions";
import {OperationalApi} from "./api";
test("version UI states unknown historical metadata and independent review, without claiming text restoration is full history",()=>{
 const html=renderToStaticMarkup(<VersionsPanel api={new OperationalApi()} pages={[]} batches={[]} spaceId="s" principalId="p" canPropose canReview/>);
 expect(html).toContain("당시 속성 스냅샷이 없는 버전은 미확인");expect(html).toContain("정본을 즉시 덮어쓰지 않습니다");expect(html).toContain("원본과 현재 접근 제한은 복원하지 않습니다");expect(html).toContain("자동 발행하지 않습니다");
});
test("partial decision request contains exact hash and selected per-document reasons, never caller identity or approval flags",()=>{
 const b={id:"batch",hash:"a".repeat(64),status:"pending",updates:[{id:"a",title:"A"},{id:"b",title:"B"}]};
 expect(decisionInput(b,["a"],{a:"독립 문서",b:"미선택"},"approve")).toEqual({batchId:b.id,expectedHash:b.hash,pageIds:["a"],decision:"approve",reasons:{a:"독립 문서"}});
 expect(()=>decisionInput(b,["a"],{},"approve")).toThrow("판단 이유");
});
