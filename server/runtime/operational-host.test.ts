import {test,expect} from 'vitest';
import {mkdtemp,mkdir,rm,realpath,readFile,chmod,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fixture,adoptFixture} from '../test-support';
import {authorizeInTransaction} from '../access/index';
import {audit} from '../repository';
import {transaction} from '../database';
import {createOperationalHost} from './operational-host';
test('production operational bootstrap supplies actual independent audit and physical-deletion adapters',async()=>{
  const f=await fixture();await adoptFixture(f.pool,f.workspaceId);
  const root=await realpath(await mkdtemp('/private/var/folders/s0/kkh09qs52bv52h5n4nf4d2fw0000gq/T/opencode/ops-host-'));
  const contentRoot=join(root,'content'),auditRoot=join(root,'audit');await mkdir(contentRoot);await mkdir(auditRoot);
  const env={AKH_AUDIT_ROOT:auditRoot,AUDIT_EXPORT_KEY:randomBytes(32).toString('hex'),AUDIT_SIGNING_KEY:randomBytes(32).toString('hex'),AKH_ADMIN_AUDIT_METADATA_EXPORT_ENABLED:'true'};
  try{
    const host=await createOperationalHost({pool:f.pool,authorize:authorizeInTransaction,contentRoot,env});
    expect(host.service.options.physicalDeletionGateConfirmed).toBe(true);
    const ctx={workspaceId:f.workspaceId,principalId:'fixture-owner'};
    await transaction(f.pool,f.workspaceId,db=>audit(db,ctx,'host.integration','fixture'));
    let status:number|undefined,body:unknown;
    expect(await host.route({method:'POST',path:'/api/v1/operations/audit/export',ctx,body:{confirm:'EXPORT_ENCRYPTED_AUDIT'},send:(s,b)=>{status=s;body=b;}})).toBe(true);
    expect(status).toBe(200);expect(body).toMatchObject({anchored:true,head:{sequence:'2'}});
    const anchored=await host.audit.readAnchor(f.workspaceId);expect(anchored).toBeTruthy();expect(anchored).not.toContain('host.integration');
    await expect(createOperationalHost({pool:f.pool,authorize:authorizeInTransaction,contentRoot,env:{...env,AKH_AUDIT_ROOT:contentRoot}})).rejects.toThrow();
    await expect(createOperationalHost({pool:f.pool,authorize:authorizeInTransaction,contentRoot,env:{...env,AUDIT_SIGNING_KEY:env.AUDIT_EXPORT_KEY}})).rejects.toThrow();
    expect(await readFile(join(auditRoot,`HEAD-${f.workspaceId}.json`),'utf8')).not.toContain(env.AUDIT_SIGNING_KEY);
  }finally{await f.pool.end();await rm(root,{recursive:true,force:true});}
});
test('fsGroup-style writable PVC root is rejected, while its app-owned private child starts safely',async()=>{
  const f=await fixture(),root=await realpath(await mkdtemp('/private/var/folders/s0/kkh09qs52bv52h5n4nf4d2fw0000gq/T/opencode/ops-pvc-'));
  const contentRoot=join(root,'content'),mount=join(root,'audit');await mkdir(contentRoot);await mkdir(mount);await chmod(mount,0o2770);
  const env={AKH_AUDIT_ROOT:mount,AUDIT_EXPORT_KEY:randomBytes(32).toString('hex'),AUDIT_SIGNING_KEY:randomBytes(32).toString('hex')};
  try{
    await expect(createOperationalHost({pool:f.pool,authorize:authorizeInTransaction,contentRoot,env})).rejects.toThrow('AUDIT_ROOT_UNSAFE_PERMISSIONS');
    const host=await createOperationalHost({pool:f.pool,authorize:authorizeInTransaction,contentRoot,env:{...env,AKH_AUDIT_ROOT:join(mount,'private')}});
    expect(host.service.options.physicalDeletionGateConfirmed).toBe(true);expect((await stat(join(mount,'private'))).mode&0o077).toBe(0);
  }finally{await f.pool.end();await rm(root,{recursive:true,force:true});}
});
