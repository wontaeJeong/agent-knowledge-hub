import { useEffect, useState } from "react";
import { BrandIcon, type BrandIconName } from "../ui/BrandIcon";
import { BrandMark } from "../ui/BrandMark";
import { demoHref, workspaceHref } from "../entry";
import "./landing.css";

const examples = [
  {
    label: "Memory",
    title: "다음 대화에 필요한 맥락을 기억합니다.",
    description:
      "“이 팀은 배포 이슈를 다루고 있고, 운영과 스테이징 환경이 다르다.” 같은 맥락을 다음 대화에 활용합니다.",
    items: ["대화 이력과 팀의 맥락", "지난 시도와 사용자의 선호"],
    takeaway: "이어지는 대화에 필요한 기억",
  },
  {
    label: "RAG",
    title: "질문과 관련된 기록을 찾아 답합니다.",
    description:
      "“지난주 배포가 왜 느렸지?”라는 질문에 관련 대화와 로그를 검색하고, 찾은 근거로 답변합니다.",
    items: ["관련 대화·로그의 검색 결과", "검색한 근거를 바탕으로 한 답변"],
    takeaway: "지금 질문에 필요한 근거 검색",
  },
  {
    label: "Wiki",
    title: "다음 업무에서 다시 쓸 가이드를 갱신합니다.",
    description:
      "기존 ‘배포 지연 대응’ 가이드와 비교해 변경을 제안합니다. 새 근거와 적용 조건을 검토한 뒤 발행하고, 다음 업무에서 활용합니다.",
    items: [
      "수정 제안: 운영 환경의 지연 원인과 확인 절차",
      "조건: 운영 클러스터 / 스테이징은 별도 확인",
      "근거: 원본 대화·실행 로그 / 이전 판단도 보존",
    ],
    takeaway: "기존 지식과 연결해 유지하는 업무 자산",
  },
];

const loop: {
  icon: BrandIconName;
  label: string;
  title: string;
  text: string;
}[] = [
  {
    icon: "ingest",
    label: "01 · INGEST",
    title: "기존 지식과 연결",
    text: "대화·문서·업무 결과를 읽고, 관련 주제와 개념에 반영할 변경을 제안합니다.",
  },
  {
    icon: "check",
    label: "02 · REVIEW",
    title: "근거를 보고 발행",
    text: "원본, 변경 이유, 적용 조건을 확인합니다. 검토한 변경을 새 버전으로 남깁니다.",
  },
  {
    icon: "query",
    label: "03 · QUERY",
    title: "사람과 에이전트가 재사용",
    text: "발행된 지식을 찾아 읽고 질문합니다. 인용한 버전과 근거를 따라갈 수 있습니다.",
  },
  {
    icon: "lint",
    label: "04 · LINT & FEEDBACK",
    title: "결과로 다시 갱신",
    text: "빠진 연결과 상충을 점검합니다. 새 질문과 성공·실패 경험은 다음 변경 후보가 됩니다.",
  },
];

function initialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem("agent-knowledge-hub.theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // System preference still applies when storage is blocked.
  }
  try {
    return matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

export default function LandingPage() {
  const [selected, setSelected] = useState(2);
  const [theme, setTheme] = useState(initialTheme);
  const example = examples[selected];

  // Keep root design tokens (and favicon) aligned with this page's theme.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="landing" data-theme={theme}>
      <a className="landing-skip" href="#landing-main">
        본문으로 이동
      </a>
      <header className="landing-header">
        <a
          className="landing-brand"
          href="/"
          aria-label="agent-knowledge-hub 소개 홈"
        >
          <BrandMark size={34} />
          <span>agent-knowledge-hub</span>
        </a>
        <nav className="landing-nav" aria-label="서비스 소개">
          <a href="#why-wiki">왜 Wiki인가</a>
          <a href="#how-it-works">작동 방식</a>
          <a href="#landing-faq">FAQ</a>
        </nav>
        <div className="landing-header-actions">
          <button
            className="landing-theme"
            type="button"
            aria-label={
              theme === "dark" ? "라이트 테마로 전환" : "다크 테마로 전환"
            }
            onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              setTheme(next);
              try {
                localStorage.setItem("agent-knowledge-hub.theme", next);
              } catch {
                /* Theme works without storage. */
              }
            }}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <a className="landing-link-button" href={workspaceHref}>
            지식 공간 열기 <BrandIcon name="outcome" size={16} />
          </a>
        </div>
      </header>

      <main id="landing-main">
        <section
          className="landing-hero landing-container"
          aria-labelledby="landing-title"
        >
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">
              <span /> KNOWLEDGE THAT COMPOUNDS
            </p>
            <h1 id="landing-title">
              대화와 업무 결과를,
              <br />
              <em>다음에 다시 쓸 수 있는</em>
              <br />
              지식으로.
            </h1>
            <p className="landing-lead">
              새 자료를 기존 지식과 연결하고, 근거와 적용 조건을 검토하며
              갱신하는 위키. 사람도 에이전트도 같은 지식에서 다음 일을
              시작합니다.
            </p>
            <div className="landing-actions">
              <a className="landing-link-button primary" href={workspaceHref}>
                지식 공간 시작하기 <BrandIcon name="outcome" size={18} />
              </a>
              <a className="landing-text-link" href={demoHref}>
                합성 데이터로 둘러보기 <span aria-hidden="true">↗</span>
              </a>
            </div>
            <p className="landing-caption">
              지식 공간은 조직 로그인 · 데모는 계정 없이 체험
            </p>
          </div>
          <div
            className="landing-preview"
            aria-label="원본이 연결된 지식으로 바뀌는 개념 예시"
          >
            <div className="landing-preview-bar">
              <span>
                <BrandIcon name="workspace" size={15} /> 지식이 쌓이는 공간
              </span>
              <small>개념 예시 · 합성 자료</small>
            </div>
            <div className="landing-source-strip">
              <BrandIcon name="source" size={19} />
              <div>
                <strong>일주일치 팀 대화 + 실행 로그</strong>
                <span>새 자료를 기존 가이드와 비교</span>
              </div>
              <span className="landing-chip">원본 보존</span>
            </div>
            <div className="landing-preview-connector">
              <span /> 변경 제안 → 검토 → 발행 <span />
            </div>
            <article className="landing-wiki-card">
              <div className="landing-card-label">
                <span>
                  <BrandIcon name="book" size={15} /> WIKI / 운영 가이드
                </span>
                <span className="landing-chip">갱신 예시</span>
              </div>
              <h2>배포 지연 대응 가이드</h2>
              <p>어떤 환경에서, 무엇을 확인해야 하는가?</p>
              <dl>
                <div>
                  <dt>새 근거</dt>
                  <dd>운영 환경의 실행 로그와 팀 대화</dd>
                </div>
                <div>
                  <dt>적용 조건</dt>
                  <dd>운영 클러스터 · 스테이징 별도 확인</dd>
                </div>
                <div>
                  <dt>남은 질문</dt>
                  <dd>다른 환경에서도 같은 원인인가?</dd>
                </div>
              </dl>
              <div className="landing-related">
                <BrandIcon name="link" size={15} />
                <span>배포 절차</span>
                <span>환경별 차이</span>
                <span>장애 회고</span>
              </div>
            </article>
            <div className="landing-preview-footer">
              <BrandIcon name="history" size={15} />
              <span>새 경험과 반증이 생기면 다시 갱신</span>
            </div>
          </div>
        </section>

        <section
          className="landing-premise landing-container"
          aria-label="위키의 가치"
        >
          <p>
            “이거 지난번에도 해결했는데,
            <br />
            <strong>어디에 어떤 조건으로 정리했지?</strong>”
          </p>
          <div>
            <p>
              대화는 흘러가고, 답변은 흩어집니다. 위키에는 결론뿐 아니라{" "}
              <strong>이유·근거·예외</strong>를 함께 남깁니다.
            </p>
            <p>
              새 자료가 들어오면 기존 판단을 다시 살피고, 다음 업무에 활용할 수
              있도록 연결합니다.
            </p>
          </div>
        </section>

        <section
          id="why-wiki"
          className="landing-section landing-container"
          aria-labelledby="comparison-title"
        >
          <p className="landing-eyebrow">MEMORY · RAG · WIKI</p>
          <h2 id="comparison-title">
            기억하고, 찾아내고,
            <br />
            연결된 지식으로 발전시키고.
          </h2>
          <p className="landing-section-intro">
            서로 다른 역할입니다. agent-knowledge-hub는 근거를 가진 지식을
            지속적으로 유지하는 데 초점을 둡니다.
          </p>
          <div
            className="landing-table-wrap"
            role="region"
            aria-label="Memory RAG Wiki 역할 비교"
            tabIndex={0}
          >
            <p className="landing-table-hint">
              좌우로 스크롤해 세 역할을 비교하세요.
            </p>
            <table className="landing-comparison">
              <caption>대표적인 사용 방식 비교</caption>
              <thead>
                <tr>
                  <th scope="col">구분</th>
                  <th scope="col">Memory</th>
                  <th scope="col">RAG</th>
                  <th scope="col">LLM Wiki</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">핵심 질문</th>
                  <td>무엇을 기억해야 하지?</td>
                  <td>관련 근거가 어디 있지?</td>
                  <td>현재 지식을 어떻게 갱신하지?</td>
                </tr>
                <tr>
                  <th scope="row">주요 역할</th>
                  <td>대화·선호·과거 상태의 기억</td>
                  <td>관련 자료 검색과 답변 지원</td>
                  <td>기존 주제·결론·조건·연결의 유지</td>
                </tr>
                <tr>
                  <th scope="row">주로 남기는 것</th>
                  <td>다음 대화에 쓸 맥락</td>
                  <td>검색 색인과 질의별 답변</td>
                  <td>근거와 버전을 가진 연결된 지식</td>
                </tr>
                <tr>
                  <th scope="row">새 자료가 오면</th>
                  <td>기억을 추가하거나 갱신</td>
                  <td>검색 대상을 추가하거나 갱신</td>
                  <td>기존 결론·예외·관계의 변경 검토</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="landing-note">
            제품을 배타적으로 나눈 표가 아닙니다. Memory와 RAG도 종합·갱신
            기능을 갖출 수 있고, Wiki도 검색과 Memory를 함께 사용할 수 있습니다.
            차이는 어느 기술을 쓰느냐보다, 무엇을 지속적으로 관리하느냐에
            있습니다.
          </p>
        </section>

        <section
          className="landing-example-section"
          aria-labelledby="example-title"
        >
          <div className="landing-container landing-example-grid">
            <div>
              <p className="landing-eyebrow">ONE INPUT, DIFFERENT ROLES</p>
              <h2 id="example-title">
                똑같은 일주일치 대화.
                <br />
                무엇이 남을까요?
              </h2>
              <p className="landing-section-intro">
                배포 지연을 조사한 팀의 대화와 로그를 넣었다고 가정해 보세요.
              </p>
              <div className="landing-example-input">
                <BrandIcon name="source" size={20} />
                <p>
                  “운영에서는 지연이 재현됐어요.”
                  <br />
                  “스테이징 결과와는 조건이 달라요.”
                  <br />
                  “확인 절차를 가이드에 반영하죠.”
                </p>
              </div>
              <p className="landing-caption">
                역할 차이를 설명하는 합성 예시 · 실제 처리 결과 아님
              </p>
            </div>
            <div className="landing-example-output">
              <div
                className="landing-example-options"
                role="group"
                aria-label="같은 자료를 활용하는 방식 선택"
              >
                {examples.map((item, index) => (
                  <button
                    key={item.label}
                    type="button"
                    aria-pressed={selected === index}
                    aria-controls="landing-example-result"
                    onClick={() => setSelected(index)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div
                id="landing-example-result"
                role="region"
                aria-label="선택한 방식의 결과 예시"
                aria-live="polite"
                aria-atomic="true"
              >
                <p className="landing-eyebrow">{example.label}</p>
                <h3>{example.title}</h3>
                <p>{example.description}</p>
                <ul>
                  {example.items.map((item) => (
                    <li key={item}>
                      <BrandIcon name="check" size={15} />
                      {item}
                    </li>
                  ))}
                </ul>
                <div className="landing-example-takeaway">
                  {example.takeaway}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          id="how-it-works"
          className="landing-section landing-container"
          aria-labelledby="loop-title"
        >
          <p className="landing-eyebrow">A LIVING KNOWLEDGE LOOP</p>
          <h2 id="loop-title">
            한 번 정리한 다음에도,
            <br />
            계속 돌보는 지식.
          </h2>
          <p className="landing-section-intro">
            원본은 보존하고, 위키를 갱신하고, 유지 규칙에 따라 점검합니다.
            유용한 질문 결과도 근거를 연결한 변경 후보로 돌아옵니다.
          </p>
          <ol className="landing-loop">
            {loop.map((step) => (
              <li key={step.label}>
                <BrandIcon name={step.icon} size={25} />
                <span>{step.label}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
          <p className="landing-note">
            현재 점검은 구조와 명시된 사실을 중심으로 수행합니다. 자연어 전반의
            모순 탐지, 무인 유지관리와 후속 업무 효과 검증은 확장 목표입니다.
            답변의 재편입은 새로운 독립 증거를 만드는 일이 아닙니다.
          </p>
          <div className="landing-principles">
            <div>
              <BrandIcon name="evidence" size={20} />
              <h3>근거와 조건을 함께</h3>
              <p>
                결론을 읽고 원본까지 따라갈 수 있도록. 검토 승인을 사실의 진위
                보장으로 여기지 않습니다.
              </p>
            </div>
            <div>
              <BrandIcon name="lock" size={20} />
              <h3>개인에서 팀으로, 권한 안에서</h3>
              <p>
                로컬은 저장 위치, 개인·팀은 소유와 공유의 범위입니다. 파생
                지식도 원본 권한을 지키는 것이 설계 원칙입니다.
              </p>
            </div>
            <div>
              <BrandIcon name="hub" size={20} />
              <h3>사람과 에이전트가 함께</h3>
              <p>
                사람은 웹에서 탐색하고 검토합니다. 에이전트는 API·MCP를 통해
                같은 지식 순환에 참여합니다.
              </p>
            </div>
          </div>
        </section>

        <section
          id="landing-faq"
          className="landing-section landing-container landing-faq"
          aria-labelledby="faq-title"
        >
          <div>
            <p className="landing-eyebrow">GOOD QUESTIONS</p>
            <h2 id="faq-title">시작하기 전에.</h2>
          </div>
          <div>
            <details>
              <summary>
                채팅 내용을 요약해 저장하는 것과 무엇이 다른가요?
              </summary>
              <p>
                요약은 개별 자료의 내용을 줄입니다. 이 위키가 지향하는 편입은
                기존 주제·개념·가이드와 비교해 결론, 조건, 연결을 함께 바꾸는
                일입니다. 원본과 변경 이유는 별도로 남깁니다.
              </p>
            </details>
            <details>
              <summary>RAG나 Memory를 대체하나요?</summary>
              <p>
                함께 사용할 수 있습니다. Memory는 필요한 맥락을 유지하고, RAG는
                관련 근거를 찾는 데 쓰입니다. 위키는 그 위에서 종합한 지식을
                유지·갱신하는 역할에 집중합니다.
              </p>
            </details>
            <details>
              <summary>AI가 쓴 내용이 자동으로 공식 지식이 되나요?</summary>
              <p>
                변경 제안과 발행을 구분합니다. 근거와 적용 조건을 검토하며,
                승인만으로 진실이 보장되지는 않습니다. 상충이나 근거 부족은 남겨
                두고 다시 검증해야 합니다.
              </p>
            </details>
            <details>
              <summary>데스크톱 앱을 설치해야 하나요?</summary>
              <p>
                웹에서 원본을 등록하고, 편입을 제안하고, 검토·질문·점검을 할 수
                있습니다. 로컬 파일 연동은 별도 커넥터의 역할입니다. 이 소개
                페이지와 합성 데모는 설치 없이 열립니다.
              </p>
            </details>
          </div>
        </section>

        <section
          className="landing-start landing-container"
          aria-labelledby="start-title"
        >
          <BrandIcon name="book" size={30} />
          <h2 id="start-title">
            다음 일을 위한 지식,
            <br />
            지금부터 쌓아보세요.
          </h2>
          <p>먼저 흐름을 둘러보거나, 조직의 지식 공간으로 이동하세요.</p>
          <div className="landing-actions">
            <a className="landing-link-button primary" href={workspaceHref}>
              지식 공간 열기 <BrandIcon name="outcome" size={18} />
            </a>
            <a className="landing-link-button" href={demoHref}>
              합성 데모 체험
            </a>
          </div>
          <p className="landing-start-status">
            현재 제공: 원본 등록 · 편입 제안 · 검토와 발행 · 인용 질문 · 점검
            <br />
            지식 공간은 조직 계정으로 이용하며, 모델 기반 편입은 조직의 모델
            연결이 필요합니다. 합성 데모는 이 브라우저에 저장됩니다.
          </p>
        </section>
      </main>
      <footer className="landing-footer landing-container">
        <a className="landing-brand" href="/">
          <BrandMark size={26} />
          <span>agent-knowledge-hub</span>
        </a>
        <span>Knowledge that compounds.</span>
        <a href="#landing-title">맨 위로 ↑</a>
      </footer>
    </div>
  );
}
