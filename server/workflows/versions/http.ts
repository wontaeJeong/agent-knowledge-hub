import {z} from "zod";
import type {Context} from "../../service";
import type {VersionService} from "./service";
/** Host authenticates identity, selected space, bounded JSON and CSRF first. Service always has a mandatory authorizer. */
export async function handleVersionRoute(input:{method:string;path:string;body:unknown;ctx:Context;send:(status:number,body:unknown)=>void;query?:URLSearchParams},service:VersionService):Promise<boolean>{
 const {method,path,body,ctx,send}=input;if(!path.startsWith("/api/v1/versions/"))return false;
 const route=path.slice("/api/v1/versions".length),reply=(value:unknown,status=200)=>{send(status,value);return true;};
 const offset=z.coerce.number().int().min(0).max(100000).parse(input.query?.get("offset")??0);
 if(method==="GET"){
  if(route==="/bundles")return reply(await service.bundles(ctx,offset));
  const p=route.match(/^\/pages\/([a-zA-Z0-9_-]{1,100})\/(history|metadata-events|\d+)$/);
  if(p)return reply(p[2]==="history"?await service.history(ctx,p[1],offset):p[2]==="metadata-events"?await service.metadataHistory(ctx,p[1],offset):await service.version(ctx,p[1],z.coerce.number().int().positive().parse(p[2])));
 }
 if(method==="POST"){
  const p=route.match(/^\/pages\/([a-zA-Z0-9_-]{1,100})\/compare$/);
  if(p){const d=z.object({from:z.number().int().positive(),to:z.number().int().positive(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(250).optional()}).strict().parse(body);return reply(await service.compareVersions(ctx,p[1],d.from,d.to,d));}
  if(route==="/decisions/preview")return reply(await service.previewDecision(ctx,body));
  if(route==="/decisions")return reply(await service.decideSelection(ctx,body),201);
  if(route==="/restore/preview")return reply(await service.previewRestore(ctx,body));
  if(route==="/restore/propose")return reply(await service.proposeRestoreSelection(ctx,body),201);
  const comment=route.match(/^\/comments\/([a-zA-Z0-9_-]{1,100})\/anchor$/);
  if(comment){const d=z.object({targetVersion:z.number().int().positive()}).strict().parse(body);return reply(await service.resolveCommentAnchor(ctx,comment[1],d.targetVersion));}
 }
 return false;
}
