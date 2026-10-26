import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const originalCwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-mod-process-platform-'))
const project = join(root, 'project with spaces')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: ['src/utils/plugins/mods/host.ts'],
  exports: ['runModProcess', 'setOriginalCwd'],
})
r.setOriginalCwd(project)
after(() => {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true, maxRetries: 10 })
})

const helper = join(project, 'argument helper.cjs')
writeFileSync(
  helper,
  `let stdin='';process.stdin.on('data',b=>stdin+=b);process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(2),stdin,cwd:process.cwd(),environment:process.env.MOD_PROCESS_VALUE}));console.error('stderr preserved');process.exitCode=Number(process.env.MOD_PROCESS_EXIT||0)})`,
)

const windowsShimWorkerSkip = process.platform === 'win32' && process.env.NODE_TEST_CONTEXT
  ? 'cmd.exe fixture stalls under the Windows test worker; run node test/plugin-mod-process-platform.test.mjs directly'
  : false

test('portable mod processes preserve argv, stdin, environment, cwd, final newlines and nonzero status', async () => {
  const args = [
    'plain',
    'with spaces',
    'Unicode-é-漢字',
    '"quoted"',
    'a&b',
    '%MOD_PROCESS_VALUE%',
    '$HOME',
    'semi;colon',
    '',
  ]
  const result = await r.runModProcess([process.execPath, helper, ...args], {
    stdin: 'input\nsecond line\n',
    env: { MOD_PROCESS_VALUE: 'actual environment', MOD_PROCESS_EXIT: '7' },
  })
  assert.equal(result.exitCode, 7)
  assert.deepEqual(JSON.parse(result.stdout), {
    args,
    stdin: 'input\nsecond line\n',
    cwd: project,
    environment: 'actual environment',
  })
  assert.ok(result.stdout.endsWith('\n'))
  assert.equal(result.stderr, 'stderr preserved\n')
})

test(
  'Windows command shims resolve generically without executing argument metacharacters',
  {
    skip:
      process.platform !== 'win32'
        ? 'Windows only'
        : process.env.NODE_TEST_CONTEXT
          ? 'cmd.exe fixture stalls under the Windows test worker; run node test/plugin-mod-process-platform.test.mjs directly'
          : false,
  },
  async () => {
    const bin = join(project, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    const shim = join(bin, 'fixture-runner.cmd')
    writeFileSync(
      shim,
      `@echo off\r\n"${process.execPath}" "${helper}" %*\r\nexit /b %errorlevel%\r\n`,
    )
    const marker = join(project, 'must-not-exist.txt')
    const args = [
      'with spaces',
      'Unicode-é-漢字',
      'a&b',
      '& echo bad > must-not-exist.txt',
      '',
    ]
    for (const command of ['fixture-runner', shim]) {
      const result = await r.runModProcess([command, ...args], {
        timeoutMs: 5000,
        stdin: 'shim input',
        env: { PATH: bin + ';' + process.env.PATH, MOD_PROCESS_VALUE: 'shim' },
      })
      assert.equal(result.exitCode, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout).args, args)
      assert.equal(JSON.parse(result.stdout).stdin, 'shim input')
      assert.equal(existsSync(marker), false)
    }
  },
)

test('mod processes reject cancellation, timeout and oversized output, and report missing commands as failures', async () => {
  const controller = new AbortController()
  const pending = r.runModProcess(
    [process.execPath, '-e', 'setInterval(()=>{},1000)'],
    {},
    controller.signal,
  )
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending)
  await assert.rejects(
    r.runModProcess([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
      timeoutMs: 50,
    }),
  )
  try {
    assert.notEqual(
      (await r.runModProcess(['tau-missing-executable-' + process.pid]))
        .exitCode,
      0,
    )
  } catch (error) {
    assert.ok(error)
  }
  await assert.rejects(
    r.runModProcess([
      process.execPath,
      '-e',
      "process.stdout.write('x'.repeat(2*1024*1024))",
    ]),
  )
})

for (const mode of ['timeout', 'cancel', 'overflow']) {
  test(`mod process ${mode} terminates wrapper descendants before their delayed side effects`,
    {skip:windowsShimWorkerSkip}, async () => {
      const fixture = join(project, 'tree-' + mode)
      mkdirSync(fixture)
      const ready = join(fixture,'descendant-ready.txt')
      const marker = join(fixture,'must-not-run.txt')
      const descendant = join(fixture,'descendant.cjs')
      const launcher = join(fixture,'launcher.cjs')
      writeFileSync(descendant, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'survived'),1800);setTimeout(()=>process.exit(),2500);`)
      writeFileSync(launcher, `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'inherit',windowsHide:true});${mode==='overflow'?`const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.stdout.write('x'.repeat(2*1024*1024))}},10);`:''}setTimeout(()=>process.exit(),3200);`)
      let argv = [process.execPath,launcher]
      if (process.platform === 'win32') {
        const bin = join(fixture,'node_modules','.bin')
        mkdirSync(bin,{recursive:true})
        const shim = join(bin,'tree-fixture.cmd')
        writeFileSync(shim,`@echo off\r\n"${process.execPath}" "${launcher}" %*\r\nexit /b %errorlevel%\r\n`)
        argv = [shim]
      }
      const controller = new AbortController()
      const started = Date.now()
      const pending = r.runModProcess(argv,{timeoutMs:mode==='timeout'?1000:5000},controller.signal)
      const rejected = assert.rejects(pending,error=>mode==='timeout'?error.timedOut===true:mode==='cancel'?error.isCanceled===true:error.isMaxBuffer===true)
      if (mode === 'cancel') {
        while (!existsSync(ready) && Date.now()-started<2000)
          await new Promise(done=>setTimeout(done,10))
        controller.abort()
      }
      await rejected
      assert.equal(existsSync(ready),true,'The descendant must have actually started before termination')
      assert.ok(Date.now()-started<2000,'Termination must not wait for the descendant to finish on its own')
      await new Promise(done=>setTimeout(done,Math.max(0,2700-(Date.now()-started))))
      assert.equal(existsSync(marker),false,'No descendant may keep running after a stopped invocation')
    })
}
