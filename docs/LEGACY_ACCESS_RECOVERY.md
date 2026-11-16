# 미이관 공간의 3역할 호환과 증거 복구

이 경로는 명시적으로 5역할 공간으로 이관되지 않은 기존 공간의 업무 동작을 보존한다. 검증된 기존 membership은 현대 Team/Owner/관리 grant가 아니며 reviewer에게 Maintain이나 Admin을 부여하지 않는다. 현재 요청에는 서명된 OIDC 로그인과 매 요청의 UserInfo, 현재 역할의 상한과 세션 정책이 필요하다. DB에서 검토·발행할 때 기존 제안자와 승인자의 원래 증거, 현재 membership·활성·철회 여부와 현재 원본 독자 범위를 재검사한다. 과거 제안자에게 동시 로그인을 요구하지 않는다. 지정 검토·공식 기준의 별도 제품 정책과 운영 수용은 축소하지 않는다.

`migrate()`가 이전 001–009 DB를 010으로 넘기기 전에 membership·당시 같은 공간에서 인증된 세션의 subject·활성 주체를 잠금 아래 임시 증거로 고정한다. 113은 아직 `access_spaces`가 없는 공간만 보존하고, 과거 세션 subject와 새 OIDC issuer의 canonical SHA-256 일치를 요구한다. 같은 사람이 여러 subject로 기록되었거나 세션·활성 주체의 증거가 없는 행은 격리한다. membership 변경/삭제와 명시 이관은 호환 권한을 영구 철회하며 재로그인으로 복원하지 않는다. 사용자 위임 장기 토큰은 이 경로에서 발급하지 않고, 작업 큐는 검증된 부모 사람 세션에만 결합된 제한 자격을 사용한다.

이미 010이 실행되어 직전 증거 캡처가 없는 DB는 현재 `memberships`만으로 복원하지 않는다. 기록된 과거 subject와 신뢰된 서명자의 **이관 전 백업 진술**을 가진 운영자만 다음 오프라인 도구를 명시적으로 사용할 수 있다. 서명은 진술자의 출처와 바이트 무결성을 증명할 뿐 실제 백업의 독립적인 진위를 보장하지 않는다. 운영자는 백업, 서명키 및 설치 매핑을 별도로 확인해야 한다. 실제 회사 자료 수입은 이 개발 시험에서 실행하지 않았다.

1. 해당 DB에서 `SELECT installation_id FROM legacy_compat_installation WHERE singleton=true`로 발급된 설치 UUID를 확인하고, 운영 정책에서 이 설치의 기대 UUID와 Ed25519 공개키를 별도로 고정한다. DB 전체를 과거 시점으로 되돌린 복제본은 외부 불변 앵커 없이 원본 설치와 구별하거나 복원 전 철회를 복구할 수 없다. 백업 복구·독립 앵커 정책은 별도 운영 인수다.
2. UTF-8 JSON 원본의 정확한 바이트에 Ed25519 detached signature(64바이트)를 만든다. JSON은 `version: 1`, `statement: "pre-010-backup"`, `installationId`, 원본 백업 SHA-256 `backupHash`, UTC ISO 시각 `capturedAt`, `issuedAt`, `expiresAt`, `entries` 배열을 포함한다. 각 entry는 `workspaceId`, 64자리 `principalId`, `role` (`reader`/`editor`/`reviewer`), HTTPS `issuer`, `subject`를 포함한다. 서명 수명은 최대 7일이다. 키는 manifest에서 받지 않는다.
3. 신뢰된 운영 프로세스에서 `DATABASE_URL`, `LEGACY_MANIFEST_PATH`, `LEGACY_SIGNATURE_PATH`, `LEGACY_IMPORT_TRUSTED_ED25519_KEY`(SPKI PEM), `LEGACY_INSTALLATION_ID`를 명시한 뒤 `node --experimental-strip-types scripts/import-legacy-manifest.mts`를 실행한다. 도구는 서명·설치·시간·원본 hash 형식과 정확한 archived subject, canonical ID, 현재 일치하는 membership·활성 주체, 미이관·미철회를 원자적으로 검사한다. 첫 유효 수입 키의 지문을 DB에 고정하며 다른 키는 거절한다. 동일 진술 재시도는 중복 생성하지 않고 철회 이후의 재수입은 거절한다. 키 교체는 별도 운영 절차가 필요하며 이 도구가 자동 승인하지 않는다.

합성 회귀는 서명 변조, 다른 설치 ID, 만료, 키 교체, 재시도 및 역할 철회 후 재수입 거부를 포함한다. 회사의 실제 백업 진위·키 보관·운영자 승인 및 복원 체계는 검증하지 않았다.
