import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../i18n";
import type { SupabaseInstance } from "../api/supabase-types";
import { SupabaseInstancePage } from "./SupabaseInstancePage";

afterEach(() => vi.unstubAllGlobals());
it("keeps lifecycle actions disabled while a persisted job runs and renders untrusted names as text", () => {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => (key === LOCALE_STORAGE_KEY ? "de" : null),
    },
    navigator: { language: "de", languages: ["de"] },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const instance: SupabaseInstance = {
    id: "sb_" + "a".repeat(32),
    name: "<script>untrusted()</script>",
    version: "self-hosted/v0.8.3",
    apiUrl: "https://api.example.com",
    studioUrl: "https://studio.example.com",
    status: "provisioning",
    databasePort: null,
    error: null,
    createdAt: new Date().toISOString(),
    settings: { siteUrl: "https://app.example.com", redirectUrls: [] },
    jobs: [{ id: "sbj_a", action: "backup", status: "running", error: null }],
    backups: [],
  };
  client.setQueryData(["supabase", instance.id], { instance });
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/services/${instance.id}`]}>
          <I18nProvider>
            <Routes>
              <Route path="/services/:id" element={<SupabaseInstancePage />} />
            </Routes>
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("&lt;script&gt;untrusted()&lt;/script&gt;");
    expect(html).not.toContain("<script>untrusted()");
    for (const label of ["Starten / erneut versuchen"]) {
      const index = html.indexOf(label);
      expect(index).toBeGreaterThan(0);
      expect(
        html.slice(
          html.lastIndexOf("<button", index),
          html.indexOf("</button>", index),
        ),
      ).toContain('disabled=""');
    }
    expect(html).toContain("Absicherung prüfen");
    expect(html).not.toContain("Studio öffnen");
    expect(html).toContain("Übersicht");
    expect(html).toContain("Einstellungen");
  } finally {
    client.clear();
  }
});
