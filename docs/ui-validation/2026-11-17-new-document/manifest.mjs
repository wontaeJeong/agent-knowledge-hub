import {readFile,writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
const dir="docs/ui-validation/2026-11-17-new-document",file=dir+"/source-manifest.json",base="83b00f4aacb896fbe98667cdc4166ce52864f2de";
const digest=async p=>createHash("sha256").update(await readFile(p)).digest("hex");
if(process.argv.includes("--verify")){
 const manifest=JSON.parse(await readFile(file,"utf8"));for(const [p,hash] of Object.entries({...manifest.production,...manifest.harness,...manifest.artifacts}))if(await digest(p)!==hash)throw Error("Evidence hash mismatch: "+p);console.log(`Verified ${Object.keys(manifest.production).length} production paths, ${Object.keys(manifest.harness).length} harness paths, ${Object.keys(manifest.artifacts).length} artifacts`);
}else{
 const changed=[...new Set([...execFileSync("git",["diff","--name-only",base],{encoding:"utf8"}).trim().split("\n"),...execFileSync("git",["ls-files","--others","--exclude-standard"],{encoding:"utf8"}).trim().split("\n")])];
 const paths=changed.filter(p=>/^(server|src)\//.test(p)&&/\.(tsx?|sql|css)$/.test(p)&&!p.includes(".test."));const production=Object.fromEntries(await Promise.all(paths.sort().map(async p=>[p,await digest(p)])));
 const harness=Object.fromEntries(await Promise.all(["capture.mjs","composer-runtime.ts","manifest.mjs","draft-initialization.mjs","draft-distribution.mjs"].map(async p=>[dir+"/"+p,await digest(dir+"/"+p)])));
 const {readdir}=await import("node:fs/promises");const artifacts=Object.fromEntries(await Promise.all((await readdir(dir)).filter(p=>p.endsWith(".png")||["browser-results.json","draft-initialization.json","draft-distribution.json"].includes(p)).sort().map(async p=>[dir+"/"+p,await digest(dir+"/"+p)])));
 await writeFile(file,JSON.stringify({generatedAt:new Date().toISOString(),base,scope:"Exact changed production bytes, final capture harness and generated browser evidence; commit is the commit containing this manifest",production,harness,artifacts},null,2)+"\n");console.log(`Bound ${paths.length} production paths`);
}
