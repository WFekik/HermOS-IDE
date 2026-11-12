// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { catalogModelsForMerge } from "./provider-models";

describe("catalogModelsForMerge", () => {
  it("keeps serverContextWindow separate from the effective contextWindow", () => {
    // /api/providers returns contextWindow already capped by the user's saved
    // override; serverContextWindow is the provider's real maximum. Dropping it
    // makes the UI treat the capped value as the cap and lock the field.
    const rows = catalogModelsForMerge([
      { id: "m1", name: "Model One", contextWindow: 32768, serverContextWindow: 200000 },
    ]);
    expect(rows).toEqual([
      { id: "m1", name: "Model One", contextWindow: 32768, serverContextWindow: 200000 },
    ]);
  });

  it("passes through models that have no context data", () => {
    expect(catalogModelsForMerge([{ id: "m2", name: "Model Two" }])).toEqual([
      { id: "m2", name: "Model Two", contextWindow: undefined, serverContextWindow: undefined },
    ]);
  });

  it("tolerates a missing catalog", () => {
    expect(catalogModelsForMerge(undefined)).toEqual([]);
  });
});
