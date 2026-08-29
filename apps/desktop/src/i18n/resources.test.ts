import { describe, expect, it } from "vitest";

import { createTranslator, getCapabilityLabel, resolveLocale } from ".";
import { getTranslationKeys, resources, supportedLocales } from "./resources";

describe("i18n resources", () => {
  it("keeps every locale on the same complete key set", () => {
    const baseline = [...getTranslationKeys("zh-CN")].sort();

    for (const locale of supportedLocales) {
      expect([...getTranslationKeys(locale)].sort()).toEqual(baseline);
    }
  });

  it("does not contain empty interface copy", () => {
    for (const locale of supportedLocales) {
      expect(Object.values(resources[locale]).every((value) => value.trim().length > 0)).toBe(true);
    }
  });

  it("resolves English variants and defaults all other values to Simplified Chinese", () => {
    expect(resolveLocale("en-GB")).toBe("en-US");
    expect(resolveLocale("zh-Hans")).toBe("zh-CN");
    expect(resolveLocale(undefined)).toBe("zh-CN");
  });

  it("translates known capability ids and preserves unknown ids as plain labels", () => {
    const t = createTranslator("zh-CN");
    expect(getCapabilityLabel("models_json", t)).toBe("模型 JSON");
    expect(getCapabilityLabel("future_capability", t)).toBe("future_capability");
  });
});
