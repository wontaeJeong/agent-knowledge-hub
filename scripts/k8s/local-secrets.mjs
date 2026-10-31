import { randomBytes } from "node:crypto";
/** Local synthetic testing only. Source-level approval remains a separate explicit operation. */
export function localModelPolicyRegistry(env){
  if(env.AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION!=='true'||!env.AGENT_KNOWLEDGE_HUB_LLM_BASE_URL||!env.AGENT_KNOWLEDGE_HUB_LLM_MODEL)return {AKH_MODEL_DESTINATIONS_JSON:'[]'};
  try{
    const base=new URL(env.AGENT_KNOWLEDGE_HUB_LLM_BASE_URL);
    if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw Error();
    const url=base.href.replace(/\/$/,'')+'/chat/completions';
    return {AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID:'local-model',AKH_MODEL_DESTINATIONS_JSON:JSON.stringify([{id:'local-model',url,purposes:['query','ingest','organize','semantic-lint'],classifications:['synthetic'],active:true}])};
  }catch{throw Error('POLICY_CONFIGURATION');}
}
const secretNames = [
  "AKH_METRICS_TOKEN",
  "AUDIT_EXPORT_KEY",
  "AUDIT_SIGNING_KEY",
  "AGENT_KNOWLEDGE_HUB_BACKUP_KEY",
];
const decode = (value) =>
  value === undefined
    ? undefined
    : new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(value, "base64"),
      );
export function localOperationalSecrets(encoded) {
  const result = {};
  try {
    for (const name of secretNames) {
      const old = decode(encoded[name]);
      if (
        old !== undefined &&
        (old.length < 32 || old.length > 4096 || old.includes("\0"))
      )
        throw Error();
      result[name] = old ?? randomBytes(32).toString("base64url");
    }
    const id = decode(encoded.BACKUP_KEY_ID) ?? "local-v1";
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(id) ||
      ["__proto__", "constructor", "prototype"].includes(id)
    )
      throw Error();
    result.BACKUP_KEY_ID = id;
    const previous = decode(encoded.BACKUP_KEYS_JSON),
      ring = previous ? JSON.parse(previous) : {};
    if (
      !ring ||
      Array.isArray(ring) ||
      typeof ring !== "object" ||
      Object.keys(ring).length > 128
    )
      throw Error();
    for (const [name, key] of Object.entries(ring))
      if (
        !/^[a-zA-Z0-9_-]{1,100}$/.test(name) ||
        ["__proto__", "constructor", "prototype"].includes(name) ||
        typeof key !== "string" ||
        key.length < 32 ||
        key.length > 4096
      )
        throw Error();
    if (
      Object.hasOwn(ring, id) &&
      ring[id] !== result.AGENT_KNOWLEDGE_HUB_BACKUP_KEY
    )
      throw Error();
    result.BACKUP_KEYS_JSON = JSON.stringify({
      ...ring,
      [id]: result.AGENT_KNOWLEDGE_HUB_BACKUP_KEY,
    });
  } catch {
    throw Error("OPERATIONAL_SECRET_CONFIGURATION");
  }
  if (
    new Set(secretNames.map((name) => result[name])).size !== secretNames.length
  )
    throw Error("OPERATIONAL_KEY_SEPARATION");
  return result;
}
