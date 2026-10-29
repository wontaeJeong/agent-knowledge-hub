import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
function derive(secret, salt) {
  if (typeof secret !== "string" || secret.length < 32)
    throw Error("BACKUP_KEY_MUST_BE_AT_LEAST_32_CHARACTERS");
  return scryptSync(secret, salt, 32);
}
export function sealBackup(body, secret) {
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(secret, salt), iv);
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  return JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm+scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
  });
}
export function openBackup(envelope, secret) {
  const d = JSON.parse(envelope);
  if (d.version !== 1 || d.algorithm !== "aes-256-gcm+scrypt")
    throw Error("INVALID_BACKUP_FORMAT");
  const salt = Buffer.from(d.salt, "base64"),
    iv = Buffer.from(d.iv, "base64"),
    tag = Buffer.from(d.tag, "base64");
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16)
    throw Error("INVALID_BACKUP_FORMAT");
  const cipher = createDecipheriv("aes-256-gcm", derive(secret, salt), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([
    cipher.update(Buffer.from(d.ciphertext, "base64")),
    cipher.final(),
  ]);
}
