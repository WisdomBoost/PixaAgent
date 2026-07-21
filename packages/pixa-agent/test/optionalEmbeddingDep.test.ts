import { describe, it, expect } from "vitest";
import { isMissingOptionalEmbeddingDep } from "../src/providers/embeddings";

/**
 * @huggingface/transformers ships unbundled, so a fresh install always fails
 * the initial index. That path must degrade quietly — a red error popup on
 * every first run is a bad first impression for an open-source project.
 *
 * This regressed once: the check originally matched only the CJS error code
 * (MODULE_NOT_FOUND), so the ESM dynamic-import failure Node actually throws
 * (ERR_MODULE_NOT_FOUND) fell through and the popup came back. Both codes are
 * pinned below.
 */
describe("isMissingOptionalEmbeddingDep", () => {
  it("matches the ESM dynamic-import failure (await import)", () => {
    const err: any = new Error(
      "Cannot find package '@huggingface/transformers' imported from " +
        "c:\\Users\\x\\.vscode\\extensions\\pixa.pixa-agent-0.6.0\\dist\\extension.js"
    );
    err.code = "ERR_MODULE_NOT_FOUND";
    expect(isMissingOptionalEmbeddingDep(err)).toBe(true);
  });

  it("matches the CJS require failure (vectra's internal require)", () => {
    const err: any = new Error("Cannot find module '@huggingface/transformers'");
    err.code = "MODULE_NOT_FOUND";
    expect(isMissingOptionalEmbeddingDep(err)).toBe(true);
  });

  it("does not swallow an unrelated missing module", () => {
    const err: any = new Error("Cannot find module 'some-other-package'");
    err.code = "MODULE_NOT_FOUND";
    expect(isMissingOptionalEmbeddingDep(err)).toBe(false);
  });

  it("does not swallow a genuine indexing failure", () => {
    const err: any = new Error("EACCES: permission denied, open '.pixa/index/index.json'");
    err.code = "EACCES";
    expect(isMissingOptionalEmbeddingDep(err)).toBe(false);
  });

  it("tolerates malformed errors without throwing", () => {
    expect(isMissingOptionalEmbeddingDep(undefined)).toBe(false);
    expect(isMissingOptionalEmbeddingDep(null)).toBe(false);
    expect(isMissingOptionalEmbeddingDep({})).toBe(false);
    expect(isMissingOptionalEmbeddingDep("a string")).toBe(false);
  });
});
