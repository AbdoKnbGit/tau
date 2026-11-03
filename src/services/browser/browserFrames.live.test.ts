/**
 * Real Chromium regression coverage for frame-scoped Browser actions.
 * Run manually: bun run src/services/browser/browserFrames.live.test.ts
 *
 * Uses only ephemeral local HTTP fixtures and a newly created browser profile.
 * localhost and 127.0.0.1 deliberately form different sites; --site-per-process
 * makes the cross-site frames exercise real flattened child CDP sessions.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";

import { findBrowserExecutable } from "./chromeLauncher.js";
import { CdpClient } from "./cdp.js";
import { buildStepFromAction } from "./flowRunner.js";
import {
  getBrowserSession,
  type BrowserActionOutcome,
  type BrowserSessionService,
} from "./browserSession.js";
import type { InteractiveElement, ObservedState } from "./pageScripts.js";

type FrameSession = BrowserSessionService & {
  switchFrame(ref?: number, signal?: AbortSignal): Promise<BrowserActionOutcome>;
};

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let passed = 0;

function assert(condition: unknown, hint: string): asserts condition {
  if (!condition) throw new Error(hint);
}

function successful(outcome: BrowserActionOutcome, action: string): void {
  assert(outcome.ok, `${action}: ${outcome.reason ?? "failure"}: ${outcome.error ?? ""}`);
}

async function check(name: string, work: () => Promise<void>): Promise<void> {
  await work();
  passed += 1;
  console.log(`  ok  ${name}`);
}

function findElement(state: ObservedState, matches: (el: InteractiveElement) => boolean): InteractiveElement {
  const element = state.interactive_elements.find(matches);
  assert(element, `Missing element; observed ${JSON.stringify(state.interactive_elements.map(({ id, tag, text, aria }) => ({ id, tag, text, aria })))}`);
  return element;
}

async function observeRef(session: FrameSession, label: string, tag?: string): Promise<number> {
  const { observation } = await session.observe();
  return findElement(observation, (el) =>
    (!tag || el.tag === tag) && `${el.text} ${el.aria ?? ""} ${el.placeholder ?? ""}`.includes(label),
  ).id;
}

async function valueOf<T>(session: FrameSession, expression: string): Promise<T> {
  const outcome = await session.evalJs(expression);
  assert(outcome.ok, `evalJs failed: ${outcome.error}`);
  assert(outcome.value !== undefined, `evalJs returned no value for ${expression}`);
  return JSON.parse(outcome.value) as T;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>html,body{margin:0;font:16px Arial}h1{font-size:20px;margin:12px}p{margin:8px 12px}
    iframe{display:block;border:7px solid #735bad;margin-left:43px;margin-top:21px}
    button{width:180px;height:44px;margin:12px;background:rgb(9,201,181);border:0;border-radius:0;color:#000}
    input{height:24px;margin:8px}label{display:block}*{box-sizing:border-box}</style></head>
    <body>${body}</body></html>`;
}

async function fixtureServer(): Promise<{ server: Server; port: number }> {
  let port = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.local").pathname;
    const local = `http://localhost:${port}`;
    const numeric = `http://127.0.0.1:${port}`;
    const bodies: Record<string, string> = {
      "/top": page("Top fixture", `<h1>TOP ONLY CONTENT</h1><button id="top">Top control</button>
        <label>Parent field <input id="parent-field" value="parent-initial"></label>
        <iframe id="cross" title="Cross frame" aria-label="Cross frame" src="${local}/cross" width="1050" height="700"></iframe>
        <script>window.addEventListener('message',event=>{if(event.data==='focus-parent')document.querySelector('#parent-field').focus();});</script>`),
      "/cross": page("Cross fixture", `<h1>CROSS ONLY CONTENT</h1>
        <button id="cross-action">Cross action</button><label>Cross value <input id="cross-value"></label>
        <iframe id="same" title="Same frame" aria-label="Same frame" src="${local}/same" width="900" height="480"></iframe>
        <script>window.clicked=0;document.querySelector('button').addEventListener('click',event=>{window.clicked++;window.trusted=event.isTrusted;});</script>`),
      "/same": page("Same fixture", `<h1>SAME ONLY CONTENT</h1>
        <iframe id="leaf" title="Leaf frame" aria-label="Leaf frame" src="${numeric}/leaf" width="720" height="320"></iframe>`),
      "/leaf": page("Leaf fixture", `<h1>LEAF ONLY CONTENT</h1><button id="leaf-action">Leaf action</button>
        <label>Leaf value <input id="leaf-value"></label><label>Leaf attachment <input id="leaf-file" type="file"></label>
        <label>Access phrase <input id="login-value" name="loginValue" type="password" autocomplete="current-password"></label>
        <div id="authToken" contenteditable="true" role="textbox" aria-label="Value" style="min-height:24px;margin:8px">already-stored-private-value</div>
        <input id="mutable-value" name="inputGeneric" type="text" aria-label="Value">
        <script>window.clicked=0;document.querySelector('button').addEventListener('click',event=>{window.clicked++;window.trusted=event.isTrusted;});</script>`),
      "/other": page("Other fixture", `<h1>OTHER TAB CONTENT</h1><button>Other control</button>`),
    };
    response.writeHead(bodies[pathname] ? 200 : 404, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(bodies[pathname] ?? "Not found");
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => done());
  });
  const address = server.address();
  assert(address && typeof address === "object", "Fixture server did not obtain a port");
  port = address.port;
  return { server, port };
}

async function startIsolatedBrowser(executable: string, root: string): Promise<{ child: ChildProcess; port: number; wsUrl: string }> {
  const profile = join(root, "profile");
  const child = spawn(executable, [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--headless=new",
    "--site-per-process",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--window-size=1280,1000",
    ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  const deadline = Date.now() + 20_000;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert(child.exitCode === null, `Chromium exited with code ${child.exitCode}`);
      try {
        const [portLine, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
        const port = Number(portLine);
        if (port > 0 && path) return { child, port, wsUrl: `ws://127.0.0.1:${port}${path.trim()}` };
      } catch { /* Chrome has not written the port file yet. */ }
      await pause(100);
    }
    throw new Error("Temporary Chromium did not expose DevTools within 20 seconds");
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function main(): Promise<void> {
  const executable = await findBrowserExecutable();
  if (!executable) {
    console.log("SKIP live browser frames: no Chromium executable found; set TAU_BROWSER_PATH to run.");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "tau-browser-frames-live-"));
  const originalConnectPort = process.env.TAU_BROWSER_CONNECT_PORT;
  const SessionCtor = getBrowserSession().constructor as new () => FrameSession;
  const session = new SessionCtor();
  let fixture: Awaited<ReturnType<typeof fixtureServer>> | undefined;
  let browser: Awaited<ReturnType<typeof startIsolatedBrowser>> | undefined;
  let witness: CdpClient | undefined;
  const watchdog = setTimeout(() => {
    console.error("FAIL live browser frame test exceeded 180 seconds");
    process.exitCode = 1;
    browser?.child.kill();
  }, 180_000);

  try {
    fixture = await fixtureServer();
    browser = await startIsolatedBrowser(executable, root);
    process.env.TAU_BROWSER_CONNECT_PORT = String(browser.port);
    witness = await CdpClient.connect(browser.wsUrl);
    const started = await session.ensureStarted({ headless: true });
    assert(started.launched === "attached", "The test must attach only to its own temporary Chromium");
    assert(typeof session.switchFrame === "function", "BrowserSessionService.switchFrame has not been implemented");
    const topUrl = `http://127.0.0.1:${fixture.port}/top`;
    await session.navigate(topUrl);

    await check("real OOPIF exists and the top observation exposes its frame ref", async () => {
      const { targetInfos } = await witness!.send<{ targetInfos: Array<{ type: string; url: string }> }>("Target.getTargets");
      assert(targetInfos.some((target) => target.type === "iframe" && target.url.includes("localhost:")), "Fixture did not create an out-of-process cross-site iframe");
      await observeRef(session, "Cross frame", "iframe");
    });

    await check("enter cross-origin frame; read/eval/fill use that document", async () => {
      successful(await session.switchFrame(await observeRef(session, "Cross frame", "iframe")), "enter cross frame");
      assert(await valueOf<string>(session, "location.pathname") === "/cross", "eval did not enter /cross");
      const read = await session.readPage({ maxChars: 4000 });
      assert(read.success && read.content?.includes("CROSS ONLY CONTENT"), `read missed focused frame: ${JSON.stringify(read)}`);
      assert(!read.content?.includes("TOP ONLY CONTENT"), "focused read leaked top-document content");
      successful(await session.fill(await observeRef(session, "Cross value", "input"), "cross input value"), "cross fill");
      assert(await valueOf<string>(session, "document.querySelector('#cross-value').value") === "cross input value", "fill changed another document");
    });

    await check("trusted click in a cross-origin frame lands at the top-page offset", async () => {
      successful(await session.click({ ref: await observeRef(session, "Cross action", "button") }), "cross click");
      const clicked = await valueOf<{ count: number; trusted: boolean }>(session, "({count:window.clicked,trusted:window.trusted})");
      assert(clicked.count === 1 && clicked.trusted === true, `Cross-frame native click missed: ${JSON.stringify(clicked)}`);
    });

    await check("nested same-origin then cross-origin contexts retain input coordinates", async () => {
      successful(await session.switchFrame(await observeRef(session, "Same frame", "iframe")), "enter same frame");
      assert(await valueOf<string>(session, "location.pathname") === "/same", "same-origin nested context was not selected");
      successful(await session.switchFrame(await observeRef(session, "Leaf frame", "iframe")), "enter nested cross frame");
      assert(await valueOf<string>(session, "location.pathname") === "/leaf", "nested cross-origin context was not selected");
      successful(await session.fill(await observeRef(session, "Leaf value", "input"), "nested value"), "nested fill");
      successful(await session.click({ ref: await observeRef(session, "Leaf action", "button") }), "nested click");
      const actual = await valueOf<{ count: number; trusted: boolean; value: string }>(session,
        "({count:window.clicked,trusted:window.trusted,value:document.querySelector('#leaf-value').value})");
      assert(actual.count === 1 && actual.trusted === true && actual.value === "nested value", `Nested native input missed: ${JSON.stringify(actual)}`);
    });

    await check("focused-frame upload reaches the real file input", async () => {
      const uploadPath = join(root, "attachment.txt");
      await writeFile(uploadPath, "nested upload fixture", "utf8");
      successful(await session.upload(await observeRef(session, "Leaf attachment", "input"), [uploadPath]), "nested upload");
      const file = await valueOf<{ name: string; text: string }>(session,
        "(async()=>{const file=document.querySelector('#leaf-file').files[0];return {name:file.name,text:await file.text()};})()");
      assert(file.name === "attachment.txt" && file.text === "nested upload fixture", `Wrong uploaded file: ${JSON.stringify(file)}`);
    });

    await check("real password metadata prevents filled and typed values entering recordings", async () => {
      const secret = "saffron-bird-46";
      const { observation } = await session.observe();
      const field = findElement(observation, (el) => el.tag === "input" && el.text.includes("Access phrase"));
      assert(field.type === "password" && field.autocomplete === "current-password", "The real observed password field lost its metadata");
      const fillStep = buildStepFromAction({ action: "fill", ref: field.id, value: secret }, field, observation.interactive_elements);
      assert(fillStep?.unreplayable && fillStep.value === undefined && !JSON.stringify(fillStep).includes(secret), "Password fill would persist plaintext");
      successful(await session.fill(field.id, secret), "password fill");
      assert(!JSON.stringify((await session.observe()).observation).includes(secret), "Password leaked into the returned observation");
      const focused = await session.focusedFlowField();
      assert(focused?.type === "password" && !JSON.stringify(focused).includes(secret), `Focused field metadata lost its sensitivity or included its value: ${JSON.stringify(focused)}`);
      const typedStep = buildStepFromAction({ action: "type", text: "additional phrase" }, undefined, undefined, focused);
      assert(typedStep?.unreplayable && typedStep.text === undefined, "Typing into a real password focus would persist plaintext");
      successful(await session.typeText("additional phrase", false), "native password typing");
      assert((await valueOf<string>(session, "document.querySelector('#login-value').value")).includes("additional phrase"), "Native typing did not reach the focused password in the nested frame");
      assert(!JSON.stringify((await session.observe()).observation).includes("additional phrase"), "Typed password text leaked into the returned observation");
    });

    await check("contenteditable sensitivity reaches flow recording without using its content as a label", async () => {
      const { observation } = await session.observe();
      const editable = findElement(observation, (el) => el.tag === "div" && el.aria === "Value");
      assert(editable.text === "Value" && editable.sensitive === true && editable.name?.includes("authToken"),
        `Contenteditable metadata lost its name or sensitivity: ${JSON.stringify(editable)}`);
      assert(editable.value === undefined, "Sensitive contenteditable value was exposed in the element inventory");
      const secret = "cedar-forest-access";
      const step = buildStepFromAction({ action: "fill", ref: editable.id, value: secret }, editable, observation.interactive_elements);
      assert(step?.unreplayable && step.value === undefined && !JSON.stringify(step).includes(secret), "Contenteditable token would persist in a recorded fill");
      successful(await session.fill(editable.id, secret), "sensitive contenteditable fill");
      const after = (await session.observe()).observation;
      const updated = findElement(after, (el) => el.tag === "div" && el.aria === "Value");
      assert(updated.text === "Value" && updated.value === undefined && updated.sensitive === true, "Filled contenteditable lost its protected name/value metadata");
    });

    await check("fresh field metadata catches a password type change after observation", async () => {
      const { observation } = await session.observe();
      const field = findElement(observation, (el) => el.tag === "input" && el.aria === "Value");
      assert(field.type === "text" && !field.sensitive, "Mutable fixture was not initially a harmless text input");
      await session.evalJs("document.querySelector('#mutable-value').type='password'; true");
      const metadata = await session.flowFieldForRef(field.id);
      assert(metadata.type === "password", `Fresh ref metadata missed the unobserved type change: ${JSON.stringify(metadata)}`);
      const secret = "moss47";
      const step = buildStepFromAction({ action: "fill", ref: field.id, value: secret }, { ...field, ...metadata, id: field.id }, observation.interactive_elements);
      assert(step?.unreplayable && step.value === undefined && !JSON.stringify(step).includes(secret), "A stale text-input observation allowed a new password value into recording");
    });

    await check("a selected child cannot send typing or keys into a parent that stole focus", async () => {
      successful(await session.click({ ref: await observeRef(session, "Leaf value", "input") }), "focus child field");
      assert(await valueOf<boolean>(session, "document.hasFocus() && document.activeElement.id === 'leaf-value'"), "Child input never acquired real keyboard focus");
      // No observe after this point: its nudge can focus the selected document.
      // postMessage lets the parent focus its own field without weakening SOP.
      await session.evalJs("top.postMessage('focus-parent','*'); true");
      let focusLost = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await valueOf<boolean>(session, "!document.hasFocus()")) { focusLost = true; break; }
        await pause(20);
      }
      assert(focusLost, "Parent did not steal actual browser focus");
      const before = await valueOf<string>(session, "top.document.querySelector('#parent-field').value");
      const focused = await session.focusedFlowField();
      assert(focused?.sensitive === true, "Unfocused frame did not fail closed when collecting typing metadata");
      const typed = await session.typeText("must-not-type-in-parent", false);
      assert(!typed.ok && typed.reason === "not_editable", `Typing was accepted without selected-frame focus: ${JSON.stringify(typed)}`);
      const pressed = await session.press("Backspace");
      assert(!pressed.ok && pressed.reason === "not_editable", `Keyboard input was accepted without selected-frame focus: ${JSON.stringify(pressed)}`);
      assert(await valueOf<string>(session, "top.document.querySelector('#parent-field').value") === before, "Refused frame keyboard input mutated the parent's field");
    });

    await check("element screenshot clips the nested element in the whole tab", async () => {
      const screenshot = await session.screenshot({ ref: await observeRef(session, "Leaf action", "button"), path: join(root, "leaf.png") });
      assert(screenshot.savedPath, "Element screenshot did not save a PNG");
      const { data, info } = await sharp(screenshot.savedPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      assert(info.width >= 140 && info.height >= 35 && info.width < 240 && info.height < 90, `Unexpected element crop dimensions ${info.width}x${info.height}`);
      const offset = (5 * info.width + 5) * info.channels;
      assert(Math.abs(data[offset]! - 9) < 12 && Math.abs(data[offset + 1]! - 201) < 12 && Math.abs(data[offset + 2]! - 181) < 12,
        `Element crop is not the teal leaf button: ${Array.from(data.subarray(offset, offset + 3))}`);
      const full = await session.screenshot();
      assert((full.meta?.width ?? 0) > 700 && (full.meta?.height ?? 0) > 500, "Unscoped screenshot was restricted to the focused iframe");
    });

    await check("frame reload invalidates refs without retargeting them", async () => {
      const stale = await observeRef(session, "Leaf action", "button");
      await session.evalJs("setTimeout(()=>location.reload(),0); true");
      await pause(350);
      const result = await session.click({ ref: stale });
      assert(!result.ok, "A pre-reload frame ref was accepted after its document was replaced");
      successful(await session.switchFrame(), "return to top after frame reload");
      assert(await valueOf<string>(session, "location.pathname") === "/top", "no-argument switchFrame did not return to top");
    });

    await check("removed focused frame fails safely and can return to top", async () => {
      // The parent listener is installed through its own context rather than
      // relaxing browser cross-origin checks in the fixture.
      await session.evalJs("window.addEventListener('message',event=>{if(event.data==='remove-cross')document.querySelector('#cross')?.remove();}); true");
      successful(await session.switchFrame(await observeRef(session, "Cross frame", "iframe")), "enter removable frame");
      const stale = await observeRef(session, "Cross action", "button");
      await session.evalJs("setTimeout(()=>parent.postMessage('remove-cross','*'),20); true");
      await pause(200);
      let rejected = false;
      try { rejected = !(await session.click({ ref: stale })).ok; } catch { rejected = true; }
      assert(rejected, "An action in a removed frame was reported as successful");
      successful(await session.switchFrame(), "escape removed frame");
      assert(await valueOf<string>(session, "location.pathname") === "/top", "Could not escape a removed frame");
    });

    await check("frame selection cannot leak to another tab", async () => {
      await session.navigate(topUrl);
      const original = (await session.listTabs()).find((tab) => tab.active);
      assert(original, "No original tab");
      successful(await session.switchFrame(await observeRef(session, "Cross frame", "iframe")), "enter frame before switching tab");
      await session.newTab(`http://127.0.0.1:${fixture!.port}/other`);
      assert(await valueOf<string>(session, "location.pathname") === "/other", "Previous tab's focused frame leaked to new tab");
      const originalIndex = (await session.listTabs()).find((tab) => tab.targetId === original.targetId)?.index;
      assert(originalIndex !== undefined, "Original tab disappeared");
      await session.selectTab(originalIndex);
      // A return may restore the old per-tab frame or intentionally reset it;
      // both policies are safe, provided this tab's own document is selected.
      const path = await valueOf<string>(session, "location.pathname");
      assert(path === "/top" || path === "/cross", `Tab return selected a foreign context: ${path}`);
      successful(await session.switchFrame(), "return original tab to top");
      assert(await valueOf<string>(session, "location.pathname") === "/top", "Returned tab could not reach its top document");
    });

    console.log(`\n${passed} live browser frame checks passed (${executable}).`);
  } finally {
    clearTimeout(watchdog);
    await session.closeBrowser().catch(() => undefined);
    if (witness?.isOpen) await witness.send("Browser.close", {}, undefined, 3000).catch(() => undefined);
    witness?.close();
    if (browser?.child.exitCode === null) {
      await Promise.race([new Promise<void>((done) => browser!.child.once("exit", () => done())), pause(3000)]);
      if (browser.child.exitCode === null) browser.child.kill();
    }
    if (fixture) await new Promise<void>((done) => fixture!.server.close(() => done()));
    if (originalConnectPort === undefined) delete process.env.TAU_BROWSER_CONNECT_PORT;
    else process.env.TAU_BROWSER_CONNECT_PORT = originalConnectPort;
    assert(dirname(resolve(root)) === resolve(tmpdir()) && basename(root).startsWith("tau-browser-frames-live-"), "Refusing cleanup outside the generated temporary directory");
    await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(`FAIL live browser frames after ${passed} checks:`, error);
  process.exitCode = 1;
});
