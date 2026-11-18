import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { sourceHashes } from '../2026-11-18-document-reader/manifest.mjs';

const dir = 'docs/ui-validation/2026-11-18-properties-bulk';
const logs = '.superpowers/sdd/2026-11-16-essential-convenience';
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const source = await sourceHashes();
const browser = JSON.parse(await readFile(dir + '/browser-results.json', 'utf8'));
const binding = { productionFingerprint: browser.productionFingerprint };

if (source.productionFingerprint !== browser.productionFingerprint) {
  const captureCommit = 'e474468c118906cd4cac7de36a3c08e0496142da';
  const captured = JSON.parse(execFileSync('git', ['show', captureCommit + ':' + dir + '/source-manifest.json'], {encoding:'utf8'}));
  const paths = new Set([...Object.keys(source.production), ...Object.keys(captured.production)]);
  const changed = [...paths].filter(path => source.production[path] !== captured.production[path]);
  if (captured.productionFingerprint !== browser.productionFingerprint ||
      changed.length !== 1 || changed[0] !== 'server/questions/search.ts') throw Error('Browser source mismatch');

  // The images, browser observations, fixtures and runtime all belong to the original capture.
  for (const [path,digest] of Object.entries(captured.evidence)) {
    if (path.startsWith(dir + '/') && /(?:\.png|\/(?:browser-results\.json|capture\.mjs|runtime\.ts|cleanup\.json))$/.test(path) &&
        await hash(path) !== digest) throw Error('Carried browser evidence mismatch: ' + path);
  }
  Object.assign(binding, { captureCommit, changedProductionFiles: changed });
}

if (process.argv.includes('--verify')) {
  const m = JSON.parse(await readFile(dir + '/source-manifest.json','utf8'));
  if (m.productionFingerprint !== source.productionFingerprint ||
      JSON.stringify(m.browserCapture) !== JSON.stringify(binding)) throw Error('Manifest provenance mismatch');
  for (const [path,digest] of Object.entries({...m.production,...m.evidence}))
    if (await hash(path) !== digest) throw Error('Evidence mismatch: ' + path);
  console.log('Verified current production, test evidence and browser capture provenance');
} else {
  const files = [
    ...(await readdir(dir)).filter(p => p !== 'source-manifest.json').map(p => dir+'/'+p),
    ...(await readdir(logs)).filter(p => /^c10-.*\.log$/.test(p)).map(p => logs+'/'+p),
    'server/convenience/bulk.test.ts','server/convenience/bulk-migration.test.ts','server/workflows/bulk.test.ts',
    'src/operational/convenience/bulk.test.tsx','src/operational/workflows-reader.test.tsx','src/operational/BulkEditor.test.tsx',
    'server/jobs/maintenance-runtime.test.ts','server/questions/service.test.ts','docs/ui-validation/2026-11-18-document-reader/manifest.mjs',
  ];
  const evidence = Object.fromEntries(await Promise.all(files.sort().map(async p=>[p,await hash(p)])));
  await writeFile(dir+'/source-manifest.json',JSON.stringify({generatedAt:new Date().toISOString(),base:'29a892b06b1edc089ffab678835a46a936241306',...source,browserCapture:binding,evidence},null,2)+'\n');
  console.log('Bound current production, test evidence and browser capture provenance');
}
