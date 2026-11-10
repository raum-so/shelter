import { expect, it } from "vitest";
import { changedFunctionDraft, functionDownloadName, functionSourceBytes, importedFunctionName, MAX_FUNCTION_SOURCE_BYTES, validFunctionName } from "./function-editor";

it("measures the deployment limit in UTF-8 bytes, including multibyte source", () => {
  expect(functionSourceBytes("a".repeat(MAX_FUNCTION_SOURCE_BYTES))).toBe(MAX_FUNCTION_SOURCE_BYTES);
  expect(functionSourceBytes("😀".repeat(65_536))).toBe(MAX_FUNCTION_SOURCE_BYTES);
  expect(functionSourceBytes("😀".repeat(65_536)+"x")).toBeGreaterThan(MAX_FUNCTION_SOURCE_BYTES);
});
it("accepts deployable names and keeps unsafe names out of downloads", () => {
  expect(validFunctionName("send_email-v2")).toBe(true);
  for(const name of ["main","../secret","/tmp/file","hello/world","", "A", "a".repeat(64)]) {
    expect(validFunctionName(name),name).toBe(false);
    expect(functionDownloadName(name),name).toBe("function.ts");
  }
  expect(functionDownloadName("send_email-v2")).toBe("send_email-v2.ts");
});
it("treats both code and a renamed deployment as unsaved edits", () => {
  const saved={name:"hello",source:"Deno.serve(() => new Response('hello'));"};
  expect(changedFunctionDraft({...saved},saved)).toBe(false);
  expect(changedFunctionDraft({...saved,name:"other"},saved)).toBe(true);
  expect(changedFunctionDraft({...saved,source:saved.source+"\n"},saved)).toBe(true);
});
it("keeps the selected function for index.ts imports and accepts safe file names", () => {
  expect(importedFunctionName("index.ts","payments")).toBe("payments");
  expect(importedFunctionName("index.TS","payments")).toBe("payments");
  expect(importedFunctionName("send-email.ts","payments")).toBe("send-email");
  expect(importedFunctionName("../escape.ts","payments")).toBe("payments");
});
