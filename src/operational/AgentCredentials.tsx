import {useCallback,useEffect,useState,type FormEvent} from "react";
import {ApiError,type Identity,type OperationalApi} from "./api";
import {Button} from "../ui/primitives";
import "./credentials.css";
type Scope="read"|"write";
type KeyItem={id:string;issuer?:string;name:string;scope:Scope;suffix:string;createdAt:string;expiresAt:string;revokedAt:string|null;lastUsedAt:string|null;requests30d:number;activeDays30d:number};
type ClientItem={id:string;name:string;active:boolean;createdAt:string};
type Verification={user_code:string;requested_scope:Scope;clientName:string};
const time=(value:string|null)=>value?new Date(value).toLocaleString("ko-KR"):"—";
export default function AgentCredentials({api,identity,onExpired,section}:{api:OperationalApi;identity:Identity;onExpired:()=>void;section:"agents"|"integrations"}){
 const [keys,setKeys]=useState<KeyItem[]>([]),[clients,setClients]=useState<ClientItem[]>([]),[adminKeys,setAdminKeys]=useState<KeyItem[]>([]);
 const [ready,setReady]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [name,setName]=useState(""),[scope,setScope]=useState<Scope>("read"),[days,setDays]=useState(90);
 const [clientName,setClientName]=useState(""),[busy,setBusy]=useState(false),[secret,setSecret]=useState(""),[confirmRevoke,setConfirmRevoke]=useState("");
 const [confirmDisable,setConfirmDisable]=useState("");
 const [adminReason,setAdminReason]=useState("관리자 보안 정책에 따른 키 폐기");
 const [code,setCode]=useState(""),[verification,setVerification]=useState<Verification|null>(null);
 const fail=useCallback((e:unknown)=>{
   if(e instanceof ApiError&&e.status===401){onExpired();return;}
   setError(e instanceof Error?e.message:"요청을 완료하지 못했습니다.");
 },[onExpired]);
 const load=useCallback(async()=>{
   setLoading(true);
   try{
     const [k,c,all]=await Promise.all([api.get<{items:KeyItem[]}>("/credentials/keys"),api.get<{items:ClientItem[]}>("/credentials/clients"),identity.spaceRole==="Admin"?api.get<{items:KeyItem[]}>("/credentials/admin/keys"):Promise.resolve({items:[]})]);
     setKeys(k.items);setClients(c.items);setAdminKeys(all.items);setReady(true);setError("");
   }catch(e){fail(e);}finally{setLoading(false);}
 },[api,fail,identity.spaceRole]);
 useEffect(()=>{void load();},[load]);
 const action=async(run:()=>Promise<void>)=>{
   setBusy(true);setError("");setNotice("");
   try{await run();await load();setNotice("변경 사항을 저장했습니다.");}catch(e){fail(e);}finally{setBusy(false);}
 };
 const createKey=(e:FormEvent)=>{e.preventDefault();void action(async()=>{
   const r=await api.post<{token:string}>("/credentials/keys",{name,scope,days});
   setSecret(r.token);setName("");
 });};
 const register=(e:FormEvent)=>{e.preventDefault();void action(async()=>{
   await api.post("/credentials/clients",{name:clientName});
   setClientName("");
 });};
 const verify=(e:FormEvent)=>{e.preventDefault();void action(async()=>{
   const value=code.replace(/[\s-]/g,"").toUpperCase();
   const r=await api.get<Verification>("/device/verify/"+encodeURIComponent(value));
   setVerification(r);setCode(value);
 });};
 const decide=(approve:boolean)=>{void action(async()=>{
   await api.post("/device/decision",{userCode:code,approve});
   setVerification(null);setCode("");
 });};
 if(!ready&&!loading)return <section className="op-panel" role="alert"><h2>에이전트 인증 연동을 사용할 수 없습니다</h2><p>{error||"서버 기능이 꺼져 있습니다."}</p><p>운영자는 AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED=true 와 SSO 철회 동기화를 설정해야 합니다. 목업으로 대체하지 않습니다.</p><Button onClick={()=>void load()}>재시도</Button></section>;
 return <div className="credentials-workbench">
  <section className="op-panel">
   <h2>{section==="agents"?"에이전트 API 키":"도구 연결 · Device Code"}</h2>
   <p className="muted">현재 지식 공간에만 적용됩니다. API 키는 최대 90일이며 발급 원문은 한 번만 표시합니다. 현재 공간 권한·키 폐기·만료를 매번 검사합니다.</p>
   {loading&&<p role="status">인증 연결 정보를 확인 중…</p>}
   {error&&<div role="alert" className="op-error">{error}</div>}
   {notice&&<p role="status" className="op-notice">{notice}</p>}
   {secret&&<div className="credential-secret" role="status"><h3>API 키 원문 · 1회 노출</h3><p>비밀 저장소에 보관하세요. 닫으면 복구할 수 없습니다.</p><code>{secret}</code><div className="credential-actions"><Button onClick={()=>void navigator.clipboard.writeText(secret)}>복사</Button><Button onClick={()=>setSecret("")}>저장했음 · 닫기</Button></div></div>}
  </section>
  {section==="agents"&&<><section className="op-panel">
   <h2>새 API 키 발급</h2>
   <form className="credential-form" onSubmit={createKey}>
    <label>키 이름<input value={name} onChange={e=>setName(e.target.value)} maxLength={100} required placeholder="Claude Code / CI"/></label>
    <label>권한 범위<select value={scope} onChange={e=>setScope(e.target.value as Scope)}><option value="read">읽기 · 검색/조회</option><option value="write">쓰기 · 질의/변경 제안 (승인·발행 제외)</option></select></label>
    <label>만료 (일)<input type="number" min={1} max={90} value={days} onChange={e=>setDays(Number(e.target.value))}/></label>
    <Button variant="primary" disabled={busy||!name.trim()||days<1||days>90}>키 발급</Button>
   </form></section>
   <section className="op-panel"><h2>내 API 키</h2>
   {keys.length===0?<p>발급한 키가 없습니다.</p>:<div className="credential-scroll" role="region" tabIndex={0} aria-label="API 키 목록, 가로 스크롤 가능"><table><caption>현재 공간에서 발급한 내 API 키</caption><thead><tr><th>이름·키 ID</th><th>권한·상태</th><th>발급·만료·마지막 사용</th><th>최근 30일</th><th>폐기</th></tr></thead><tbody>{keys.map(k=><tr key={k.id}><th scope="row"><strong>{k.name}</strong><small>{k.issuer} · {k.id} · ••••{k.suffix}</small></th><td>{k.scope==="read"?"읽기":"쓰기"} · {k.revokedAt?"폐기":new Date(k.expiresAt)<=new Date()?"만료":"활성"}</td><td><small>발급 {time(k.createdAt)}</small><small>만료 {time(k.expiresAt)}</small><small>마지막 {time(k.lastUsedAt)}</small></td><td>{k.requests30d}회 · {k.activeDays30d}일</td><td>{!k.revokedAt&&(confirmRevoke===k.id?<div><span>폐기할까요?</span><Button disabled={busy} onClick={()=>void action(async()=>{await api.post("/credentials/keys/"+k.id+"/revoke",{reason:"사용자가 키 폐기를 요청함"});setConfirmRevoke("");})}>확인</Button><Button onClick={()=>setConfirmRevoke("")}>취소</Button></div>:<Button disabled={busy} onClick={()=>setConfirmRevoke(k.id)}>폐기</Button>)}</td></tr>)}</tbody></table></div>}
   </section>
   {identity.spaceRole==="Admin"&&<section className="op-panel"><h2>공간 관리자 · 전체 API 키</h2><p>현재 공간에 속한 모든 사용자의 키를 확인하고 강제로 폐기할 수 있습니다. 발급 원문은 조회할 수 없습니다.</p>
     <label>관리자 폐기 사유<input value={adminReason} maxLength={500} onChange={e=>setAdminReason(e.target.value)}/></label>
     <div className="credential-scroll" tabIndex={0} role="region" aria-label="공간 전체 API 키"><table><thead><tr><th>발급자</th><th>키 / 이름</th><th>권한</th><th>마지막 사용</th><th>폐기</th></tr></thead><tbody>{adminKeys.map(k=><tr key={k.id}><td><code>{k.issuer}</code></td><th scope="row">{k.name}<small>{k.id}</small></th><td>{k.scope}</td><td>{time(k.lastUsedAt)}</td><td>{k.revokedAt?"폐기됨":<Button disabled={busy||adminReason.trim().length<5} onClick={()=>void action(async()=>{await api.post("/credentials/admin/keys/"+k.id+"/revoke",{reason:adminReason});})}>관리자 폐기</Button>}</td></tr>)}</tbody></table></div>
   </section>}
   <section className="op-panel"><h2>Device Code 연결 승인</h2><p>장치에서 받은 8자리 코드를 입력합니다. 클라이언트 이름과 요청 권한을 확인한 뒤 승인하세요.</p>
    <form className="credential-form" onSubmit={verify}><label>사용자 코드<input value={code} onChange={e=>{setCode(e.target.value.toUpperCase());setVerification(null);}} maxLength={11} placeholder="ABCDEFGH" autoComplete="off"/></label><Button disabled={busy||code.replace(/[\s-]/g,"").length!==8}>코드 확인</Button></form>
    {verification&&<div className="credential-confirm"><h3>장치 연결 요청</h3><p>클라이언트: <strong>{verification.clientName}</strong></p><p>요청 권한: <strong>{verification.requested_scope}</strong></p><p>신뢰하는 장치에서 직접 시작한 요청만 승인하세요.</p><Button disabled={busy} variant="primary" onClick={()=>decide(true)}>승인</Button><Button disabled={busy} onClick={()=>decide(false)}>거절</Button></div>}
   </section></>}
  {section==="integrations"&&<><section className="op-panel"><h2>연결 클라이언트 등록</h2>
    <form className="credential-form" onSubmit={register}><label>클라이언트 이름<input value={clientName} required maxLength={100} onChange={e=>setClientName(e.target.value)} placeholder="Mac mini OpenCode"/></label><Button variant="primary" disabled={busy||!clientName.trim()}>클라이언트 등록</Button></form>
   </section><section className="op-panel"><h2>내 연결 클라이언트</h2>{clients.length===0?<p>등록된 클라이언트가 없습니다.</p>:<div className="credential-scroll" role="region" tabIndex={0} aria-label="도구 연결 목록"><table><thead><tr><th>이름</th><th>클라이언트 ID</th><th>상태</th><th>조치</th></tr></thead><tbody>{clients.map(c=><tr key={c.id}><th scope="row">{c.name}</th><td><code>{c.id}</code></td><td>{c.active?"사용 가능":"비활성"}</td><td>{c.active&&(confirmDisable===c.id?<><Button disabled={busy} onClick={()=>void action(async()=>{await api.request("/credentials/clients/"+c.id,"DELETE",{});setConfirmDisable("");})}>연결·키 폐기 확인</Button><Button onClick={()=>setConfirmDisable("")}>취소</Button></>:<Button disabled={busy} onClick={()=>setConfirmDisable(c.id)}>비활성화</Button>)}</td></tr>)}</tbody></table></div>}
   </section><section className="op-panel"><h2>REST / MCP 연동 계약</h2><p>클라이언트 ID로 <code>POST /api/v1/device/authorize</code>를 호출하고 사용자 코드를 ‘에이전트 · 토큰’에서 승인합니다. 장치는 5초 간격으로 <code>POST /api/v1/device/token</code>을 폴링해 1회 API 키를 수령합니다.</p><p><code>Authorization: Bearer akh_sk_…</code> 헤더를 사용합니다. 읽기는 검색/조회, 쓰기는 질의·변경 제안으로 제한하며 사람의 승인·발행·관리는 금지합니다.</p><p>Device Code 8자리 · 만료 10분 · API 키 최대 90일. SSO 계정 차단은 별도 동기화가 필요합니다.</p></section></>}
 </div>;
}
