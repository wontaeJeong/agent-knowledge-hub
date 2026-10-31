import {createHash} from "node:crypto";
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
export interface Anchor {id:string;hash:string;startLine:number;endLine:number;beforeHash:string|null;afterHash:string|null;stable:boolean;kind:"paragraph"|"code"|"table"|"bounded-tail"}
export function segmentAnchors(pageId:string,number:number,content:string,previous:Anchor[]=[]):{mode:"exact"|"bounded";anchors:Anchor[]} {
 const lines=content.split("\n"),parts:{hash:string;startLine:number;endLine:number;kind:Anchor["kind"]}[]=[];
 for(let i=0;i<lines.length;){if(!lines[i].trim()){i++;continue;}const start=i;let kind:Anchor["kind"]="paragraph";
  if(parts.length>=999){i=lines.length;kind="bounded-tail";}
  else if(/^\s*(```|~~~)/.test(lines[i])){kind="code";const fence=lines[i].match(/(```+|~~~+)/)![0];i++;while(i<lines.length){if(lines[i].trim().startsWith(fence)){i++;break;}i++;}}
  else {kind=lines[i].includes("|")?"table":"paragraph";while(i<lines.length&&lines[i].trim()&&!(/^\s*(```|~~~)/.test(lines[i])&&i!==start))i++;}
  parts.push({hash:hash(lines.slice(start,i).join("\n")),startLine:start+1,endLine:i,kind});
 }
 const count=(items:{hash:string}[],h:string)=>items.filter(a=>a.hash===h).length;
 const anchors:Anchor[]=parts.map((p,i)=>{
  const beforeHash=parts[i-1]?.hash??null,afterHash=parts[i+1]?.hash??null;
  // Duplicate equal paragraphs never acquire identity by quote/order alone.
  const singleton=count(parts,p.hash)===1&&count(previous,p.hash)===1;
  const old=singleton?previous.find(a=>a.hash===p.hash&&a.stable):undefined;
  return {...p,beforeHash,afterHash,stable:p.kind!=="bounded-tail"&&count(parts,p.hash)===1,id:old?.id??`a-${hash(`${pageId}\0${number}\0${i}\0${p.hash}\0${beforeHash}\0${afterHash}`).slice(0,32)}`};
 });
 return {mode:parts.some(p=>p.kind==="bounded-tail")?"bounded":"exact",anchors};
}
export function resolveAnchor(original:Anchor,target:Anchor[]) {
 const same=target.find(a=>a.id===original.id&&a.hash===original.hash&&a.stable&&original.stable);
 if(same)return {status:same.startLine===original.startLine?"unchanged":"moved",resolved:true,target:same} as const;
 if(target.some(a=>a.hash===original.hash))return {status:"ambiguous",resolved:false,target:null} as const;
 const before=original.beforeHash?target.filter(a=>a.hash===original.beforeHash):[],after=original.afterHash?target.filter(a=>a.hash===original.afterHash):[];
 const start=original.beforeHash===null?-1:before.length===1?target.indexOf(before[0]):-2;
 const end=original.afterHash===null?target.length:after.length===1?target.indexOf(after[0]):-2;
 if(start>=-1&&end>=0&&end>start){if(end===start+1)return {status:"deleted",resolved:false,target:null} as const;if(end===start+2)return {status:"changed",resolved:false,target:target[start+1]} as const;}
 return {status:"unresolved",resolved:false,target:null} as const;
}
export interface DiffLine {kind:"equal"|"add"|"delete";text:string;fromLine:number|null;toLine:number|null}
/** Bounded Myers; falls back to an explicit full replace window, never drops lines. */
export function compareText(before:string,after:string):{mode:"exact"|"bounded";lines:DiffLine[];fromCount:number;toCount:number} {
 const a=before.split("\n"),b=after.split("\n");let steps=0;const trace:Map<number,number>[]=[];let v=new Map<number,number>([[1,0]]);
 if(a.length+b.length<=4000)for(let d=0;d<=Math.min(a.length+b.length,300);d++){
  trace.push(new Map(v));
  for(let k=-d;k<=d;k+=2){if(++steps>200000)break;let x=k===-d||(k!==d&&(v.get(k-1)??-1)<(v.get(k+1)??-1))?(v.get(k+1)??0):(v.get(k-1)??0)+1,y=x-k;
   while(x<a.length&&y<b.length&&a[x]===b[y]){x++;y++;if(++steps>200000)break;}v.set(k,x);
   if(x>=a.length&&y>=b.length){const result:DiffLine[]=[];let ax=a.length,by=b.length;
    for(let depth=d;depth>=0;depth--){const prior=trace[depth],diag=ax-by,prev=diag===-depth||(diag!==depth&&(prior.get(diag-1)??-1)<(prior.get(diag+1)??-1))?diag+1:diag-1,px=prior.get(prev)??0,py=px-prev;
     while(ax>px&&by>py){result.push({kind:"equal",text:a[ax-1],fromLine:ax,toLine:by});ax--;by--;}
     if(depth===0)break;if(ax===px){result.push({kind:"add",text:b[by-1],fromLine:null,toLine:by});by--;}else{result.push({kind:"delete",text:a[ax-1],fromLine:ax,toLine:null});ax--;}
    }
    return {mode:"exact",lines:result.reverse(),fromCount:a.length,toCount:b.length};
   }
  }if(steps>200000)break;
 }
 let prefix=0,suffix=0;while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
 while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
 const lines:DiffLine[]=[];for(let i=0;i<prefix;i++)lines.push({kind:"equal",text:a[i],fromLine:i+1,toLine:i+1});
 for(let i=prefix;i<a.length-suffix;i++)lines.push({kind:"delete",text:a[i],fromLine:i+1,toLine:null});
 for(let i=prefix;i<b.length-suffix;i++)lines.push({kind:"add",text:b[i],fromLine:null,toLine:i+1});
 for(let i=0;i<suffix;i++)lines.push({kind:"equal",text:a[a.length-suffix+i],fromLine:a.length-suffix+i+1,toLine:b.length-suffix+i+1});
 return {mode:"bounded",lines,fromCount:a.length,toCount:b.length};
}
