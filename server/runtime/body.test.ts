import { expect, test } from "vitest";
import { readJsonBody } from "./body";
test("preserves raw Korean source text when UTF-8 characters span network chunks", async () => {
  const value = { content: "원본 근거와 권한을 보존합니다. 🔒" };
  const wire = Buffer.from(JSON.stringify(value));
  async function* chunks() {
    for (let i = 0; i < wire.length; i++) yield wire.subarray(i, i + 1);
  }
  expect(await readJsonBody(chunks(), 512000)).toEqual(value);
});
test("bounds accumulated bytes before accepting a JSON request", async () => {
  async function* chunks() {
    yield Buffer.from('{"text":"');
    yield Buffer.alloc(30, 97);
    yield Buffer.from('"}');
  }
  await expect(readJsonBody(chunks(), 20)).rejects.toThrow("INPUT_TOO_LARGE");
});
test("invalid JSON remains a validation failure", async () => {
  async function* chunks() {
    yield Buffer.from("{");
  }
  await expect(readJsonBody(chunks(), 20)).rejects.toThrow("VALIDATION_FAILED");
});
