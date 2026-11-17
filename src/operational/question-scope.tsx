import { useId } from "react";
export type QuestionScopeValue = {
  topic: string;
  historical: boolean;
  from: string;
  to: string;
};
export function serializeQuestionScope(value: QuestionScopeValue) {
  return {
    ...(value.topic ? { topic: value.topic } : {}),
    historical: value.historical,
    ...(value.historical && value.from
      ? { periodFrom: value.from + "T00:00:00.000Z" }
      : {}),
    ...(value.historical && value.to
      ? { periodTo: value.to + "T23:59:59.999Z" }
      : {}),
  };
}
export function QuestionScopeFields({
  value,
  topics,
  onChange,
}: {
  value: QuestionScopeValue;
  topics: string[];
  onChange: (v: QuestionScopeValue) => void;
}) {
  const topicOptions = useId();
  return (
    <fieldset className="op-query-scope">
      <legend>질문 범위</legend>
      <label>
        주제
        <input
          aria-label="주제"
          list={topicOptions}
          value={value.topic}
          placeholder="모든 주제"
          onChange={(e) => onChange({ ...value, topic: e.target.value })}
        />
        <datalist id={topicOptions}>
          {topics.map((topic) => (
            <option key={topic} value={topic} />
          ))}
        </datalist>
      </label>
      <label>
        조회 시점
        <select
          aria-label="조회 시점"
          value={value.historical ? "historical" : "current"}
          onChange={(e) =>
            onChange({ ...value, historical: e.target.value === "historical" })
          }
        >
          <option value="current">현재 권고 발행본</option>
          <option value="historical">과거 발행 기록</option>
        </select>
      </label>
      {value.historical && (
        <>
          <p>
            발행 기록 기간(UTC)입니다. 내용의 사실상 유효 기간과는 다르며, 과거
            속성이 없으면 알 수 없음으로 처리합니다.
          </p>
          <label>
            시작일
            <input
              type="date"
              value={value.from}
              max={value.to || undefined}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
            />
          </label>
          <label>
            종료일
            <input
              type="date"
              value={value.to}
              min={value.from || undefined}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
            />
          </label>
        </>
      )}
    </fieldset>
  );
}
