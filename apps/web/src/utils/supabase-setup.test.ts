import { expect, it } from "vitest";
import { suggestSupabaseAddresses } from "./supabase-setup";

it("suggests two distinct addresses from a readable project name", () => {
  expect(suggestSupabaseAddresses("Büro & App", "example.com")).toEqual({
    api: "buro-app-db.example.com",
    studio: "buro-app-studio.example.com",
  });
  expect(suggestSupabaseAddresses("", "example.com")).toEqual({
    api: "supabase-db.example.com",
    studio: "supabase-studio.example.com",
  });
});
it("waits for a domain and keeps long project labels valid", () => {
  expect(suggestSupabaseAddresses("My app", "")).toEqual({
    api: "",
    studio: "",
  });
  const addresses = suggestSupabaseAddresses("A".repeat(80), "example.com");
  expect(addresses.api).not.toBe(addresses.studio);
  for (const hostname of Object.values(addresses)) {
    expect(hostname.split(".")[0]!.length).toBeLessThanOrEqual(63);
    expect(hostname).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.example\.com$/);
  }
});

it("keeps a suggested service address separate from the app's usual subdomain", () => {
  expect(suggestSupabaseAddresses("My App", "example.com").api).not.toBe(
    "my-app.example.com",
  );
});
