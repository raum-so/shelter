// @vitest-environment jsdom
import { useEffect } from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api, ApiError } from "@/api/client";
import { I18nProvider } from "@/i18n";
import type { SupabaseInstance } from "@/api/supabase-types";
import { SupabaseFunctions } from "./SupabaseFunctions";
vi.mock("@/components/editor/FunctionCodeEditor", () => ({
  default: function Editor(props: {
    value: string;
    label: string;
    onChange: (value: string) => void;
    onReady: (handle: unknown) => void;
  }) {
    useEffect(() => {
      props.onReady({
        validateSyntax: async () => 0,
        format: async () => {},
        focusProblem: () => {},
      });
      return () => props.onReady(null);
    }, []);
    return (
      <textarea
        aria-label={props.label}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    );
  },
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});
const instance: SupabaseInstance = {
  id: "sb_" + "a".repeat(32),
  name: "Workspace",
  version: "self-hosted/v0.8.3",
  apiUrl: "https://api.example.test",
  studioUrl: "https://studio.example.test",
  status: "running",
  databasePort: 5432,
  error: null,
  createdAt: "2026-10-01T00:00:00Z",
  settings: {
    functionsEnabled: true,
    siteUrl: "https://app.example.test",
    redirectUrls: [],
  },
  jobs: [],
  backups: [],
};
const active = {
  name: "hello",
  source: 'Deno.serve(() => new Response("from server"));',
  hash: "a".repeat(64),
  versionId: "sfv_current",
  versions: [
    {
      id: "sfv_current",
      hash: "a".repeat(64),
      origin: "deployed",
      createdAt: "2026-10-01T00:00:00Z",
      active: true,
    },
    {
      id: "sfv_old",
      hash: "b".repeat(64),
      origin: "deployed",
      createdAt: "2026-09-01T00:00:00Z",
      active: false,
    },
  ],
};
function mount() {
  vi.spyOn(api, "supabaseFunctionCatalog").mockResolvedValue({
    functions: [
      {
        name: "hello",
        versionId: active.versionId,
        hash: active.hash,
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ],
    syncedAt: "2026-10-01T00:00:00Z",
  });
  vi.spyOn(api, "supabaseRefreshFunctions").mockResolvedValue({
    jobId: "refresh",
  });
  vi.spyOn(api, "supabaseFunction").mockImplementation(
    async (_id, _name, versionId) =>
      versionId
        ? {
            ...active,
            source: 'Deno.serve(() => new Response("older version"));',
          }
        : active,
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const router = createMemoryRouter([
    {
      path: "/",
      element: <SupabaseFunctions instance={instance} busy={false} />,
    },
  ]);
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
it("loads actual server source and preserves the edited draft when a stale deployment is rejected", async () => {
  const user = mount();
  const deploy = vi
    .spyOn(api, "supabaseFunctions")
    .mockRejectedValue(
      new ApiError("Conflict", 409, { code: "FUNCTION_CHANGED" }),
    );
  await user.click(await screen.findByRole("button", { name: "hello" }));
  const editor = await screen.findByRole("textbox", {
    name: "Function source",
  });
  expect((editor as HTMLTextAreaElement).value).toBe(active.source);
  await user.clear(editor);
  await user.type(editor, 'Deno.serve(() => new Response("edited"));');
  await user.click(screen.getByRole("button", { name: "Deploy function" }));
  await waitFor(() =>
    expect(deploy).toHaveBeenCalledWith(instance.id, {
      name: "hello",
      source: 'Deno.serve(() => new Response("edited"));',
      expectedHash: active.hash,
    }),
  );
  expect(
    await screen.findByText(/This function changed on the server/),
  ).toBeTruthy();
  expect((editor as HTMLTextAreaElement).value).toContain('"edited"');
  await user.click(screen.getByRole("button", { name: "New function" }));
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect((editor as HTMLTextAreaElement).value).toContain('"edited"');
  await user.click(screen.getByRole("tab", { name: "Versions" }));
  await user.click(screen.getByRole("button", { name: "Remove function" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(await screen.findByText("Remove this endpoint?")).toBeTruthy();
});
it("loads a historical version as a draft and deploys it against the current server hash", async () => {
  const user = mount();
  const deploy = vi
    .spyOn(api, "supabaseFunctions")
    .mockResolvedValue({ jobId: "new-job" });
  await user.click(await screen.findByRole("button", { name: "hello" }));
  await screen.findByRole("textbox", { name: "Function source" });
  await user.click(screen.getByRole("tab", { name: "Versions" }));
  await user.click(
    screen
      .getAllByRole("button", { name: "Load as draft" })
      .find((button) => !(button as HTMLButtonElement).disabled)!,
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Function source",
        }) as HTMLTextAreaElement
      ).value,
    ).toContain("older version"),
  );
  await user.click(screen.getByRole("button", { name: "Deploy function" }));
  await waitFor(() =>
    expect(deploy).toHaveBeenCalledWith(instance.id, {
      name: "hello",
      source: 'Deno.serve(() => new Response("older version"));',
      expectedHash: active.hash,
    }),
  );
});
