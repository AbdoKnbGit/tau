import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { test } from 'node:test'
import { createRequire } from 'node:module'

// Run the real approval controller with deferred model/storage boundaries so
// session changes and manual renames can be placed at the dangerous awaits.
const modules = {
  '../bootstrap/state.js':
    'export const isSessionPersistenceDisabled = () => fixture.persistenceDisabled; export const onSessionSwitch = () => () => {};',
  '../commands/rename/generateSessionName.js': `export const generateSessionName = (messages, signal) => {
    fixture.modelCalls.push({ messages, signal }); return fixture.generate(messages, signal);
  };`,
  './log.js': 'export const logError = error => fixture.errors.push(error);',
  './messages.js': 'export const createUserMessage = message => message;',
  './plans.js': `export const capturePlanFileOwner = () => fixture.currentOwner;
    export const isPlanFileOwnerCurrent = owner =>
    owner.sessionId === fixture.currentOwner.sessionId && owner.planId === fixture.currentOwner.planId && owner.directory === fixture.currentOwner.directory;
    export const renamePlanFileFromTitle = async (owner, title) => {
      fixture.renames.push({ owner, title }); await fixture.afterRename?.(); return fixture.renameResult;
    };
    export const addPlanFileRenameNotice = notice => fixture.notifications.push(notice);
    export const discardPlanFileRenameNotices = (all = false) => {
      fixture.notifications = all ? [] : fixture.notifications.filter(notice => isPlanFileOwnerCurrent(notice.owner));
    };`,
  './sessionStorage.js': `export const getCurrentSessionTitle = () => fixture.title;
    export const getTranscriptPath = () => '/transcripts/' + fixture.currentOwner.sessionId + '.jsonl';
    export const saveCustomTitle = async (sessionId, title, path, source) => {
      fixture.saves.push({ kind: 'title', sessionId, title, path, source }); fixture.title = title;
      await fixture.afterTitleSave?.();
    };
    export const saveAgentName = async (sessionId, title, path, source) => {
      fixture.saves.push({ kind: 'agent', sessionId, title, path, source }); await fixture.afterAgentSave?.();
    };`,
  './settings/settings.js':
    'export const getSettings_DEPRECATED = () => ({ cleanupPeriodDays: fixture.cleanupPeriodDays });',
}
const compiled = await build({
  entryPoints: ['src/utils/planApprovalNaming.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  plugins: [
    {
      name: 'approval-fixture',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          modules[args.path]
            ? { path: args.path, namespace: 'fixture' }
            : undefined,
        )
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: modules[args.path],
          loader: 'js',
        }))
      },
    },
  ],
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup(overrides = {}) {
  const owner = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    planId: 'original-plan',
    directory: '/plans',
  }
  const fixture = {
    currentOwner: owner,
    title: undefined,
    persistenceDisabled: false,
    cleanupPeriodDays: 30,
    generate: async () => 'add-oauth-login',
    renameResult: {
      status: 'renamed',
      oldPath: '/plans/original-plan.md',
      newPath: '/plans/add-oauth-login.md',
    },
    modelCalls: [],
    saves: [],
    renames: [],
    notifications: [],
    errors: [],
    invalidations: [],
    appState: {},
    ...overrides,
  }
  const module = { exports: {} }
  new Function(
    'module',
    'exports',
    'fixture',
    'require',
    compiled.outputFiles[0].text,
  )(module, module.exports, fixture, createRequire(import.meta.url))
  const options = {
    setAppState(update) {
      fixture.appState = update(fixture.appState)
    },
    readFileState: {
      delete(path) {
        fixture.invalidations.push(path)
        return true
      },
    },
  }
  return {
    fixture,
    owner,
    controller: module.exports,
    options,
    run: (request = { plan: '# OAuth login\n' + 'x'.repeat(2000), owner }) =>
      module.exports.nameSessionFromApprovedPlan(request, options),
  }
}

test('successful approval names its captured execution session and announces the actual new path', async () => {
  const { fixture, owner, run } = setup()
  await run()
  assert.equal(fixture.modelCalls.length, 1)
  assert.equal(fixture.modelCalls[0].messages[0].content.length, 1000)
  assert.match(fixture.modelCalls[0].messages[0].content, /^# OAuth login/)
  assert.deepEqual(
    fixture.saves.map((entry) => [
      entry.kind,
      entry.sessionId,
      entry.path,
      entry.source,
    ]),
    [
      [
        'title',
        owner.sessionId,
        `/transcripts/${owner.sessionId}.jsonl`,
        'auto',
      ],
      [
        'agent',
        owner.sessionId,
        `/transcripts/${owner.sessionId}.jsonl`,
        'auto',
      ],
    ],
  )
  assert.equal(fixture.appState.standaloneAgentContext.name, 'add-oauth-login')
  assert.deepEqual(fixture.renames, [{ owner, title: 'add-oauth-login' }])
  assert.deepEqual(fixture.invalidations, [
    '/plans/original-plan.md',
    '/plans/add-oauth-login.md',
  ])
  // Held for the next model request; never a queued command that could start
  // a turn by itself when the session is idle.
  assert.deepEqual(fixture.notifications, [
    {
      owner,
      oldPath: '/plans/original-plan.md',
      newPath: '/plans/add-oauth-login.md',
    },
  ])
})

test('a pending rename notice is dropped when its session stops being current', async () => {
  const { fixture, owner, run, controller } = setup()
  await run()
  assert.equal(fixture.notifications.length, 1)
  fixture.currentOwner = {
    ...owner,
    sessionId: '22222222-2222-4222-8222-222222222222',
  }
  controller.cancelStalePlanApprovalNaming()
  assert.deepEqual(fixture.notifications, [])
})

test('a filename move invalidates equivalent cache keys while retaining unrelated read evidence', async () => {
  const { run, options } = setup()
  const oldAlias = '/plans/../plans/original-plan.md'
  const newAlias = '/plans/../plans/add-oauth-login.md'
  const unrelated = '/workspace/app.ts'
  const reads = new Map([
    [oldAlias, {}],
    [newAlias, {}],
    [unrelated, {}],
  ])
  options.readFileState = reads
  await run()
  assert.deepEqual([...reads.keys()], [unrelated])
})

for (const overrides of [
  { title: 'user-selected' },
  { persistenceDisabled: true },
  { cleanupPeriodDays: 0 },
]) {
  test(`ineligible approval makes no naming request: ${JSON.stringify(overrides)}`, async () => {
    const { fixture, run } = setup(overrides)
    await run()
    assert.equal(fixture.modelCalls.length, 0)
    assert.deepEqual(fixture.saves, [])
    assert.deepEqual(fixture.renames, [])
  })
}

for (const name of [null, '', ' \n\t ']) {
  test(`absent or blank generated title preserves the filename: ${JSON.stringify(name)}`, async () => {
    const { fixture, run } = setup({ generate: async () => name })
    await run()
    assert.deepEqual(fixture.saves, [])
    assert.deepEqual(fixture.renames, [])
    assert.deepEqual(fixture.notifications, [])
  })
}

for (const transition of ['session', 'plan', 'directory']) {
  test(`a ${transition} change during generation cannot name or move another plan`, async () => {
    const generated = deferred()
    const { fixture, owner, run, controller } = setup({
      generate: () => generated.promise,
    })
    const pending = run()
    fixture.currentOwner = {
      ...owner,
      ...(transition === 'session'
        ? { sessionId: '22222222-2222-4222-8222-222222222222' }
        : transition === 'plan'
          ? { planId: 'other-plan' }
          : { directory: '/other-plans' }),
    }
    controller.cancelStalePlanApprovalNaming()
    assert.equal(fixture.modelCalls[0].signal.aborted, true)
    generated.resolve('late-name')
    await pending
    assert.deepEqual(fixture.saves, [])
    assert.deepEqual(fixture.renames, [])
    assert.deepEqual(fixture.appState, {})
  })
}

test('manual rename during generation wins', async () => {
  const generated = deferred()
  const { fixture, run } = setup({ generate: () => generated.promise })
  const pending = run()
  fixture.title = 'user-selected'
  generated.resolve('auto-generated')
  await pending
  assert.equal(fixture.title, 'user-selected')
  assert.deepEqual(fixture.saves, [])
  assert.deepEqual(fixture.renames, [])
})

for (const boundary of ['afterTitleSave', 'afterAgentSave']) {
  test(`manual rename at ${boundary} prevents stale UI and file mutations`, async () => {
    const saved = deferred(),
      release = deferred()
    const { fixture, run } = setup({
      [boundary]: () => {
        saved.resolve()
        return release.promise
      },
    })
    const pending = run()
    await saved.promise
    fixture.title = 'user-selected'
    release.resolve()
    await pending
    assert.equal(fixture.title, 'user-selected')
    assert.deepEqual(fixture.renames, [])
    assert.deepEqual(fixture.appState, {})
  })

  test(`session transition at ${boundary} stops the old approval`, async () => {
    const saved = deferred(),
      release = deferred()
    const { fixture, owner, run, controller } = setup({
      [boundary]: () => {
        saved.resolve()
        return release.promise
      },
    })
    const pending = run()
    await saved.promise
    fixture.currentOwner = {
      ...owner,
      sessionId: '22222222-2222-4222-8222-222222222222',
    }
    fixture.title = undefined
    fixture.appState = { standaloneAgentContext: { name: 'new-session-agent' } }
    controller.cancelStalePlanApprovalNaming()
    release.resolve()
    await pending
    assert.equal(fixture.title, undefined)
    assert.deepEqual(fixture.renames, [])
    assert.equal(
      fixture.appState.standaloneAgentContext.name,
      'new-session-agent',
    )
    assert.ok(
      fixture.saves.every((entry) => entry.sessionId === owner.sessionId),
    )
  })
}

test('superseded approval is aborted and only its successor can apply', async () => {
  const first = deferred(),
    second = deferred()
  let count = 0
  const { fixture, run } = setup({
    generate: () => (++count === 1 ? first.promise : second.promise),
  })
  const firstRun = run(),
    secondRun = run()
  assert.equal(fixture.modelCalls[0].signal.aborted, true)
  first.resolve('obsolete-name')
  await firstRun
  assert.deepEqual(fixture.saves, [])
  second.resolve('current-name')
  await secondRun
  assert.equal(fixture.title, 'current-name')
  assert.deepEqual(
    fixture.renames.map((entry) => entry.title),
    ['current-name'],
  )
})

test('clear-context source owner cannot be reused to name its new execution session', async () => {
  const { fixture, owner, options, controller } = setup()
  const targetOwner = {
    ...owner,
    sessionId: '22222222-2222-4222-8222-222222222222',
  }
  fixture.currentOwner = targetOwner
  await controller.nameSessionFromApprovedPlan(
    { plan: '# Plan', owner },
    options,
  )
  assert.equal(fixture.modelCalls.length, 0)
  await controller.nameSessionFromApprovedPlan(
    { plan: '# Plan', owner: targetOwner },
    options,
  )
  assert.equal(fixture.modelCalls.length, 1)
  assert.equal(fixture.saves[0].sessionId, targetOwner.sessionId)
  assert.equal(
    fixture.saves[0].path,
    `/transcripts/${targetOwner.sessionId}.jsonl`,
  )
})

for (const status of ['unchanged', 'skipped']) {
  test(`${status} rename does not invalidate reads or announce a move`, async () => {
    const { fixture, run } = setup({
      renameResult: {
        status,
        oldPath: '/plans/original.md',
        newPath: '/plans/original.md',
      },
    })
    await run()
    assert.equal(fixture.title, 'add-oauth-login')
    assert.deepEqual(fixture.invalidations, [])
    assert.deepEqual(fixture.notifications, [])
  })
}

test('a completed move cannot announce itself to a different session after its await', async () => {
  const moved = deferred(),
    release = deferred()
  const { fixture, owner, run, controller } = setup({
    afterRename: () => {
      moved.resolve()
      return release.promise
    },
  })
  const pending = run()
  await moved.promise
  fixture.currentOwner = {
    ...owner,
    sessionId: '22222222-2222-4222-8222-222222222222',
  }
  controller.cancelStalePlanApprovalNaming()
  release.resolve()
  await pending
  assert.equal(fixture.renames.length, 1)
  assert.deepEqual(fixture.invalidations, [])
  assert.deepEqual(fixture.notifications, [])
})
