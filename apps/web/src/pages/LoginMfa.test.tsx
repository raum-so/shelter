// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { I18nProvider } from "@/i18n";
import { api } from "@/api/client";
import { LoginPage } from "./LoginPage";
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/LanguageToggle", () => ({ LanguageToggle: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("waits for the second factor before navigating into the panel", async () => {
  const login = vi.spyOn(api, "login").mockResolvedValue({ mfaRequired: true });
  const verify = vi
    .spyOn(api, "verifyMfa")
    .mockResolvedValue({
      user: { id: "user", email: "admin@example.com" },
      csrfToken: "session-csrf",
    });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/login"]}>
        <I18nProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<h1>Private panel</h1>} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await user.type(screen.getByLabelText("Email address"), "admin@example.com");
  await user.type(
    screen.getByLabelText("Password"),
    "correct horse battery staple",
  );
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(login).toHaveBeenCalledOnce();
  expect(screen.queryByText("Private panel")).toBeNull();
  await user.type(await screen.findByLabelText("Verification code"), "123456");
  await user.click(screen.getByRole("button", { name: "Verify and sign in" }));
  expect(await screen.findByText("Private panel")).toBeDefined();
  expect(verify).toHaveBeenCalledWith("123456");
  client.clear();
});
