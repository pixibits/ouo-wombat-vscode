import { describe, expect, it } from "vitest";
import { generateSymbolsFromFiles } from "../wombat/symbols";
import { createIndexModel, findSymbolAt, formatHover } from "../vscode/model";

describe("VS Code symbol model", () => {
  it("finds hover and definition metadata for a function reference", () => {
    const index = generateSymbolsFromFiles(
      [
        {
          name: "pet",
          path: "pet.m",
          text: `
            function int Q4BY(int Q618, list text) {
              return(Q618);
            }
            function int Q5HB(obj this, obj speaker, string arg) {
              int Q4V9;
              Q4V9 = Q4BY(0x00, arg);
              return(Q4V9);
            }
          `
        }
      ],
      "fixture",
      {
        schemaVersion: 1,
        symbols: {
          "function-slot:pet:Q4BY:iil": {
            displayName: "nextCommandWordIsMe"
          }
        }
      }
    );

    const model = createIndexModel(index);
    const ref = index.references.find((record) => record.name === "Q4BY");
    expect(ref).toBeDefined();

    const lookup = findSymbolAt(model, "pet.m", {
      line: ref!.location.range.start.line,
      character: ref!.location.range.start.character
    });
    expect(lookup?.target?.kind).toBe("function-slot");
    expect(formatHover(lookup!)).toContain("nextCommandWordIsMe");
  });
});
