// E2E-smoketest i riktig webbläsare (systemets Edge/Chrome – ingen nedladdning).
//   npm run e2e                      → bygger, startar preview och testar
//   E2E_URL=http://localhost:5173/ node e2e/smoke.mjs   → testa en körande dev-server
// Kanal: E2E_CHANNEL=msedge (standard) | chrome
import { chromium } from "playwright-core";
import { preview } from "vite";

const channel = process.env.E2E_CHANNEL ?? "msedge";
let server = null;
let url = process.env.E2E_URL;
if (!url) {
  server = await preview({ preview: { port: 4173, strictPort: true } });
  url = server.resolvedUrls.local[0];
}
const origin = new URL(url).origin;

const browser = await chromium.launch({ channel });
const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
const page = await context.newPage();
const external = [];
const problems = [];
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` ${extra}`}`);
  if (!ok) failed++;
};

try {
  await page.goto(url);
  await page.waitForSelector(".cte-card", { timeout: 90_000 });
  await page.waitForTimeout(500);

  check("5 kort för sales.sql", (await page.locator(".cte-card").count()) === 5);
  check("status OK", (await page.locator(".statusbar .pill").innerText()).includes("OK"));
  if (!process.env.E2E_URL) {
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    check("CSP begränsar connect-src till 'self'", !!csp && csp.includes("connect-src 'self'"), String(csp));
  }

  await page.locator(".cte-card", { hasText: "customer_totals" }).locator(".col", { hasText: "total_amount" }).hover();
  await page.waitForTimeout(300);
  check("hover visar kolumn-lineage (4 kanter)", (await page.locator(".lineage-edge").count()) === 4);
  check("editorn markerar kolumnens kod", (await page.locator(".cm-col-hl").allInnerTexts()).join().includes("SUM(amount)"));

  await page.locator(".cm-line", { hasText: "WHERE amount" }).click();
  await page.waitForTimeout(200);
  check("klick i koden väljer filtered_orders", (await page.locator(".cte-card.is-selected .cte-card__name").innerText()) === "filtered_orders");

  await page.getByRole("tab", { name: "Steg för steg" }).click();
  await page.waitForTimeout(300);
  check("stegvyn startar på valt steg", (await page.locator(".steps__main h2").innerText()).startsWith("Steg 3 av 5"));
  await page.locator(".steps").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  const heads = await page.locator(".grid__head .cell").allInnerTexts();
  check("group by: 2 borttagna + 1 ny kolumn", heads.filter((h) => h.includes("borttagen")).length === 2 && heads.some((h) => h.includes("total_amount")), heads.join("|"));
  check("ingen data visas (bara platshållare)", (await page.locator(".grid__row .ph").count()) > 0 && !(await page.locator(".grid__row").first().innerText()).trim());

  await page.getByRole("tab", { name: "Flöde" }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" WHERE (");
  await page.waitForTimeout(1200);
  check("syntaxfel behåller senaste lyckade vy", (await page.locator(".cte-card").count()) === 5 && (await page.locator(".statusbar").innerText()).includes("fel"));
  for (let i = 0; i < 9; i++) await page.keyboard.press("Backspace");
  await page.waitForTimeout(1000);
  check("åter OK efter rättning", (await page.locator(".statusbar .pill").innerText()).includes("OK"));

  // Offline: runtime är laddad – analysen får inte behöva nätverk.
  await context.setOffline(true);
  await page.locator("select").first().selectOption("joins");
  await page.waitForTimeout(1500);
  check("analys fungerar offline (6 kort för joins)", (await page.locator(".cte-card").count()) === 6);
  await context.setOffline(false);

  // ---------------------------------------------------------------- interaktivitet
  const box = (sel) => page.locator(sel).first().boundingBox();
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  await page.getByRole("tab", { name: "Flöde" }).click();
  await page.waitForTimeout(600); // joins-exemplet visas, vyn har anpassats

  // dra och släpp ett kort
  const node = '.react-flow__node[data-id="orders"]';
  const before = await box(node);
  const head = await box(`${node} .cte-card__head`);
  // Regression: korten får aldrig blinka (visibility: hidden) under drag. Händer om `nodes` byggs om
  // utan React Flows uppmätta mått i stället för att gå genom applyNodeChanges.
  await page.evaluate(() => {
    window.__hiddenFrames = 0;
    window.__dragVp = new Set();
    const tick = () => {
      const hidden = [...document.querySelectorAll(".react-flow__node")].some((n) => getComputedStyle(n).visibility === "hidden");
      if (hidden) window.__hiddenFrames++;
      window.__dragVp.add(document.querySelector(".react-flow__viewport").style.transform);
      window.__raf = requestAnimationFrame(tick);
    };
    window.__raf = requestAnimationFrame(tick);
  });
  await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(head.x + head.width / 2 + i * 1.25, head.y + head.height / 2 + i * 3.75);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
  const flicker = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return { hidden: window.__hiddenFrames, vp: window.__dragVp.size }; });
  check("inga blinkande kort under drag", flicker.hidden === 0, `${flicker.hidden} ramar med dolda kort`);
  check("vyn hoppar inte under drag", flicker.vp === 1, `${flicker.vp} olika viewport-transformer`);
  const moved = await box(node);
  check("kortet följer musen vid drag", moved.y - before.y > 60 && moved.x - before.x > 15, `dy=${moved.y - before.y} dx=${moved.x - before.x}`);
  await page.getByRole("button", { name: "Återställ layout" }).click();
  await page.waitForTimeout(700);
  const reset = await box(node);
  check("Återställ layout lägger tillbaka kortet", near(reset.y, before.y, 6) && near(reset.x, before.x, 6), `${reset.x},${reset.y} vs ${before.x},${before.y}`);

  // justerbara fönster
  const w0 = (await box(".pane--editor")).width;
  const grip = await box(".splitter--vertical");
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 200);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 150, grip.y + 200, { steps: 8 });
  await page.mouse.up();
  const w1 = (await box(".pane--editor")).width;
  check("splittern ändrar kodpanelens bredd", near(w1 - w0, 150, 4), `${w0} → ${w1}`);
  await page.locator(".splitter--vertical").focus();
  await page.keyboard.press("ArrowLeft");
  check("splittern styrs med piltangenter", near((await box(".pane--editor")).width, w1 - 16, 2));
  await page.locator(".splitter--vertical").dblclick();
  check("dubbelklick återställer bredden", near((await box(".pane--editor")).width, 440, 2));

  const d0 = (await box(".details")).height;
  const hs = await box(".splitter--horizontal");
  await page.mouse.move(hs.x + 200, hs.y + hs.height / 2);
  await page.mouse.down();
  await page.mouse.move(hs.x + 200, hs.y + hs.height / 2 - 80, { steps: 8 });
  await page.mouse.up();
  check("detaljpanelens höjd kan dras", (await box(".details")).height - d0 > 60);
  await page.locator(".details__bar .icon-btn").click();
  check("detaljpanelen kan fällas ihop", (await box(".details")).height < 60);
  await page.locator(".details__bar .icon-btn").click();

  await page.getByRole("button", { name: "Kod", exact: true }).click();
  check("kodpanelen kan döljas", (await page.locator(".pane--editor").count()) === 0);
  await page.getByRole("button", { name: "Kod", exact: true }).click();
  check("…och visas igen", (await page.locator(".pane--editor").count()) === 1);

  // editorn i sidled
  const scroll = () => page.evaluate(() => { const e = document.querySelector(".cm-scroller"); return { left: e.scrollLeft, sw: e.scrollWidth, cw: e.clientWidth }; });
  const s0 = await scroll();
  check("långa rader ger sidoscroll", s0.sw > s0.cw, JSON.stringify(s0));
  const eb = await box(".cm-scroller");
  await page.mouse.move(eb.x + 300, eb.y + 200);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(eb.x + 120, eb.y + 200, { steps: 8 });
  await page.mouse.up({ button: "middle" });
  check("mittenknapp + dra panorerar editorn i sidled", (await scroll()).left > 100, JSON.stringify(await scroll()));
  await page.getByRole("button", { name: "Radbrytning" }).click();
  await page.waitForTimeout(200);
  const s1 = await scroll();
  check("radbrytning tar bort sidoscrollen", s1.sw <= s1.cw + 1, JSON.stringify(s1));
  await page.getByRole("button", { name: "Radbrytning" }).click();

  // klickbara kolumnnamn som följer lineage
  await page.locator("select").first().selectOption("sales");
  await page.waitForTimeout(1200);
  await page.locator('.react-flow__node[data-id="customer_totals"] .col', { hasText: "total_amount" }).click();
  await page.waitForTimeout(300);
  check("klick på kolumn låser den och visar lineage-spåret", (await page.locator(".trail").count()) === 1 && (await page.locator(".col.is-pinned").count()) >= 1);
  const chips = (await page.locator(".trail__chips .chip-link").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  check("spåret listar ursprung och användning", chips.some((c) => c.includes("raw_orders")) && chips.some((c) => c.includes("Resultat")), chips.join(" | "));
  await page.locator(".trail__chips .chip-link", { hasText: "raw_orders" }).click();
  await page.waitForTimeout(500);
  check("klick i spåret hoppar till källan och följer kolumnen därifrån",
    (await page.locator(".cte-card.is-selected .cte-card__name").innerText()) === "raw_orders" && (await page.locator(".trail__head").innerText()).includes("raw_orders.amount"));

  await page.getByRole("tab", { name: "Steg för steg" }).click();
  await page.waitForTimeout(300);
  await page.locator(".dot", { hasText: "customer_totals" }).click();
  await page.locator(".grid__head .cell", { hasText: "total_amount" }).click();
  await page.waitForTimeout(200);
  check("kolumnrubrik i stegvyn är klickbar och visar spåret", (await page.locator(".trail").count()) === 1 && (await page.locator(".cell.is-pinned").count()) === 1);
  await page.locator(".trail__chips .chip-link", { hasText: "filtered_orders" }).first().click();
  await page.waitForTimeout(300);
  check("spåret i stegvyn byter steg", (await page.locator(".steps__main h2").innerText()).includes("filtered_orders"));

  // ---------------------------------------------------------------- dbt
  await page.getByRole("tab", { name: "Flöde" }).click();
  await page.locator("select").first().selectOption("dbt_orders");
  await page.waitForTimeout(1500);
  check("dbt-modell renderas: 2 källor + 4 CTE + resultat", (await page.locator(".cte-card").count()) === 7, String(await page.locator(".cte-card").count()));
  check("status OK och dbt-läge märkt", (await page.locator(".statusbar .pill").first().innerText()).includes("OK") && (await page.locator(".pill-dbt").count()) === 1);
  const kinds = await page.locator(".cte-card__kind.is-dbt").allInnerTexts();
  check("källkort märks som dbt source / dbt ref", kinds.some((k) => /dbt source/i.test(k)) && kinds.some((k) => /dbt ref/i.test(k)), kinds.join("|"));
  check("Jinja-taggar markeras i editorn", (await page.locator(".cm-jinja").count()) > 5);

  await page.locator('.react-flow__node[data-id="filtered"] .cte-card__head').click();
  await page.waitForTimeout(300);
  const hl = (await page.locator(".cm-node-hl").allInnerTexts()).join(" ");
  check("klick på CTE markerar dbt-koden (inkl. Jinja-loopen)", hl.includes("{%- for s in statuses %}") && hl.includes("filtered AS ("), hl.slice(0, 80));
  await page.locator(".cm-line", { hasText: "stg_customers" }).click({ position: { x: 150, y: 5 } });
  await page.waitForTimeout(300);
  check("klick på {{ ref() }} i koden väljer rätt CTE", (await page.locator(".cte-card.is-selected .cte-card__name").innerText()) === "customers");

  await page.locator("[data-dbt-toggle]").click();
  const dlg = page.getByRole("dialog", { name: "dbt" });
  await dlg.waitFor();
  const pb = await dlg.boundingBox();
  const vp = page.viewportSize();
  check("dbt-panelen ligger synligt inom fönstret", pb.x >= 0 && pb.y >= 40 && pb.x + pb.width <= vp.width && pb.y + pb.height <= vp.height, JSON.stringify(pb));
  check("panelen skapar ingen extra sidscroll", await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1));
  const dtext = await dlg.innerText();
  check("panelen listar config, ref, source och var", ["incremental", "stg_customers", "shop.raw_orders", "start_date", "2024-01-01"].every((t) => dtext.includes(t)), dtext.slice(0, 200));
  await dlg.getByText("Kompilerad SQL").click();
  check("kompilerad SQL visas utan Jinja", !(await dlg.locator("pre").innerText()).includes("{{") && (await dlg.locator("pre").innerText()).includes("shop.raw_orders"));
  await dlg.getByLabel("is_incremental() är sant").check();
  await page.waitForTimeout(900);
  check("is_incremental-antagandet ändrar renderingen", (await dlg.locator("pre").innerText()).includes("FROM this_model"));
  await dlg.getByLabel("is_incremental() är sant").uncheck();
  await dlg.locator("textarea").first().fill('{"start_date": "2030-01-01"}');
  await page.waitForTimeout(900);
  check("var() tar värde från inställningen", (await dlg.locator("pre").innerText()).includes("'2030-01-01'") && (await dlg.innerText()).includes("inställd"));
  await dlg.locator("textarea").first().fill("{ trasig json");
  check("ogiltig JSON för var() visar fel", (await dlg.locator(".err").innerText()).includes("JSON"));
  await dlg.locator("textarea").first().fill("");
  await page.keyboard.press("Escape");
  check("Escape stänger panelen", (await page.getByRole("dialog", { name: "dbt" }).count()) === 0);

  await page.locator("select").first().selectOption("dbt_unresolved");
  await page.waitForTimeout(1500);
  check("okända makron ger delvis analys (partial)", (await page.locator(".statusbar .pill").first().innerText()).includes("Delvis"));
  check("okänt makro visas som ?-kolumn, inte gissad", (await page.locator(".col.change-unresolved").count()) >= 2);
  check("dbt-knappen visar antal okända uttryck", (await page.locator("[data-dbt-toggle] .badge").innerText()) === "3");
  await page.locator("select").first().selectOption("sales");
  await page.waitForTimeout(1200);
  check("vanlig SQL: inget dbt-läge", (await page.locator(".pill-dbt").count()) === 0 && (await page.locator(".cte-card__kind.is-dbt").count()) === 0);

  // ---------------------------------------------------------------- tonen i gränssnittet
  // Inga emojis och inga tankstreck i text som användaren läser (editorns SQL undantas).
  const uiText = () =>
    page.evaluate(() => {
      const body = document.body.cloneNode(true);
      body.querySelectorAll(".cm-editor").forEach((e) => e.remove());
      const attrs = [...document.querySelectorAll("[title],[aria-label],[placeholder]")].flatMap((e) => [e.getAttribute("title"), e.getAttribute("aria-label"), e.getAttribute("placeholder")]);
      const options = [...document.querySelectorAll("option")].map((o) => o.textContent);
      return [body.innerText, ...attrs, ...options].filter(Boolean).join("\n");
    });
  const offenders = (text) => ({
    emoji: [...text.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]),
    dash: [...text.matchAll(/[–—]/g)].map((m) => m[0]),
  });
  await page.getByRole("tab", { name: "Flöde" }).click();
  await page.locator("select").first().selectOption("dbt_unresolved");
  await page.waitForTimeout(1500);
  await page.locator(".statusbar .linkish").click();
  await page.locator('.react-flow__node[data-id="base"] .col', { hasText: "amount" }).click();
  await page.waitForTimeout(300);
  let o = offenders(await uiText());
  check("flödesvyn: inga emojis eller tankstreck", !o.emoji.length && !o.dash.length, JSON.stringify(o));
  await page.locator("[data-dbt-toggle]").click();
  await page.getByRole("dialog", { name: "dbt" }).getByText("Kompilerad SQL").click();
  o = offenders(await uiText());
  check("dbt-panelen: inga emojis eller tankstreck", !o.emoji.length && !o.dash.length, JSON.stringify(o));
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Steg för steg" }).click();
  await page.waitForTimeout(300);
  o = offenders(await uiText());
  check("stegvyn: inga emojis eller tankstreck", !o.emoji.length && !o.dash.length, JSON.stringify(o));

  check("inga externa nätverksanrop", external.length === 0, external.join(", "));
  check("inga konsolfel", problems.length === 0, problems.join(" | "));
} catch (e) {
  failed++;
  console.log("✗ oväntat fel:", e.message);
} finally {
  await browser.close();
  await server?.close();
}
process.exit(failed ? 1 : 0);
