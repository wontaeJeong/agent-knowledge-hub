import {useEffect,useState} from "react";
import type {OperationalApi,Identity} from "./api";
import {Button} from "../ui/primitives";
type Page={id:string;title:string};
type Result={pageId:string;version:number;provider:"systemone";model:string;score:number;threshold:number;needsReview:boolean;disclaimer:string};
export default function ModelAssessment({api,identity,pages,onExpired}:{api:OperationalApi;identity:Identity;pages:Page[];onExpired:()=>void}){
 const [pageId,setPageId]=useState(""),[result,setResult]=useState<Result|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[configured,setConfigured]=useState(false);
 useEffect(()=>{let live=true;void api.get<{systemone?:{configured:boolean}}>("/model").then(v=>{if(live)setConfigured(v.systemone?.configured===true);}).catch(()=>{});return()=>{live=false;};},[api]);
 const run=async()=>{setBusy(true);setError("");setResult(null);
  try{setResult(await api.post<Result>("/evaluations/systemone",{pageId}));}
  catch(e){if(e&&typeof e==="object"&&"status" in e&&e.status===401)onExpired();else setError(e instanceof Error?e.message:"모델 평가 실패");}
  finally{setBusy(false);}
 };
 return <section className="op-panel"><h2>SystemOne 근거 검토 보조</h2><p>현재 접근 가능한 발행 지식만 입력합니다. SystemOne의 확률 점수는 사람의 재검토 참고용이며 문서의 승인·발행·삭제를 자동으로 수행하지 않습니다.</p>
  {identity.role!=="reviewer"||identity.canReviewKnowledge===false?<p role="alert">현재 검토 권한이 없습니다.</p>:!configured?<p role="status">SystemOne 어댑터를 사용하도록 운영자가 명시적으로 설정하지 않았습니다.</p>:<>
  <label>평가할 발행 페이지<select value={pageId} onChange={e=>{setPageId(e.target.value);setResult(null);}}><option value="">페이지 선택</option>{pages.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
  <Button variant="primary" disabled={busy||!pageId} onClick={()=>void run()}>{busy?"분석 중…":"근거 재검토 요청"}</Button>
  {result&&<div role="status"><h3>평가 결과 · {result.needsReview?"추가 사람 검토 제안":"추가 검토 신호 미검출"}</h3><p>확률 점수 {result.score.toFixed(4)} / 임계값 {result.threshold.toFixed(4)}</p><p>{result.disclaimer}</p></div>}
  {error&&<p role="alert">{error}</p>}</>}
 </section>;
}
