import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";
for (const [prefix, parent] of [
  ["/", ""],
  ["data//", "data/"],
  ["/a/", "/"],
  ["data/../", "data/"],
  ["a/b/", "a/"],
  ["///", "//"],
]) {
  test(`parent of raw prefix ${JSON.stringify(prefix)} is ${JSON.stringify(parent)}`, async ({
    page,
  }) => {
    await installFixture(page);
    await page.addInitScript(
      ({ prefix }) => {
        const invoke = window.storageLab.invoke;
        window.__prefixRequests = [];
        window.storageLab.invoke = async (method, p) => {
          if (method === "listObjects") {
            window.__prefixRequests.push(p.prefix);
            return {
              ok: true,
              value: { objects: [], prefixes: p.prefix ? [] : [prefix] },
            };
          }
          return invoke(method, p);
        };
      },
      { prefix },
    );
    await page.goto("/");
    await page.getByRole("button", { name: "本地测试", exact: true }).click();
    await page
      .getByRole("button", { name: `打开目录 ${prefix}`, exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.__prefixRequests.at(-1)))
      .toBe(prefix);
    await page.getByRole("button", { name: "上级", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.__prefixRequests.at(-1)))
      .toBe(parent);
  });
}
