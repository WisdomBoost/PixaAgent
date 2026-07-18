import { vi, describe, it, expect } from "vitest";

vi.mock("vscode", () => {
  const SymbolKind = {
    File: 0,
    Module: 1,
    Namespace: 2,
    Package: 3,
    Class: 4,
    Method: 5,
    Property: 6,
    Field: 7,
    Constructor: 8,
    Enum: 9,
    Interface: 10,
    Function: 11,
    Variable: 12,
    Constant: 13,
    String: 14,
    Number: 15,
    Boolean: 16,
    Array: 17,
    Object: 18,
    Key: 19,
    Null: 20,
    EnumMember: 21,
    Struct: 22,
    Event: 23,
    Operator: 24,
    TypeParameter: 25,
    [0]: "File",
    [1]: "Module",
    [2]: "Namespace",
    [3]: "Package",
    [4]: "Class",
    [5]: "Method",
    [6]: "Property",
    [7]: "Field",
    [8]: "Constructor",
    [9]: "Enum",
    [10]: "Interface",
    [11]: "Function",
    [12]: "Variable",
    [13]: "Constant",
    [14]: "String",
    [15]: "Number",
    [16]: "Boolean",
    [17]: "Array",
    [18]: "Object",
    [19]: "Key",
    [20]: "Null",
    [21]: "EnumMember",
    [22]: "Struct",
    [23]: "Event",
    [24]: "Operator",
    [25]: "TypeParameter",
  };
  return {
    SymbolKind,
  };
});

import { chunkFile } from "../src/indexer/chunker";
import * as vscode from "vscode";

describe("chunkFile", () => {
  it("returns empty chunks for empty file with no symbols", () => {
    const chunks = chunkFile("test.ts", "", []);
    expect(chunks).toEqual([]);
  });

  it("chunks small files with no symbols into single window", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkFile("test.ts", content, []);
    expect(chunks.length).toBe(1);
    expect(chunks[0].startLine).toBe(0);
    expect(chunks[0].endLine).toBe(19);
    expect(chunks[0].symbolName).toBeNull();
    expect(chunks[0].symbolKind).toBeNull();
    expect(chunks[0].text).toBe(content);
  });

  it("chunks larger files with no symbols into overlapping windows", () => {
    // 65 lines total
    const content = Array.from({ length: 65 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkFile("test.ts", content, []);
    // Window 1: 0 to 49
    // Window 2: 40 to 64 (25 lines)
    expect(chunks.length).toBe(2);
    expect(chunks[0].startLine).toBe(0);
    expect(chunks[0].endLine).toBe(49);
    expect(chunks[1].startLine).toBe(40);
    expect(chunks[1].endLine).toBe(64);
  });

  it("chunks by top-level symbols when they fit in token limit", () => {
    const content = [
      "class Foo {",
      "  constructor() {}",
      "}",
      "function bar() {",
      "  return 42;",
      "}",
    ].join("\n");

    const symbols: any[] = [
      {
        name: "Foo",
        kind: 4, // Class
        range: {
          start: { line: 0, character: 0 },
          end: { line: 2, character: 1 },
        },
        children: [],
      },
      {
        name: "bar",
        kind: 11, // Function
        range: {
          start: { line: 3, character: 0 },
          end: { line: 5, character: 1 },
        },
        children: [],
      },
    ];

    const chunks = chunkFile("test.ts", content, symbols as vscode.DocumentSymbol[]);
    expect(chunks.length).toBe(2);
    expect(chunks[0].symbolName).toBe("Foo");
    expect(chunks[0].symbolKind).toBe("Class");
    expect(chunks[0].startLine).toBe(0);
    expect(chunks[0].endLine).toBe(2);

    expect(chunks[1].symbolName).toBe("bar");
    expect(chunks[1].symbolKind).toBe("Function");
    expect(chunks[1].startLine).toBe(3);
    expect(chunks[1].endLine).toBe(5);
  });

  it("splits large symbols into children when they exceed token limit", () => {
    // We want the parent symbol's text length / 4 to exceed 400.
    // Length of 1650 chars will be ~413 tokens.
    const padding = "a".repeat(1650);
    const content = [
      "class Large {",
      `  // padding: ${padding}`,
      "  methodOne() {",
      "    return 1;",
      "  }",
      "  methodTwo() {",
      "    return 2;",
      "  }",
      "}",
    ].join("\n");

    const symbols: any[] = [
      {
        name: "Large",
        kind: 4, // Class
        range: {
          start: { line: 0, character: 0 },
          end: { line: 8, character: 1 },
        },
        children: [
          {
            name: "methodOne",
            kind: 5, // Method
            range: {
              start: { line: 2, character: 2 },
              end: { line: 4, character: 3 },
            },
            children: [],
          },
          {
            name: "methodTwo",
            kind: 5, // Method
            range: {
              start: { line: 5, character: 2 },
              end: { line: 7, character: 3 },
            },
            children: [],
          },
        ],
      },
    ];

    const chunks = chunkFile("test.ts", content, symbols as vscode.DocumentSymbol[]);
    expect(chunks.length).toBe(2);
    expect(chunks[0].symbolName).toBe("methodOne");
    expect(chunks[1].symbolName).toBe("methodTwo");
  });
});
