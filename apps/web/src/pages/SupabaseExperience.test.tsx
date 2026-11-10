// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "@/i18n";
import { SupabaseSetup } from "@/components/services/SupabaseSetup";
import { SupabaseOverview } from "@/components/services/SupabaseOverview";
import type { SupabaseInstance } from "@/api/supabase-types";

beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function wrap(children: React.ReactNode, client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider>{children}</I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
function client() {
  const query = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  query.setQueryData(["supabase-connections"], {
    connections: [],
    projects: [
      {
        id: "prj_app",
        name: "Meine App",
        website: "https://app.example.com",
        urlVariable: "VITE_SUPABASE_URL",
        keyVariable: "VITE_SUPABASE_ANON_KEY",
        busy: false,
      },
    ],
  });
  query.setQueryData(
    ["cloudflare-zones"],
    [{ id: "zone", name: "example.com" }],
  );
  query.setQueryData(["smtp"], { configuration: null, verified: false });
  query.setQueryData(["supabase-readiness"], {
    status: "ready",
    checks: {
      memory: true,
      storage: true,
      cpu: true,
      network: true,
      docker: true,
      worker: true,
      cloudflare: true,
    },
  });
  return query;
}
it("sets up from an app with inferred domains and keeps advanced fields optional", async () => {
  const query = client(),
    submit = vi.fn(),
    user = userEvent.setup();
  render(wrap(<SupabaseSetup pending={false} onSubmit={submit} />, query));
  await user.selectOptions(screen.getByLabelText("App"), "prj_app");
  expect((screen.getByLabelText("Database name") as HTMLInputElement).value).toBe(
    "Meine App",
  );
  expect(screen.queryByLabelText("App connection address")).toBeNull();
  expect(screen.queryByLabelText("Domain")).toBeNull();
  expect(screen.queryByLabelText("Your app’s website")).toBeNull();
  expect(screen.queryByText("Still needed")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Create database" }));
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Meine App",
      apiHostname: "meine-app-db.example.com",
      studioHostname: "meine-app-studio.example.com",
      siteUrl: "https://app.example.com",
      connection: { projectId: "prj_app", replace: false },
    }),
  );
  query.clear();
});
it("shows actionable capacity problems and does not submit when creation is blocked", async () => {
  const query = client(),
    submit = vi.fn(),
    user = userEvent.setup();
  query.setQueryData(["supabase-readiness"], {
    status: "blocked",
    checks: {
      memory: false,
      storage: true,
      cpu: true,
      network: true,
      docker: true,
      worker: true,
      cloudflare: true,
    },
  });
  render(wrap(<SupabaseSetup pending={false} onSubmit={submit} />, query));
  await user.selectOptions(screen.getByLabelText("App"), "prj_app");
  expect(screen.getByText("More memory is needed")).toBeDefined();
  expect(
    (
      screen.getByRole("button", {
        name: "Create database",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  query.clear();
});
it.each(["missing", "stale"] as const)(
  "does not present a running instance as protected with %s backup evidence",
  (evidence) => {
    const query = client();
    const instance: SupabaseInstance = {
      id: "sb_demo",
      name: "Demo",
      version: "v1",
      apiUrl: "https://db.example.com",
      studioUrl: "https://studio.example.com",
      status: "running",
      databasePort: null,
      error: null,
      createdAt: new Date().toISOString(),
      settings: { siteUrl: "https://app.example.com", redirectUrls: [] },
      jobs: [],
      backups: [],
    };
    if (evidence === "stale")
      instance.backups = [
        {
          id: "fresh",
          status: "ready",
          version: "v1",
          sizeBytes: 1024,
          createdAt: new Date().toISOString(),
        },
        {
          id: "old",
          status: "ready",
          version: "v1",
          sizeBytes: 1024,
          createdAt: "2020-01-01T00:00:00Z",
          verification: {
            offsiteAt: "2020-01-01T00:00:00Z",
            restoredAt: "2020-01-01T00:00:00Z",
            checkedAt: null,
            error: null,
          },
        },
      ];
    query.setQueryData(["supabase-backup-policy", instance.id], {
      enabled: false,
    });
    render(
      wrap(
        <SupabaseOverview
          instance={instance}
          connections={[]}
          connectionsReady
          navigate={() => {}}
        />,
        query,
      ),
    );
    expect(screen.getByText("Set up connection")).toBeDefined();
    expect(screen.getByText("Review protection")).toBeDefined();
    if (evidence === "missing")
      expect(screen.getByText("Not tested")).toBeDefined();
    expect(screen.queryByText("Protected")).toBeNull();
    query.clear();
  },
);

it("explains missing setup information and keeps the domain choice when several are available", async () => {
  const query = client(), submit = vi.fn(), user = userEvent.setup();
  query.setQueryData(["cloudflare-zones"], [{ id: "one", name: "example.com" }, { id: "two", name: "example.org" }]);
  render(wrap(<SupabaseSetup pending={false} onSubmit={submit} />, query));
  expect(screen.getAllByText("Give your database a name").length).toBeGreaterThan(0);
  expect(screen.getByText("Choose an app or enter its website")).toBeDefined();
  expect(screen.getByRole("button", {name: "Create database"}).hasAttribute("disabled")).toBe(true);
  await user.selectOptions(screen.getByLabelText("App"), "prj_app");
  await user.selectOptions(screen.getByLabelText("Domain"), "example.org");
  await user.click(screen.getByRole("button", {name: "Create database"}));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({apiHostname:"meine-app-db.example.org",studioHostname:"meine-app-studio.example.org"}));
  query.clear();
});
it("directs a prepared app connection to the remaining deployment step", async () => {
  const query=client(), navigate=vi.fn(), user=userEvent.setup();
  const instance: SupabaseInstance={id:"sb_demo",name:"Demo",version:"v1",apiUrl:"https://db.example.com",studioUrl:"https://studio.example.com",status:"running",databasePort:null,error:null,createdAt:new Date().toISOString(),settings:{siteUrl:"https://app.example.com",redirectUrls:[]},jobs:[],backups:[]};
  query.setQueryData(["supabase-backup-policy",instance.id],{enabled:false});
  render(wrap(<SupabaseOverview instance={instance} connections={[{projectId:"prj_app",projectName:"My app",instanceId:instance.id,instanceName:instance.name,apiUrl:instance.apiUrl,urlVariable:"SUPABASE_URL",keyVariable:"SUPABASE_ANON_KEY",siteUrl:instance.settings.siteUrl,status:"redeploy_required",errorCode:null,serviceStatus:"running",updatedAt:new Date().toISOString()}]} connectionsReady navigate={navigate}/>,query));
  expect(screen.getByText("Your database is ready. Update your app once to activate the connection.")).toBeDefined();
  await user.click(screen.getByRole("button",{name:"Update app"}));
  expect(navigate).toHaveBeenCalledWith("apps");
  query.clear();
});
