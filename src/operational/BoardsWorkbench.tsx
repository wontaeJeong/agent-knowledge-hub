import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type Identity, type OperationalApi } from "./api";
import { Button } from "../ui/primitives";
import "./boards.css";
type Kind="notice"|"internal"|"voc";
type Row={id:string;kind:Kind;visibility:"team"|"private";title:string;authorId:string;status:string;pinned:boolean;unread:boolean;revision:number;createdAt:string};
type Comment={id:string;authorId:string;body:string;internal:boolean;createdAt:string};
type Detail={id:string;kind:Kind;visibility:string;title:string;body:string;author_id:string;revision:number;status:string;pinned:boolean;comments:Comment[]};
const label:Record<Kind,string>={notice:"공지",internal:"내부 검토",voc:"VOC · 제안"};
const date=(v:string)=>new Date(v).toLocaleString("ko-KR");
export default function BoardsWorkbench({api,identity,onExpired}:{api:OperationalApi;identity:Identity;onExpired:()=>void}){
 const [rows,setRows]=useState<Row[]>([]),[hasMore,setHasMore]=useState(false),[offset,setOffset]=useState(0),[kind,setKind]=useState("all");
 const [selected,setSelected]=useState<Detail|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [title,setTitle]=useState(""),[body,setBody]=useState(""),[visibility,setVisibility]=useState<"team"|"private">("team"),[postKind,setPostKind]=useState<Kind>("voc");
 const [comment,setComment]=useState(""),[internal,setInternal]=useState(false),[search,setSearch]=useState("");
 const reviewer=identity.role==="reviewer", manager=identity.spaceRole==="Admin"||(!identity.spaceRole&&reviewer);
 const fail=useCallback((e:unknown)=>{if(e instanceof ApiError&&e.status===401)onExpired();else setError(e instanceof Error?e.message:"요청 실패");},[onExpired]);
 const load=useCallback(async()=>{
  setLoading(true);
  try{const r=await api.get<{items:Row[];hasMore:boolean}>("/board/posts?offset="+offset+(kind==="all"?"":"&kind="+kind));setRows(r.items);setHasMore(r.hasMore);setError("");}
  catch(e){fail(e);}finally{setLoading(false);}
 },[api,offset,kind,fail]);
 useEffect(()=>{void load();},[load]);
 const act=async(run:()=>Promise<void>)=>{
  setBusy(true);setError("");setNotice("");
  try{await run();await load();setNotice("변경 내용을 저장했습니다.");}catch(e){fail(e);}finally{setBusy(false);}
 };
 const open=async(id:string)=>{
  setBusy(true);setError("");
  try{
   const p=await api.get<Detail>("/board/posts/"+id);
   await api.post("/board/posts/"+id+"/read",{});
   setSelected(p);await load();
  }catch(e){fail(e);}finally{setBusy(false);}
 };
 const create=async(e:FormEvent)=>{e.preventDefault();await act(async()=>{
  const r=await api.post<{id:string}>("/board/posts",{kind:postKind,visibility:postKind==="voc"?visibility:"team",title,body});
  setTitle("");setBody("");setOffset(0);await open(r.id);
 });};
 const writeComment=async(e:FormEvent)=>{e.preventDefault();if(!selected)return;
  await act(async()=>{await api.post("/board/posts/"+selected.id+"/comments",{body:comment,internal:reviewer&&internal});setComment("");setInternal(false);setSelected(await api.get<Detail>("/board/posts/"+selected.id));});
 };
 const changeStatus=async(status:"open"|"in_progress"|"resolved")=>{if(!selected)return;await act(async()=>{
  await api.request("/board/posts/"+selected.id,"PATCH",{revision:selected.revision,status});
  setSelected(await api.get<Detail>("/board/posts/"+selected.id));
 });};
 const visible=rows.filter(x=>(x.title+" "+x.authorId).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
 return <div className="board-workbench">
  <section className="op-panel">
   <div className="op-section-head"><h2>공지 · 내부 검토 · VOC</h2><small>현재 공간에서 접근 가능한 글만 표시합니다</small></div>
   <p className="muted">글은 공간별로 격리됩니다. 비공개 VOC는 작성자만, 내부 검토 글과 내부 댓글은 검토자만 열람할 수 있습니다.</p>
   <div className="board-filters"><label>분류<select value={kind} onChange={e=>{setOffset(0);setKind(e.target.value);setSelected(null);}}><option value="all">전체</option><option value="notice">공지</option><option value="internal">내부 검토</option><option value="voc">VOC</option></select></label>
   <label>검색<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="현재 페이지의 제목·작성자"/></label></div>
   {error&&<div role="alert" className="op-error">{error}<Button onClick={()=>void load()}>다시 시도</Button></div>}
   {notice&&<p role="status" className="op-notice">{notice}</p>}
   {loading?<p role="status">글 목록 확인 중…</p>:visible.length===0?<p>이 조건에 표시할 글이 없습니다.</p>:<div className="board-table-scroll" tabIndex={0} role="region" aria-label="게시글 목록, 가로 스크롤 가능"><table><caption>현재 공간 게시글</caption><thead><tr><th scope="col">구분 · 제목</th><th scope="col">작성자</th><th scope="col">상태</th><th scope="col">등록</th></tr></thead><tbody>{visible.map(r=><tr key={r.id}><th scope="row"><button className="board-open" onClick={()=>void open(r.id)} disabled={busy}>{r.pinned?"고정 · ":""}{label[r.kind]} · {r.title} {r.unread&&<span className="board-unread">새 글</span>}</button></th><td><code>{r.authorId}</code></td><td>{r.status}</td><td>{date(r.createdAt)}</td></tr>)}</tbody></table></div>}
   <div className="board-pagination"><Button disabled={busy||offset===0} onClick={()=>setOffset(n=>Math.max(0,n-50))}>이전</Button><span>{offset+1}번부터</span><Button disabled={busy||!hasMore} onClick={()=>setOffset(n=>n+50)}>다음</Button></div>
  </section>
  <section className="op-panel"><h2>새 글 작성</h2>
   <form onSubmit={e=>void create(e)} className="board-form">
    <label>분류<select value={postKind} onChange={e=>{setPostKind(e.target.value as Kind);setVisibility("team");}}><option value="voc">VOC · 제안</option>{reviewer&&<option value="internal">내부 검토</option>}{manager&&<option value="notice">공지</option>}</select></label>
    {postKind==="voc"&&<label>공개 범위<select value={visibility} onChange={e=>setVisibility(e.target.value as "team"|"private")}><option value="team">현재 공간</option><option value="private">비공개 · 작성자만</option></select></label>}
    <label>제목<input required maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>내용<textarea required maxLength={20000} rows={5} value={body} onChange={e=>setBody(e.target.value)}/></label>
    <Button variant="primary" disabled={busy||!title.trim()||!body.trim()}>작성</Button>
   </form>
  </section>
  {selected&&<section className="op-panel board-detail"><div className="op-section-head"><h2>{label[selected.kind]} · {selected.title}</h2><Button onClick={()=>setSelected(null)}>닫기</Button></div>
   <p className="muted">{selected.author_id} · {selected.visibility==="private"?"작성자만":"공간 공개"} · {selected.status} · 수정 버전 {selected.revision}</p>
   <pre className="board-content">{selected.body}</pre>
   {manager&&<div className="board-status"><span>운영 상태</span>{(["open","in_progress","resolved"] as const).map(s=><Button key={s} disabled={busy||selected.status===s} onClick={()=>void changeStatus(s)}>{s}</Button>)}</div>}
   <h3>댓글 {selected.comments.length}개</h3>
   {selected.comments.length===0?<p>댓글이 없습니다.</p>:<div className="board-comments">{selected.comments.map(c=><article key={c.id}><small>{c.internal?"내부 · ":""}{c.authorId} · {date(c.createdAt)}</small><pre>{c.body}</pre></article>)}</div>}
   <form onSubmit={e=>void writeComment(e)} className="board-form"><label>댓글<textarea required rows={3} maxLength={10000} value={comment} onChange={e=>setComment(e.target.value)}/></label>{reviewer&&<label className="board-checkbox"><input type="checkbox" checked={internal} onChange={e=>setInternal(e.target.checked)}/>검토자만 보는 내부 댓글</label>}<Button disabled={busy||!comment.trim()}>댓글 등록</Button></form>
  </section>}
 </div>;
}
