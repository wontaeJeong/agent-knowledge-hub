import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseAllDocuments} from 'yaml';
import {writeSite} from './prepare-site.mjs';
/** Exact site generator + real base, synthetic nonsecret settings only; never applies to a cluster. */
export async function operationalSiteFixture(appImage){
  const root=await mkdtemp(resolve('deploy/.ops-release-test-'));
  try{
    const config=JSON.parse(await readFile(new URL('../../deploy/fixtures/site-ci-prod.json',import.meta.url),'utf8'));
    writeSite({...config,appImage},root);
    return parseAllDocuments(execFileSync('kubectl',['kustomize',join(root,'prod')],{encoding:'utf8'})).map(document=>document.toJSON());
  }finally{await rm(root,{recursive:true,force:true});}
}
