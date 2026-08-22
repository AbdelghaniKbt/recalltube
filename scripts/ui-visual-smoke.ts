import fs from "node:fs";
import path from "node:path";
import { launch } from "../tests/e2e/harness";
import { CAPTIONS_WITHHELD, ENGLISH_TALK, findFixture, watchPageHtml } from "../tests/e2e/fixtures";

const output = path.resolve("test-results/ui");
fs.mkdirSync(output, { recursive: true });
const harness = await launch();

try {
  await harness.context.route(/^https:\/\/www\.youtube\.com\/api\/timedtext/, async (route) => {
    const fixture = findFixture(new URL(route.request().url()).searchParams.get("v"));
    if (!fixture || fixture.emptyBody) return route.fulfill({ status: 200, contentType: "text/html", body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture.json3) });
  });
  await harness.context.route(/^https:\/\/www\.youtube\.com\/watch/, async (route) => {
    const fixture = findFixture(new URL(route.request().url()).searchParams.get("v")) ?? ENGLISH_TALK;
    return route.fulfill({ status: 200, contentType: "text/html", body: watchPageHtml(fixture) });
  });

  const watch = await harness.context.newPage();
  await watch.goto(`https://www.youtube.com/watch?v=${ENGLISH_TALK.id}`);
  const panel = await harness.openSidePanel();
  await panel.setViewportSize({ width: 420, height: 900 });
  await watch.bringToFront();
  await panel.getByText("READY TO RECALL").waitFor({ timeout: 20_000 });
  const input = panel.getByRole("textbox", { name: "Search transcript" });
  await input.fill("retrieval");
  await panel.getByText(/moments?/u).first().waitFor();
  await panel.screenshot({ path: path.join(output, "search-results.png"), fullPage: true });

  await watch.goto(`https://www.youtube.com/watch?v=${CAPTIONS_WITHHELD.id}`);
  await panel.getByText("YouTube did not expose usable captions").waitFor({ timeout: 30_000 });
  if (await panel.getByText(/Open YouTube.*transcript panel/iu).count()) {
    throw new Error("The redesigned UI still exposes YouTube's native transcript panel.");
  }
  if (await panel.getByText(/Paste transcript/iu).count()) {
    throw new Error("The product UI still exposes the removed paste workflow.");
  }
  await panel.screenshot({ path: path.join(output, "capture-unavailable.png"), fullPage: true });

  await panel.setViewportSize({ width: 300, height: 760 });
  const narrowLayout = await panel.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  if (narrowLayout.content > narrowLayout.viewport) {
    throw new Error(`Narrow side panel overflows horizontally: ${JSON.stringify(narrowLayout)}`);
  }
  await panel.screenshot({ path: path.join(output, "narrow-panel.png"), fullPage: true });

  console.log(
    JSON.stringify(
      { output, screenshots: ["search-results.png", "capture-unavailable.png", "narrow-panel.png"] },
      null,
      2
    )
  );
} finally {
  await harness.close();
}
