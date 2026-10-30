import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "./service";
import { transaction } from "./database";
import { audit, membership } from "./repository";

const postId=z.string().uuid();
const text=(max:number)=>z.string().trim().min(1).max(max);
const create=z.object({kind:z.enum(["notice","internal","voc"]),visibility:z.enum(["team","private"]),title:text(160),body:text(20000)}).strict();
const edit=z.object({revision:z.number().int().positive(),title:text(160).optional(),body:text(20000).optional(),status:z.enum(["open","in_progress","resolved"]).optional(),pinned:z.boolean().optional()}).strict().refine(x=>Object.keys(x).some(k=>k!=="revision"));
const comment=z.object({body:text(10000),internal:z.boolean().default(false)}).strict();
type Post={id:string;workspace_id:string;author_id:string;kind:"notice"|"internal"|"voc";visibility:"team"|"private";revision:number};
const result=(status:number,body:unknown)=>({status,body});
async function access(db:PoolClient,ctx:Context){
 const role=await membership(db,ctx);
 const managed=await db.query("SELECT access_role(workspace_id,$2) AS role FROM access_spaces WHERE workspace_id=$1",[ctx.workspaceId,ctx.principalId]);
 const manager=managed.rowCount?managed.rows[0].role==="Admin":role==="reviewer";
 return {reviewer:role==="reviewer",manager};
}
function readable(row:Post,ctx:Context,reviewer:boolean){
 if(row.visibility==="private"&&row.author_id!==ctx.principalId)return false;
 if(row.kind==="internal"&&!reviewer)return false;
 return true;
}
async function getPost(db:PoolClient,ctx:Context,id:string,reviewer:boolean,lock=false):Promise<Post>{
 const row=await db.query("SELECT * FROM board_posts WHERE workspace_id=$1 AND id=$2"+(lock?" FOR UPDATE":""),[ctx.workspaceId,id]);
 if(!row.rowCount||!readable(row.rows[0],ctx,reviewer))throw Error("NOT_FOUND");
 return row.rows[0] as Post;
}
/** All reads and changes are checked against CURRENT space membership, not client-supplied roles. */
export async function handleBoardRequest(
 pool:Pool,ctx:Context,method:string,path:string,body:unknown,params:URLSearchParams
):Promise<{status:number;body:unknown}|null>{
 const name=path.replace(/^\/api\/v1\/board\//,"");
 if(name==="posts"&&method==="GET")return transaction(pool,ctx.workspaceId,async db=>{
  const {reviewer}=await access(db,ctx);
  const offset=z.coerce.number().int().min(0).max(100000).parse(params.get("offset")??"0");
  const kind=params.get("kind");
  if(kind&&!["notice","internal","voc"].includes(kind))throw Error("VALIDATION_FAILED");
  const q=await db.query(
   "SELECT p.id,p.author_id AS \"authorId\",p.kind,p.visibility,p.title,p.status,p.pinned,p.revision,p.created_at AS \"createdAt\",p.updated_at AS \"updatedAt\",(r.read_at IS NULL) AS unread FROM board_posts p LEFT JOIN board_reads r ON r.workspace_id=p.workspace_id AND r.post_id=p.id AND r.principal_id=$2 WHERE p.workspace_id=$1 AND ($3::boolean OR p.kind<>'internal') AND (p.visibility='team' OR p.author_id=$2) AND ($4::text IS NULL OR p.kind=$4) ORDER BY p.pinned DESC,p.created_at DESC,p.id LIMIT 51 OFFSET $5",
   [ctx.workspaceId,ctx.principalId,reviewer,kind||null,offset]);
  return result(200,{items:q.rows.slice(0,50),hasMore:q.rows.length>50,offset});
 });
 if(name==="posts"&&method==="POST"){
  const b=create.parse(body);
  return transaction(pool,ctx.workspaceId,async db=>{
   await ctx.authorization?.assertSession(db);
   const {reviewer,manager}=await access(db,ctx);
   if(b.kind==="notice"&&!manager||b.kind==="internal"&&!reviewer||b.kind!=="voc"&&b.visibility==="private")throw Error("FORBIDDEN");
   const id=randomUUID();
   await db.query("INSERT INTO board_posts(workspace_id,id,author_id,kind,visibility,title,body) VALUES($1,$2,$3,$4,$5,$6,$7)",[ctx.workspaceId,id,ctx.principalId,b.kind,b.visibility,b.title,b.body]);
   await audit(db,ctx,"board.create",id);
   return result(201,{id});
  },{principalId:ctx.principalId,operation:"board.create"});
 }
 const m=/^posts\/([a-f0-9-]{36})(?:\/(comments|read))?$/.exec(name);
 if(!m)return null;
 const id=postId.parse(m[1]);
 if(method==="GET"&&!m[2])return transaction(pool,ctx.workspaceId,async db=>{
  const {reviewer}=await access(db,ctx);
  const post=await getPost(db,ctx,id,reviewer);
  const comments=await db.query("SELECT id,author_id AS \"authorId\",body,internal,created_at AS \"createdAt\" FROM board_comments WHERE workspace_id=$1 AND post_id=$2 AND ($3::boolean OR NOT internal) ORDER BY created_at,id",[ctx.workspaceId,id,reviewer]);
  return result(200,{...post,comments:comments.rows});
 });
 if(method==="POST"&&m[2]==="read")return transaction(pool,ctx.workspaceId,async db=>{
  await ctx.authorization?.assertSession(db);
  const {reviewer}=await access(db,ctx);
  await getPost(db,ctx,id,reviewer);
  await db.query("INSERT INTO board_reads(workspace_id,post_id,principal_id) VALUES($1,$2,$3) ON CONFLICT(workspace_id,post_id,principal_id) DO UPDATE SET read_at=clock_timestamp()",[ctx.workspaceId,id,ctx.principalId]);
  return result(200,{ok:true});
 });
 if(method==="POST"&&m[2]==="comments"){
  const b=comment.parse(body);
  return transaction(pool,ctx.workspaceId,async db=>{
   await ctx.authorization?.assertSession(db);
   const {reviewer}=await access(db,ctx);
   await getPost(db,ctx,id,reviewer);
   if(b.internal&&!reviewer)throw Error("FORBIDDEN");
   const commentId=randomUUID();
   await db.query("INSERT INTO board_comments(workspace_id,post_id,id,author_id,body,internal) VALUES($1,$2,$3,$4,$5,$6)",[ctx.workspaceId,id,commentId,ctx.principalId,b.body,b.internal]);
   await audit(db,ctx,"board.comment",id);
   return result(201,{id:commentId});
  },{principalId:ctx.principalId,operation:"board.comment"});
 }
 if(method==="PATCH"&&!m[2]){
  const b=edit.parse(body);
  return transaction(pool,ctx.workspaceId,async db=>{
   await ctx.authorization?.assertSession(db);
   const {reviewer,manager}=await access(db,ctx);
   const post=await getPost(db,ctx,id,reviewer,true);
   if(post.revision!==b.revision)throw Error("STALE_VERSION");
   const canEdit=post.kind==="notice"?manager:post.kind==="internal"?reviewer:(post.author_id===ctx.principalId||manager);
   if(!canEdit)throw Error("FORBIDDEN");
   if((b.status!==undefined||b.pinned!==undefined)&&!manager)throw Error("FORBIDDEN");
   await db.query("UPDATE board_posts SET title=COALESCE($3,title),body=COALESCE($4,body),status=COALESCE($5,status),pinned=COALESCE($6,pinned),revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,b.title??null,b.body??null,b.status??null,b.pinned??null]);
   await audit(db,ctx,"board.update",id);
   return result(200,{id,revision:post.revision+1});
  },{principalId:ctx.principalId,operation:"board.update"});
 }
 return null;
}
