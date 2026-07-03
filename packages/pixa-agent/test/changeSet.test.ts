import { describe, it, expect } from "vitest";
import { ChangeSet } from "../src/edits/changeSet";

describe("ChangeSet.stageEdit", () => {
  it("stages a unique replacement", () => {
    const cs = new ChangeSet();
    const r = cs.stageEdit("a.ts", "const x = 1;\nconst y = 2;\n", "const y = 2;", "const y = 3;");
    expect(r.ok).toBe(true);
    expect(cs.get("a.ts")?.newContent).toBe("const x = 1;\nconst y = 3;\n");
    expect(cs.get("a.ts")?.status).toBe("pending");
  });

  it("errors when old string is not found", () => {
    const cs = new ChangeSet();
    const r = cs.stageEdit("a.ts", "hello", "missing", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/i);
    expect(cs.get("a.ts")).toBeUndefined();
  });

  it("errors when old string matches more than once", () => {
    const cs = new ChangeSet();
    const r = cs.stageEdit("a.ts", "dup dup", "dup", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/2 times/);
  });

  it("composes sequential edits on the pending content", () => {
    const cs = new ChangeSet();
    cs.stageEdit("a.ts", "one two three", "one", "1");
    const r = cs.stageEdit("a.ts", "one two three", "two", "2");
    expect(r.ok).toBe(true);
    expect(cs.get("a.ts")?.newContent).toBe("1 2 three");
  });
});

describe("ChangeSet writes and lifecycle", () => {
  it("stages a new file (original null)", () => {
    const cs = new ChangeSet();
    cs.stageWrite("new.ts", null, "export {};\n");
    const fc = cs.get("new.ts")!;
    expect(fc.originalContent).toBeNull();
    expect(fc.newContent).toBe("export {};\n");
  });

  it("lists, applies, rejects, and clears resolved", () => {
    const cs = new ChangeSet();
    cs.stageWrite("a.ts", "old", "new");
    cs.stageWrite("b.ts", null, "b");
    expect(cs.list().map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    cs.markApplied("a.ts");
    cs.markRejected("b.ts");
    expect(cs.get("a.ts")?.status).toBe("applied");
    expect(cs.get("b.ts")?.status).toBe("rejected");
    cs.clearResolved();
    expect(cs.list()).toHaveLength(0);
  });
});
