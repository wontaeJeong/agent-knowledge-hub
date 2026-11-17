import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {sourceHashes} from '../2026-11-18-document-reader/manifest.mjs';
const dir='docs/ui-validation/2026-11-18-properties-bulk',logs='.superpowers/sdd/2026-11-16-essential-convenience';
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
if(process.argv.includes('--verify')){
 const m=JSON.parse(await readFile(dir+'/source-manifest.json','utf8'));
 for(const [p,h] of Object.entries({...m.production,...m.evidence}))if(await hash(p)!==h)throw Error('Evidence mismatch: '+p);
 console.log('Verified production and evidence hashes');
}else{
 const source=await sourceHashes(),browser=JSON.parse(await readFile(dir+'/browser-results.json','utf8'));
 if(source.productionFingerprint!==browser.productionFingerprint)throw Error('Browser source mismatch');
 const files=[...(await readdir(dir)).filter(p=>p!== 'source-manifest.json').map(p=>dir+'/'+p),...(await readdir(logs)).filter(p=>/^c10-.*\.log$/.test(p)).map(p=>logs+'/'+p),'server/convenience/bulk.test.ts','server/convenience/bulk-migration.test.ts','server/workflows/bulk.test.ts','src/operational/convenience/bulk.test.tsx','src/operational/workflows-reader.test.tsx','src/operational/BulkEditor.test.tsx','server/jobs/maintenance-runtime.test.ts','docs/ui-validation/2026-11-18-document-reader/manifest.mjs'];
 const evidence=Object.fromEntries(await Promise.all(files.sort().map(async p=>[p,await hash(p)])));
 await writeFile(dir+'/source-manifest.json',JSON.stringify({generatedAt:new Date().toISOString(),base:'29a892b06b1edc089ffab678835a46a936241306',...source,evidence},null,2)+'\n');
 console.log('Bound production and evidence hashes');
}
