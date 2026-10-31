import {mkdir,realpath,lstat} from 'node:fs/promises';
import {isAbsolute,resolve,relative} from 'node:path';
import type {Pool} from 'pg';
import type {WorkflowAuthorizer} from '../workflows/service';
import {OperationsService,operationsRoutes,operationsAuthorizer,PhysicalDeletionStore} from '../operations';
import {createFileAuditTarget} from './audit-target';
export async function createOperationalHost(options:{pool:Pool;authorize:WorkflowAuthorizer;contentRoot:string;env?:NodeJS.ProcessEnv}){
  const env=options.env??process.env,root=env.AKH_AUDIT_ROOT,key=env.AUDIT_EXPORT_KEY,signingKey=env.AUDIT_SIGNING_KEY;
  if(!root||!isAbsolute(root)||!key||!signingKey||key.length<32||signingKey.length<32||key===signingKey)throw Error('OPERATIONAL_SECRET_CONFIGURATION');
  const content=await realpath(options.contentRoot),auditRoot=resolve(root);
  const contains=(a:string,b:string)=>{const path=relative(a,b);return path===''||(!path.startsWith('..')&&!isAbsolute(path));};
  if(contains(content,auditRoot)||contains(auditRoot,content))throw Error('AUDIT_CONTENT_ROOT_OVERLAP');
  await mkdir(auditRoot,{recursive:true,mode:0o700});
  if((await lstat(auditRoot)).isSymbolicLink()||await realpath(auditRoot)!==auditRoot)throw Error('UNSAFE_STORAGE_ROOT');
  const audit=createFileAuditTarget({pool:options.pool,root:auditRoot,contentRoot:content,encryptionKey:key,signingKey});
  const service=new OperationsService(options.pool,operationsAuthorizer(options.authorize,{adminAuditMetadataExport:env.AKH_ADMIN_AUDIT_METADATA_EXPORT_ENABLED==='true'}),{physicalDeletionGateConfirmed:true});
  const deletion=new PhysicalDeletionStore(content);
  return {service,audit,route:operationsRoutes(service,{encryptionKey:key,signingKey,archiveTarget:audit.target,readAnchor:id=>audit.readAnchor(id),anchor:(name,body,fence)=>audit.anchor(name,body,fence)},deletion)};
}
