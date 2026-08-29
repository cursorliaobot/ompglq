import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

describe("App landmarks", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      navigator: { language: "zh-CN" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });
  });

  it("owns one main landmark and keeps projects gated while database status is unresolved", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup.match(/<main(?:\s|>)/g)).toHaveLength(1);
    expect(markup).toContain("项目功能正在等待本地元数据");
    expect(markup).toContain("兼容性工作台");
  });
});
