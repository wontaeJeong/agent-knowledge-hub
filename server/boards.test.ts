import { beforeEach, afterEach, expect, test } from "vitest";
import { fixture } from "./test-support";
import { handleBoardRequest } from "./boards";
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{f=await fixture();});
afterEach(async()=>{await f.pool.end();});
const call=(ctx:typeof f.ctx,method:string,path:string,body?:unknown)=>handleBoardRequest(f.pool,ctx,method,"/api/v1/board/"+path,body,new URLSearchParams());
async function create(ctx:typeof f.ctx,kind:"notice"|"internal"|"voc",visibility:"team"|"private"="team"){
 const value=await call(ctx,"POST","posts",{kind,visibility,title:"시험 공지",body:"검증되지 않은 주장"});
 expect(value?.status).toBe(201);
 return (value?.body as {id:string}).id;
}
test("notices are public to the current workspace, while private VOC is author-only",async()=>{
 const notice=await create(f.ctx,"notice");
 expect((await call(f.reader,"GET","posts"))?.status).toBe(200);
 expect((await call(f.reader,"GET","posts/"+notice))?.status).toBe(200);
 await expect(create(f.editor,"notice")).rejects.toThrow("FORBIDDEN");
 const privateVoc=await create(f.editor,"voc","private");
 expect((await call(f.editor,"GET","posts/"+privateVoc))?.status).toBe(200);
 await expect(call(f.reader,"GET","posts/"+privateVoc)).rejects.toThrow("NOT_FOUND");
 await expect(call(f.ctx,"GET","posts/"+privateVoc)).rejects.toThrow("NOT_FOUND");
 const rows=(await call(f.ctx,"GET","posts"))?.body as {items:{id:string}[]};
 expect(rows.items.map(x=>x.id)).not.toContain(privateVoc);
});
test("internal posts and internal comments are restricted to reviewers",async()=>{
 const internal=await create(f.ctx,"internal");
 await expect(call(f.editor,"GET","posts/"+internal)).rejects.toThrow("NOT_FOUND");
 const notice=await create(f.ctx,"notice");
 await call(f.ctx,"POST","posts/"+notice+"/comments",{body:"비공개 검토",internal:true});
 await call(f.editor,"POST","posts/"+notice+"/comments",{body:"공개 문의",internal:false});
 await expect(call(f.editor,"POST","posts/"+notice+"/comments",{body:"우회 시도",internal:true})).rejects.toThrow("FORBIDDEN");
 const reader=(await call(f.reader,"GET","posts/"+notice))?.body as {comments:{internal:boolean}[]};
 const reviewer=(await call(f.ctx,"GET","posts/"+notice))?.body as {comments:{internal:boolean}[]};
 expect(reader.comments).toHaveLength(1);
 expect(reader.comments[0].internal).toBe(false);
 expect(reviewer.comments).toHaveLength(2);
});
test("optimistic revisions and moderator changes prevent lost edits",async()=>{
 const id=await create(f.editor,"voc");
 const first=await call(f.editor,"PATCH","posts/"+id,{revision:1,title:"갱신된 제목"});
 expect(first?.body).toMatchObject({revision:2});
 await expect(call(f.editor,"PATCH","posts/"+id,{revision:1,title:"오래된 제출"})).rejects.toThrow("STALE_VERSION");
 await expect(call(f.editor,"PATCH","posts/"+id,{revision:2,pinned:true})).rejects.toThrow("FORBIDDEN");
 const resolved=await call(f.ctx,"PATCH","posts/"+id,{revision:2,status:"resolved"});
 expect(resolved?.body).toMatchObject({revision:3});
});
test("revoked membership and stale authorization cannot mutate posts",async()=>{
 const id=await create(f.editor,"voc");
 const denied={...f.editor,authorization:{sessionId:"stale",revalidate:async()=>{},assertSession:async()=>{throw Error("UNAUTHENTICATED");}}};
 await expect(call(denied,"POST","posts/"+id+"/comments",{body:"stale"})).rejects.toThrow("UNAUTHENTICATED");
 await f.pool.query("DELETE FROM memberships WHERE workspace_id=$1 AND principal_id=$2",[f.workspaceId,"editor"]);
 await expect(call(f.editor,"GET","posts/"+id)).rejects.toThrow("NOT_FOUND");
});
test("usage statistics support four bounded windows, not arbitrary history",async()=>{
 const {usageSummary}=await import("./usage");
 for(const days of [7,14,30,90])expect((await usageSummary(f.pool,f.ctx,days)).daily).toHaveLength(days);
 await expect(usageSummary(f.pool,f.ctx,91)).rejects.toThrow("VALIDATION_FAILED");
});
