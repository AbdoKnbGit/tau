/**
 * Regression tests for human-active-tab synchronization.
 *
 * Run: bun run src/services/browser/browserSession.test.ts
 */

import {
  buildTabActivityScript,
  getBrowserSession,
  shouldAdoptTabActivity,
  type BrowserSessionService,
  type TabActivityProbe,
} from "./browserSession.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, hint: string): void {
  if (!condition) throw new Error(hint);
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error: unknown) {
    failed++;
    console.log(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error: unknown) {
    failed++;
    console.log(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface SendCall {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface FakeClient {
  isOpen: boolean;
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T>;
}

function fakeClient(
  handler: (call: SendCall) => unknown | Promise<unknown>,
): FakeClient {
  return {
    isOpen: true,
    async send<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ): Promise<T> {
      return (await handler({ method, params, sessionId })) as T;
    },
  };
}

type SessionHarness = {
  client?: FakeClient;
  activeTargetId?: string;
  activityBindingName: string;
  sessions: Map<string, string>;
  sessionToTarget: Map<string, string>;
  sessionPromises: Map<string, Promise<string>>;
  fullyPreparedTargets: Set<string>;
  activityTargets: Set<string>;
  sessionNotes: string[];
  ensureTargetSession(targetId: string): Promise<string>;
  handleTabActivityBinding(
    params: { name?: string },
    sessionId?: string,
  ): Promise<void>;
  selectTab: BrowserSessionService["selectTab"];
};

const SessionCtor = getBrowserSession()
  .constructor as unknown as new () => BrowserSessionService;
const freshSession = () =>
  new SessionCtor() as unknown as SessionHarness;

async function main(): Promise<void> {
  console.log("tab activity script:");

  test("uses trusted events and focus verification without polling", () => {
    const script = buildTabActivityScript("__testBinding");
    assert(script.includes("event.isTrusted !== true"), "must reject synthetic events");
    assert(script.includes("document.hasFocus()"), "must require document focus");
    assert(
      script.includes("document.visibilityState !== 'visible'"),
      "must require a visible document",
    );
    assert(script.includes("previous.cleanup()"), "must clean up its prior listeners");
    assert(!script.includes("setInterval"), "must not introduce a polling loop");
  });

  console.log("shouldAdoptTabActivity:");

  const visibleFocus: TabActivityProbe = {
    focused: true,
    visible: true,
  };
  test("adopts a different focused and visible tab", () => {
    assert(
      shouldAdoptTabActivity("tab-a", "tab-b", visibleFocus),
      "focused candidate should be adopted",
    );
  });
  test("rejects the current, hidden, and unfocused tabs", () => {
    assert(
      !shouldAdoptTabActivity("tab-a", "tab-a", visibleFocus),
      "current tab is not a switch",
    );
    assert(
      !shouldAdoptTabActivity("tab-a", "tab-b", {
        focused: true,
        visible: false,
      }),
      "hidden tab must be rejected",
    );
    assert(
      !shouldAdoptTabActivity("tab-a", "tab-b", {
        focused: false,
        visible: true,
      }),
      "unfocused tab must be rejected",
    );
  });

  console.log("explicit tab switching:");

  await testAsync("activates the real browser tab before adopting it", async () => {
    const calls: SendCall[] = [];
    const session = freshSession();
    session.activeTargetId = "tab-a";
    session.sessions.set("tab-b", "session-b");
    session.sessionToTarget.set("session-b", "tab-b");
    session.fullyPreparedTargets.add("tab-b");
    session.client = fakeClient((call) => {
      calls.push(call);
      if (call.method === "Target.getTargets") {
        return {
          targetInfos: [
            {
              targetId: "tab-a",
              type: "page",
              title: "A",
              url: "https://a.test/",
            },
            {
              targetId: "tab-b",
              type: "page",
              title: "B",
              url: "https://b.test/",
            },
          ],
        };
      }
      return {};
    });

    await session.selectTab(1);

    const activation = calls.find((call) => call.method === "Target.activateTarget");
    assert(
      activation?.params?.targetId === "tab-b",
      `visible tab was not activated: ${JSON.stringify(calls)}`,
    );
    assert(session.activeTargetId === "tab-b", "internal active target must follow");
  });

  console.log("human activity handoff:");

  await testAsync("follows a focused tab and emits one handoff note", async () => {
    const session = freshSession();
    session.activeTargetId = "tab-a";
    session.sessions.set("tab-b", "session-b");
    session.sessionToTarget.set("session-b", "tab-b");
    session.client = fakeClient((call) => {
      if (call.method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              focused: true,
              visible: true,
              url: "https://b.test/",
              title: "Focused B",
            },
          },
        };
      }
      return {};
    });

    await session.handleTabActivityBinding(
      { name: session.activityBindingName },
      "session-b",
    );
    await session.handleTabActivityBinding(
      { name: session.activityBindingName },
      "session-b",
    );

    assert(session.activeTargetId === "tab-b", "focused tab must become active");
    assert(session.sessionNotes.length === 1, "handoff should be announced once");
    assert(
      session.sessionNotes[0]?.includes("Focused B") === true,
      `handoff note lacks the tab label: ${session.sessionNotes[0]}`,
    );
  });

  await testAsync("ignores a forged/background activity report", async () => {
    const session = freshSession();
    session.activeTargetId = "tab-a";
    session.sessions.set("tab-b", "session-b");
    session.sessionToTarget.set("session-b", "tab-b");
    session.client = fakeClient((call) => {
      if (call.method === "Runtime.evaluate") {
        return {
          result: {
            value: { focused: false, visible: true, url: "https://b.test/" },
          },
        };
      }
      return {};
    });

    await session.handleTabActivityBinding(
      { name: session.activityBindingName },
      "session-b",
    );

    assert(session.activeTargetId === "tab-a", "background tab must not hijack focus");
    assert(session.sessionNotes.length === 0, "rejected report must stay silent");
  });

  console.log("attachment coalescing:");

  await testAsync("attaches and installs activity tracking once per tab", async () => {
    const calls: SendCall[] = [];
    const session = freshSession();
    session.client = fakeClient(async (call) => {
      calls.push(call);
      if (call.method === "Target.attachToTarget") {
        await Promise.resolve();
        return { sessionId: "session-new" };
      }
      return {};
    });

    const [first, second] = await Promise.all([
      session.ensureTargetSession("tab-new"),
      session.ensureTargetSession("tab-new"),
    ]);

    assert(first === "session-new" && second === first, "sessions must be shared");
    assert(
      calls.filter((call) => call.method === "Target.attachToTarget").length === 1,
      "concurrent discovery must attach only once",
    );
    assert(
      calls.filter((call) => call.method === "Runtime.addBinding").length === 1,
      "activity binding must be installed only once",
    );
    assert(
      calls.filter((call) => call.method === "Page.addScriptToEvaluateOnNewDocument")
        .length === 1,
      "new-document tracker must be installed only once",
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
