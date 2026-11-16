/** All inputs must already be filtered by the server's current authorization. */
export type DiscoveryPage = {
  id: string;
  title: string;
  summary: string;
  version: number;
  links: string[];
  updatedAt: string;
};
export type DiscoveryCitation = { at: string; pageIds: string[] };
export type DiscoveryRank = {
  id: string;
  title: string;
  summary: string;
  version: number;
  links: number;
  recentLinks: number;
  citations: number;
};
export type DiscoveryReport = {
  scope: "self" | "workspace";
  from: string;
  to: string;
  timezone: "UTC";
  pages: number;
  links: number;
  citations: number;
  daily: { day: string; citations: number }[];
  mostCited: DiscoveryRank[];
  mostLinked: DiscoveryRank[];
  trending: DiscoveryRank[];
};

/** Citation means one answer referencing a page once, not an independent piece of evidence. */
export function discoveryMetrics(
  pages: DiscoveryPage[],
  answers: DiscoveryCitation[],
  now: Date,
  days: 7 | 14 | 30 | 90,
) {
  const from = new Date(now);
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - days + 1);
  const start = +from,
    end = +now;
  const ranks = new Map<string, DiscoveryRank>(
    pages.map((p) => [
      p.id,
      {
        id: p.id,
        title: p.title,
        summary: p.summary,
        version: p.version,
        links: 0,
        recentLinks: 0,
        citations: 0,
      },
    ]),
  );
  for (const source of pages) {
    const date = Date.parse(source.updatedAt);
    for (const targetId of new Set(source.links)) {
      const target = ranks.get(targetId);
      if (!target || source.id === targetId) continue;
      target.links++;
      if (date >= start && date <= end) target.recentLinks++;
    }
  }
  const daily = Array.from({ length: days }, (_, i) => {
    const date = new Date(start + i * 86_400_000);
    return { day: date.toISOString().slice(0, 10), citations: 0 };
  });
  const byDay = new Map(daily.map((d) => [d.day, d]));
  for (const answer of answers) {
    const time = Date.parse(answer.at);
    if (!(time >= start && time <= end)) continue;
    const day = byDay.get(new Date(time).toISOString().slice(0, 10));
    for (const id of new Set(answer.pageIds)) {
      const target = ranks.get(id);
      if (!target) continue;
      target.citations++;
      if (day) day.citations++;
    }
  }
  const values = [...ranks.values()];
  const tie = (a: DiscoveryRank, b: DiscoveryRank) =>
    a.title.localeCompare(b.title, "ko") || a.id.localeCompare(b.id);
  return {
    from: from.toISOString(),
    to: now.toISOString(),
    timezone: "UTC" as const,
    pages: pages.length,
    links: values.reduce((sum, item) => sum + item.links, 0),
    citations: values.reduce((sum, item) => sum + item.citations, 0),
    daily,
    mostCited: values
      .filter((p) => p.citations > 0)
      .sort((a, b) => b.citations - a.citations || tie(a, b))
      .slice(0, 10),
    mostLinked: values
      .filter((p) => p.links > 0)
      .sort((a, b) => b.links - a.links || tie(a, b))
      .slice(0, 10),
    trending: values
      .filter((p) => p.recentLinks > 0)
      .sort(
        (a, b) =>
          b.recentLinks - a.recentLinks || b.links - a.links || tie(a, b),
      )
      .slice(0, 10),
  };
}
