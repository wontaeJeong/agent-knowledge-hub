import { expect, test, vi } from "vitest";
import { PreviewApi } from "./preview";
import type { Source } from "../domain/types";

test("preview core flow is isolated per instance and never requests a server", async () => {
  const network = vi.spyOn(globalThis, "fetch");
  try {
    const api = new PreviewApi();
    expect((await api.me()).workspaceId).toBe("preview-space");
    const initial = await api.get<{ items: Source[] }>("/sources");
    await api.post("/sources", {
      source: { ...initial.items[0], id: "preview-new", title: "직접 등록" },
      readers: [],
    });
    expect(
      (await api.get<{ items: Source[] }>("/sources")).items.some(
        (s) => s.id === "preview-new",
      ),
    ).toBe(true);
    expect(
      (await new PreviewApi().get<{ items: Source[] }>("/sources")).items.some(
        (s) => s.id === "preview-new",
      ),
    ).toBe(false);
    await expect(api.post("/admin/grant", {})).rejects.toThrow();
    await expect(
      api.post("/ingest", { sourceIds: [initial.items[0].id], mode: "model" }),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
test("preview cannot publish pending changes or fabricate a model call", async () => {
  const api = new PreviewApi();
  const { items } = await api.get<{ items: { id: string; hash: string }[] }>(
    "/changesets",
  );
  await expect(
    api.post(`/changesets/${items[0].id}/publish`, { hash: items[0].hash }),
  ).rejects.toThrow();
  await api.post(`/changesets/${items[0].id}/approve`, { hash: items[0].hash });
  await api.post(`/changesets/${items[0].id}/publish`, { hash: items[0].hash });
  expect(
    (await api.get<{ items: { status: string }[] }>("/changesets")).items[0]
      .status,
  ).toBe("published");
});
