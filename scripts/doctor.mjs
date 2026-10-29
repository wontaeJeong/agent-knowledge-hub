import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function diagnose({ nodeVersion, dependenciesInstalled }) {
  const [major, minor] = nodeVersion.split(".").map(Number);
  const supported = (major === 22 && minor >= 12) || major === 24;
  const messages = [
    supported
      ? `PASS Node ${nodeVersion}`
      : `FAIL Node ${nodeVersion}: Node 22.12+ (22.x) 또는 24.x LTS를 사용하세요 (.nvmrc: 24).`,
    dependenciesInstalled
      ? "PASS 개발 의존성 설치됨 (잠금 파일 동기화는 npm ci로 확인)"
      : "FAIL 개발 의존성 없음: 저장소 루트에서 npm ci를 실행하세요.",
  ];
  return { ok: supported && dependenciesInstalled, messages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = diagnose({
    nodeVersion: process.versions.node,
    dependenciesInstalled: ["vite", "vitest", "typescript"].every((name) =>
      existsSync(resolve("node_modules", name, "package.json")),
    ),
  });
  console.log(result.messages.join("\n"));
  console.log("모델 키·Docker는 기본 개발/검증에 필요하지 않습니다. 전체 검사: npm run check");
  process.exitCode = result.ok ? 0 : 1;
}
