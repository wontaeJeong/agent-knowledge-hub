import { expect, test, vi } from "vitest";
import { createServer } from "node:http";
import * as oidc from "openid-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture, source, adoptFixture } from "../test-support";
import { approveLocalTransmissionFixture } from "../policy/test-fixture";
import { RuntimeService } from "./knowledge";
import { RefinementService } from "../refinement/service";
import { authorizeInTransaction } from "../access/index";
import { createRuntimeHandler } from "./http";
import { OidcAuth, sessionHash } from "./auth";

// Loopback OIDC, provider HTTP, PostgreSQL and real SDK transport; synthetic observations are never execution proof.
test("HTTP and MCP ordinary ingest retain candidates and reviewer feedback through the real provider contract", async () => {
  const f = await fixture();
  // Browser startup performs parallel authenticated reads; keep this integration fixture above that fan-out.
  if (process.env.AKH_LINEAGE_SCREENSHOT_DIR)
    f.pool.options.max = Number(
      process.env.AKH_LINEAGE_SCREENSHOT_POOL_MAX ?? 20,
    );
  await adoptFixture(f.pool, f.workspaceId);
  const inputs: any[] = [],
    contracts: string[] = [];
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      input = JSON.parse(body.messages[1].content);
    inputs.push(input);
    contracts.push(body.messages[0].content);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        model: "synthetic-loopback",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                updates: [
                  {
                    id: "topic",
                    title: "주제",
                    summary: "시험 주제",
                    scope: "team",
                    content:
                      inputs.length > 2
                        ? "기존 내용\n조건별 재시도: 영구 오류 제외"
                        : "기존 내용\n조건별 재시도",
                    links: [],
                    facts: [],
                    sourceIds: [source.id],
                    baseVersion: 1,
                  },
                ],
                candidates: [
                  {
                    pageId: "topic",
                    key: "retry",
                    value: "조건별 재시도",
                    kind: "inference",
                    conditions: { os: "linux" },
                    exceptions: ["영구 오류 제외"],
                    validFrom: null,
                    validTo: null,
                    uncertainty: "원본 주장, 독립 검증 없음",
                    sourceId: source.id,
                    quote: "실패 시 재시도한다.",
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  const idp = createServer((req, res) => {
    const reviewer = req.headers.authorization?.includes("reviewer");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        sub: reviewer ? "reviewer" : "editor",
        groups: [reviewer ? "reviewers" : "writers"],
      }),
    );
  });
  await Promise.all(
    [model, idp].map(
      (s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r)),
    ),
  );
  const modelBase = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", modelBase);
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "synthetic-loopback");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID", "loopback-lineage");
  await approveLocalTransmissionFixture(
    f.pool,
    f.workspaceId,
    modelBase + "/chat/completions",
    ["ingest"],
    "loopback-lineage",
  );
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer },
    "client",
    "fixture-secret",
  );
  oidc.allowInsecureRequests(config);
  for (const who of ["editor", "reviewer"])
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,$3,'csrf',$3,$3,now()+interval '1 hour')",
      [sessionHash("lineage-" + who), f.workspaceId, who],
    );
  const runtime = new RuntimeService(f.pool);
  const handler = createRuntimeHandler({
    pool: f.pool,
    service: runtime,
    auth: new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
      writers: "editor",
      reviewers: "reviewer",
    }),
    origin: "http://localhost",
    workspaceId: f.workspaceId,
    refinement: new RefinementService(f.pool, authorizeInTransaction),
  });
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = (who = "editor") => ({
    Cookie: `akh_session=lineage-${who}`,
    Origin: "http://localhost",
    "X-CSRF-Token": "csrf",
    "Content-Type": "application/json",
  });
  const post = (path: string, data: unknown, who = "editor") =>
    fetch(base + "/api/v1" + path, {
      method: "POST",
      headers: headers(who),
      body: JSON.stringify(data),
    });
  const client = new Client({ name: "lineage-test", version: "1.0.0" });
  try {
    const response = await post("/ingest", {
      sourceIds: [source.id],
      mode: "model",
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const b = (await response.json()) as { id: string; hash: string };
    const queue = await fetch(base + "/api/v1/changesets", {
      headers: headers("reviewer"),
    });
    const queued = (await queue.json()) as { items: any[] };
    expect(queued.items[0].candidates[0]).toMatchObject({
      verifiedAt: null,
      location: { quote: "실패 시 재시도한다." },
    });
    expect(contracts[0]).toContain("Optionally return candidates");
    const rejected = await post(
      `/changesets/${b.id}/reject`,
      { hash: b.hash, reason: "Linux 예외 조건을 보완하세요" },
      "reviewer",
    );
    expect(rejected.status, await rejected.clone().text()).toBe(200);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: { headers: headers() },
      }),
    );
    await expect(
      client.callTool({
        name: "knowledge_ingest",
        arguments: { sourceIds: [source.id], mode: "model" },
      }),
    ).rejects.toThrow("REJECTED_PROPOSAL_UNCHANGED");
    expect(inputs[1].reviewFeedback[0].reason).toBe(
      "Linux 예외 조건을 보완하세요",
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("1");
    // When supplied, capture the actual app against these authenticated HTTP services.
    if (process.env.AKH_LINEAGE_SCREENSHOT_DIR) {
      const revised = await post("/ingest", {
        sourceIds: [source.id],
        mode: "model",
      });
      expect(revised.status, await revised.clone().text()).toBe(201);
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      let webHandler = handler;
      const web = createServer(async (req, res) => {
        const path = new URL(req.url!, "http://localhost").pathname;
        if (path.startsWith("/api/") || path === "/mcp")
          return webHandler(req, res);
        try {
          const file = path === "/" ? "index.html" : path.slice(1);
          if (file.includes("..")) throw Error("path");
          const bytes = await readFile(join(process.cwd(), "dist", file));
          res.setHeader(
            "Content-Type",
            file.endsWith(".js")
              ? "text/javascript"
              : file.endsWith(".css")
                ? "text/css"
                : "text/html",
          );
          res.end(bytes);
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
      await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
      webHandler = createRuntimeHandler({
        pool: f.pool,
        service: runtime,
        auth: new OidcAuth(f.pool, config, url, f.workspaceId, {
          writers: "editor",
          reviewers: "reviewer",
        }),
        origin: url,
        workspaceId: f.workspaceId,
        refinement: new RefinementService(f.pool, authorizeInTransaction),
      });
      const pw = await import(process.env.AKH_PLAYWRIGHT_MODULE!);
      const browser = await pw.chromium.launch({ headless: true });
      try {
        const context = await browser.newContext();
        await context.addCookies([
          { name: "akh_session", value: "lineage-reviewer", url },
        ]);
        for (const width of [1440, 390]) {
          const page = await context.newPage();
          const browserErrors: string[] = [];
          page.on("response", (r: any) => {
            if (r.status() >= 400)
              browserErrors.push(`${new URL(r.url()).pathname}:${r.status()}`);
          });
          await page.setViewportSize({ width, height: 1000 });
          expect(page.viewportSize()?.width).toBe(width);
          await page.goto(url + "/?app=1#review");
          try {
            await page
              .getByText("Linux 예외 조건을 보완하세요", { exact: false })
              .waitFor({ timeout: 5000 });
          } catch (error) {
            throw Error(
              `Browser ${width} ${browserErrors.join(",")}: ${await page.locator("body").innerText()}`,
              { cause: error },
            );
          }
          await page
            .locator("details")
            .filter({
              has: page.getByText("미검증 주장 후보 1개", { exact: true }),
            })
            .evaluateAll((details: HTMLDetailsElement[]) =>
              details.forEach((d) => (d.open = true)),
            );
          await page
            .getByText("관리 화면을 불러오는 중...", { exact: true })
            .waitFor({ state: "hidden" });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          await page.waitForLoadState("networkidle");
          await page.screenshot({
            path: join(
              process.env.AKH_LINEAGE_SCREENSHOT_DIR!,
              `lineage-${width}.png`,
            ),
            fullPage: true,
          });
          await page.close();
        }
        const correction = await post(
          `/workflows/sources/${source.id}/correct`,
          {
            id: "corrected-source",
            content: "영구 오류에는 재시도하지 않는다.",
            reason: "영구 오류 예외 보존",
          },
        );
        expect(correction.status, await correction.clone().text()).toBe(201);
        for (const width of [1440, 390]) {
          const page = await context.newPage();
          await page.setViewportSize({ width, height: 1000 });
          await page.goto(url + "/?app=1#refinement");
          await page.getByText(/재검토 요청 → 원본 근거로 재편입/).click();
          await page
            .getByText(/원본 정정: source-a → corrected-source/)
            .waitFor();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          await page.waitForLoadState("networkidle");
          await page.screenshot({
            path: join(
              process.env.AKH_LINEAGE_SCREENSHOT_DIR!,
              `correction-${width}.png`,
            ),
            fullPage: true,
          });
          await page.close();
        }
      } finally {
        await browser.close();
        await new Promise<void>((r) => web.close(() => r()));
      }
    }
  } finally {
    await client.close();
    await Promise.all(
      [server, model, idp].map(
        (s) => new Promise<void>((r) => s.close(() => r())),
      ),
    );
    await f.pool.end();
    vi.unstubAllEnvs();
  }
}, 60000);
