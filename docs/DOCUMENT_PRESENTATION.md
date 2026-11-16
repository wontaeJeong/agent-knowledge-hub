# 문서 표시와 이미지 첨부

관련 요구사항: EDT-001/008/009. 원본·검토·발행본을 사람이 읽는 경험을 개선하며, Markdown을 읽기 화면의 DOM으로 다시 저장하지 않는다. 기존 지식·근거·버전·권한과 독립 검토를 유지한다. 지식 품질이나 에이전트 성능 향상은 평가 계약의 대조 실험 전 목표다.

## 지원 형식

- Markdown 표·코드·내부 링크와 불변 첨부 링크. 운영 문서·질문·고정 인용, 기존 데모가 공통 `src/ui/Markdown.tsx`를 사용한다. HTML 원문은 실행하지 않는다. 외부 이미지는 자동 요청하지 않고 미지원 표시를 남긴다.
- `$…$` 인라인 및 `$$…$$` 블록 수식. KaTeX의 MathML 출력만 사용해 외부 폰트/CDN을 요청하지 않는다. `trust:false`, `strict:error`, 문서당 128개·수식당 4000자·매크로 200회·크기 10em 제한. 실패한 수식은 코드로 표시한다.
- `mermaid` 코드 블록의 `flowchart`와 `sequenceDiagram`. 로컬 번들을 지연 로드하며 `securityLevel:strict`, HTML 라벨/자동 실행/클릭 바인딩 비활성, 문서당 10개·다이어그램당 10000자·연결 100개 제한. 설정 지시문·frontmatter·HTML·URL·이미지·아이콘·스타일·콜백 구문은 차단한다. 출력 SVG도 DOMPurify와 외부 참조 제거를 거치며 실패하면 원본 코드를 남긴다.
- PNG/JPEG/WebP 정지 이미지: 파일당 5 MiB, 최대 400만 화소, 한 변 4096px. 확장자·실제 디코더 형식·프레임 수와 전체 픽셀 디코딩을 검사한다. 손상·MIME 위장·과대 이미지·애니메이션·SVG는 거부하며 메타데이터/본문 URL을 만들지 않는다. 이 구조 검사는 바이러스 검사나 내용 진위 검증이 아니다.
- TXT/Markdown/JSON은 기존 제한된 일반 텍스트 미리보기다. PDF는 기존 검사 대기와 지정 검사 승인 경계를 유지한다. PDF 변환·추출·미리보기, GIF·SVG·임의 다이어그램 확장은 지원하지 않는다.

## 인증된 저장·표시 경로

기존 PUT `/api/v1/storage/blobs`와 교체 CAS/불변 버전/철회/현재 부모·전체 원본 상한 검사를 재사용한다. 이미지는 검증 후 `clean`으로 기록하지만 원본 바이트와 SHA256을 변경하지 않는다. `storage_blobs`와 기존 CAS 저장을 쓰므로 원본 스냅샷·가져오기·보존·물리 삭제 게이트 밖의 별도 공개 저장소가 없다.

GET `/api/v1/storage/blobs/:id/preview`는 기존 `FileReadAccess`를 거친다. 기존 논리 첨부/고정 버전 preview 경로도 같은 결과를 반환한다. 텍스트 DTO는 유지하며 이미지에는 `{render:"raster-image",mime,base64,width,height,sha256}`가 추가된다. 파일 I/O와 비동기 이미지 디코딩 뒤 세션·현재 ACL·철회/버전을 다시 확인한다. 실제 다운로드는 계속 `application/octet-stream` attachment·nosniff·no-store이며 실행 가능한 inline 원문 경로를 추가하지 않는다.

본문 이미지 이름을 선택하면 호스트의 현재 공간·세션 API가 preview를 조회한다. 읽은 검증 이미지에만 `data:` URL을 생성하며 외부 URL·공개 URL·브라우저 영속 캐시를 만들지 않는다. 부모·API·본문 변경과 실패 시 이전 미리보기를 버린다. 이미 전달된 바이트의 완전한 복사 방지는 보장할 수 없다.

이미지 연결 제안은 기존 검토 변경 집합에 `![파일명](/api/v1/storage/blobs/:immutableId)`를 추가한다. 원본 부모 첨부는 그 원본을 포함하는 명시 대상 페이지가 필요하다. 고정 공유의 공간 역할 없는 독자는 해당 공유 버전의 정확한 Markdown 이미지 토큰에 있는 **래스터 파일만** 기존 상한/공유 검사를 통과할 수 있다. 미래 head·코드/HTML 속 가짜 참조·다른 파일·철회된 공유에는 권한이 생기지 않는다.

가져온 `clean` 문자열로 새 이미지에 권한/검사 승인을 만들지 않는다. 기존 파일은 실제 등록 메타데이터·해시·현재 ACL이 일치해야 한다. 새 바이너리는 기존 격리/지정 검사 정책을 따른다. Markdown 표·코드·내부 링크·수식·Mermaid 원문은 내보내기→검토 가져오기에서도 보존한다.

## 근거와 한계

- 로컬 합성 PostgreSQL/HTTP/Chromium 회귀는 사내 SSO·실제 자료 보안 인수나 PDF 지원의 증거가 아니다.
- Mermaid는 선택된 코드 블록에만 로드된다. 라이브러리의 선택적 다이어그램 청크가 빌드 산출물에 포함되며 서버/Pod를 추가하지 않는다.
- 현재 고정 라이브러리 API 근거: [KaTeX 설정](https://katex.org/docs/options), [Mermaid API·보안](https://mermaid.js.org/config/usage.html), [Sharp 생성자/픽셀 제한](https://sharp.pixelplumbing.com/api-constructor/), [Sharp 메타데이터](https://sharp.pixelplumbing.com/api-input/). 직접 라이선스는 THIRD_PARTY_NOTICES와 원문 파일에 기록했다.
