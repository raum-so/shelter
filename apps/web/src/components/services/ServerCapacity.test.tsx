import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { I18nProvider } from "@/i18n";
import { ServerCapacity } from "./ServerCapacity";

function renderCapacity(
  sampledAt: string | null,
  availableBytes = 12 * 1024 ** 3,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["server-metrics", "1h"], {
    sampledAt,
    intervalSeconds: 15,
    current: {
      memory: {
        availableBytes,
        usedBytes: 52 * 1024 ** 3,
        totalBytes: 64 * 1024 ** 3,
      },
      storage: {
        availableBytes: 200 * 1024 ** 3,
        usedBytes: 100 * 1024 ** 3,
        totalBytes: 300 * 1024 ** 3,
      },
      cpu: { usagePercent: 7, logicalCores: 12 },
    },
  });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <I18nProvider>
            <ServerCapacity />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

it("shows available memory and disk instead of total capacity or reserved CPU cores", () => {
  const html = renderCapacity(new Date().toISOString());
  expect(html).toContain("12 GB");
  expect(html).toContain("200 GB");
  expect(html).toMatch(/>7(?:[.,]0)?%</);
  expect(html).not.toContain("64 GB");
  expect(html).not.toContain("300 GB");
});

it.each([null, "invalid", new Date(Date.now() - 120_000).toISOString()])(
  "does not present missing or stale measurements as current capacity (%s)",
  (sampledAt) => {
    const html = renderCapacity(sampledAt);
    expect(html).not.toContain("12 GB");
    expect(html).not.toContain("200 GB");
    expect(html).toContain('role="status"');
    expect(html).toContain("/server");
  },
);

it("keeps a genuine zero-available measurement visible", () => {
  expect(renderCapacity(new Date().toISOString(), 0)).toContain("0 B");
});
