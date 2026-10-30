import { useState } from "react";
import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { Button } from "../ui/primitives";

export interface ConsoleRow {
  id: string;
  search: string;
  cells: ReactNode[];
}
export function ConsoleTable({
  caption,
  columns,
  rows,
  select,
}: {
  caption: string;
  columns: string[];
  rows: ConsoleRow[];
  select?: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const filtered = rows.filter((r) =>
    r.search.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const lastPage = Math.max(0, Math.ceil(filtered.length / 25) - 1);
  const current = Math.min(page, lastPage);
  return (
    <>
      <div className="console-table-tools">
        <label>
          <Search size={17} />
          <input
            type="search"
            aria-label={`${caption} 검색`}
            placeholder="이름, 상태, 식별자로 검색"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <span>{filtered.length}건 · 최대 25건씩 표시</span>
      </div>
      <div
        className="op-table-scroll"
        role="region"
        tabIndex={0}
        aria-label={`${caption} · 가로 스크롤 가능`}
      >
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th scope="col" key={c}>
                  {c}
                </th>
              ))}
              {select && <th scope="col">상세</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(current * 25, (current + 1) * 25).map((row) => (
              <tr key={row.id}>
                {row.cells.map((cell, i) =>
                  i === 0 ? (
                    <th scope="row" key={i}>
                      {cell}
                    </th>
                  ) : (
                    <td key={i}>{cell}</td>
                  ),
                )}
                {select && (
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => select(row.id)}
                      aria-label={`${row.search.split(" · ")[0]} 상세`}
                    >
                      상세 보기
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!filtered.length && (
        <p className="console-empty">
          일치하는 항목이 없습니다. 검색 조건을 바꿔보세요.
        </p>
      )}
      {filtered.length > 25 && (
        <div className="op-actions">
          <Button disabled={current === 0} onClick={() => setPage(current - 1)}>
            이전 25건
          </Button>
          <span>
            {current + 1} / {lastPage + 1}
          </span>
          <Button
            disabled={current === lastPage}
            onClick={() => setPage(current + 1)}
          >
            다음 25건
          </Button>
        </div>
      )}
    </>
  );
}
