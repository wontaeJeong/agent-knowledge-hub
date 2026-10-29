"""Package committed source, an offline runnable build, icon pack and Git history."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / "release"
out.mkdir(parents=True, exist_ok=True)

def git(*args):
    return subprocess.check_output(["git", "-C", str(root), *args]).decode().strip()

if git("status", "--porcelain"):
    raise SystemExit("Commit the reviewed source before packaging.")
if not (root / "dist/index.html").is_file():
    raise SystemExit("Run npm run build first.")
bundle = out / "folio-wiki.bundle"
subprocess.run(["git", "-C", str(root), "bundle", "create", str(bundle), "--all"], check=True)
subprocess.run(["git", "-C", str(root), "bundle", "verify", str(bundle)], check=True)
icons = out / "folio-wiki-icons.zip"
with zipfile.ZipFile(icons, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted((root / "brand-kit").rglob("*")):
        if p.is_file():
            z.write(p, str(p.relative_to(root)))
entries = {}
for name in git("ls-files").splitlines():
    entries[f"folio-wiki/{name}"] = (root / name).read_bytes()
for p in sorted((root / "dist").rglob("*")):
    if p.is_file():
        entries[f"folio-wiki/demo-dist/{p.relative_to(root / 'dist')}"] = p.read_bytes()
entries[bundle.name] = bundle.read_bytes()
entries[icons.name] = icons.read_bytes()
entries["START_HERE.md"] = """# Folio Wiki 0.2 실행 데모

소스·빌드본·Git 이력·아이콘 팩·기준 239개와 핵심 순환 12개 요구사항을 포함합니다.

## 바로 실행

Node.js 22.12 이상에서:

```bash
cd folio-wiki
npm run demo
```

http://127.0.0.1:8080/#/compile 을 엽니다. 패키지는 의존성 설치 없이 실행됩니다.

원본 등록 → 선택 자료 편입 → 변경 집합 승인 → 전체 발행 → 질문 → 답변 재편입 → Weekly 점검을 시연하세요. 오프라인 모드는 구조 기반 편입·발행본 발췌·명시 사실 검사입니다. 실제 모델 연결은 .env.example과 docs/MODEL_SETUP.md를 따릅니다. 모델을 설정하지 않으면 호출하지 않습니다.

## Git 소스에서 개발

```bash
git clone folio-wiki.bundle folio-wiki-from-git
cd folio-wiki-from-git
npm ci
npm run dev
```

Git 번들은 main 이력을 보존합니다. 원격 푸시 상태와는 별개입니다. 소스에서 모델 연결로 실행하려면 npm run build 후 npm run demo를 사용하세요.

## 지침과 요구사항

- README.md, docs/DEMO.md: 실행과 시연
- docs/LLM_WIKI_CORE.md: 카파시 원전과의 관계 및 구현 범위
- AGENTS.md, CLAUDE.md: 앱 개발 에이전트 지침
- wiki/SCHEMA.md: 업무 지식 유지관리 에이전트 규칙
- docs/AGENT_INTERFACE.md: 향후 MCP 도구와 호출 정책
- docs/ROADMAP.md, docs/requirements/: 전체 기준과 이행표
- docs/UI_INTEGRATION.md: agent-admission-gate 재사용 경계
- folio-wiki-icons.zip: 별도 아이콘 팩

현재는 합성 데이터와 로컬 저장소 데모입니다. 실제 사내 모델 품질·SSO·서버 ACL·지속 DB·MCP·무인 일정·운영 복구는 미검증 또는 미구현이며 로드맵에 남겨두었습니다. Gate 소스 자체를 복사한 것은 아니며 UI 교체 경계를 제공합니다.
""".encode()
manifest = {
    "name": "folio-wiki", "version": "0.2.0-demo", "date": "2026-10-27",
    "commit": git("rev-parse", "HEAD"), "branch": git("branch", "--show-current"),
    "requirements": 251, "domain_tests": 28, "model_contract_tests": 5,
    "demo_only": True,
    "files": [{"path": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
              for name, content in sorted(entries.items())],
}
entries["MANIFEST.json"] = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
archive = out / "folio-wiki-demo-kit.zip"
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
    for name, content in sorted(entries.items()):
        z.writestr(name, content)
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for item in manifest["files"]:
        assert hashlib.sha256(z.read(item["path"])).hexdigest() == item["sha256"]
print(json.dumps({"archive": str(archive), "bytes": archive.stat().st_size, "commit": manifest["commit"], "files": len(entries)}))
