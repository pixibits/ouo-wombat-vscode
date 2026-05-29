import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateSymbolsFromFiles, generateSymbolsForDirectory } from "../wombat/symbols";

describe("Wombat symbol generation", () => {
  it("groups inherited function overrides into the parent slot", () => {
    const index = generateSymbolsFromFiles(
      [
        {
          name: "wearstat",
          path: "wearstat.m",
          text: `
            function void Q4HX(obj it) {
              return();
            }
          `
        },
        {
          name: "wearweak",
          path: "wearweak.m",
          text: `
            inherits wearstat;
            function void Q4HX(obj it) {
              detachScript(it, "wearweak");
              return();
            }
          `
        }
      ],
      "fixture",
      {
        schemaVersion: 1,
        symbols: {
          "function-slot:wearstat:Q4HX:vo": {
            displayName: "onWearEffectExpired",
            notes: "Virtual wear-stat cleanup hook."
          }
        }
      }
    );

    const slot = index.functionSlots.find((record) => record.id === "function-slot:wearstat:Q4HX:vo");
    expect(slot?.definitionIds).toEqual(["function-def:wearstat:Q4HX:vo", "function-def:wearweak:Q4HX:vo"]);
    expect(slot?.displayName).toBe("onWearEffectExpired");
    expect(index.functions.find((record) => record.id === "function-def:wearweak:Q4HX:vo")?.overrides).toBe(
      "function-def:wearstat:Q4HX:vo"
    );
  });

  it("is deterministic for identical input", () => {
    const files = [
      {
        name: "pet",
        path: "pet.m",
        text: `
          forward int Q4BY(int , list );
          function int Q4BY(int Q618, list text) {
            int Q4V9;
            Q4V9 = Q618 + 0x01;
            return(Q4V9);
          }
        `
      }
    ];

    const first = JSON.stringify(generateSymbolsFromFiles(files, "fixture"), null, 2);
    const second = JSON.stringify(generateSymbolsFromFiles(files, "fixture"), null, 2);
    expect(second).toBe(first);
  });

  it("can parse the draxinar scripts.wombat tree when available", () => {
    const scriptsPath = path.resolve(__dirname, "../../../.rundir/scripts.wombat");
    if (!fs.existsSync(scriptsPath)) {
      return;
    }

    const index = generateSymbolsForDirectory({
      scriptsPath,
      sourceRootLabel: "../.rundir/scripts.wombat"
    });
    expect(index.counts.scripts).toBeGreaterThan(1600);
    expect(index.counts.functionSlots).toBeGreaterThan(100);
  });
});
