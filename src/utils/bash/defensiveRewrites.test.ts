/**
 * Defensive bash command rewrites regression tests.
 *
 * Run: bun run src/utils/bash/defensiveRewrites.test.ts
 */

import {
  applyBashDefensiveRewrites,
  normalizeSmartQuotesOutsideQuotes,
  normalizeUnicodeSpacesOutsideQuotes,
  rewriteAmbiguousInlineCodeQuoting,
  rewritePowerShellNullRedirect,
  rewritePipedDockerExecStdin,
  rewritePortablePathOptionSpacing,
  rewriteWindowsCmdAutoRun,
  rewriteUnsafeGlobalNodeTaskkill,
  rewriteUnquotedUrlAmpersand,
  rewriteWindowsNativeToolSlashFlags,
  rewriteWindowsRemotePosixPaths,
  rewriteWindowsReservedRedirects,
  stripCommandGarbage,
} from './defensiveRewrites.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assertEqual(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(`${hint}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function main(): void {
  console.log('stripCommandGarbage:')

  test('removes CR from heredoc body so terminator matches', () => {
    const input = "cat <<EOF\r\nfoo\r\nEOF\r\n"
    const out = stripCommandGarbage(input)
    assertEqual(out, 'cat <<EOF\nfoo\nEOF\n', 'CR must be removed, LF kept')
  })

  test('preserves TAB and LF', () => {
    const input = 'echo\thello\nworld'
    assertEqual(stripCommandGarbage(input), 'echo\thello\nworld', 'TAB/LF must survive')
  })

  test('strips BOM at start of command', () => {
    const input = '﻿ls -la'
    assertEqual(stripCommandGarbage(input), 'ls -la', 'BOM must be removed')
  })

  test('strips zero-width space inserted by chat client', () => {
    const input = 'git​status'
    assertEqual(stripCommandGarbage(input), 'gitstatus', 'ZWSP must be removed')
  })

  test('strips NUL byte', () => {
    const input = 'echo\x00hi'
    assertEqual(stripCommandGarbage(input), 'echohi', 'NUL must be removed')
  })

  test('strips DEL', () => {
    const input = 'echo\x7fhi'
    assertEqual(stripCommandGarbage(input), 'echohi', 'DEL must be removed')
  })

  test('strips bidi marks and line separators', () => {
    const input = 'echo‪A B‮C'
    assertEqual(stripCommandGarbage(input), 'echoABC', 'bidi/sep must be removed')
  })

  test('does not touch literal backslash-r escape sequence', () => {
    // \r in source code is a two-char escape, not a CR byte
    const input = 'printf "foo\\rbar"'
    assertEqual(
      stripCommandGarbage(input),
      'printf "foo\\rbar"',
      'literal \\r escape must be preserved',
    )
  })

  test('plain ASCII command is unchanged', () => {
    const input = 'ls -la /tmp'
    assertEqual(stripCommandGarbage(input), 'ls -la /tmp', 'no false positives')
  })

  console.log('\nrewritePowerShellNullRedirect:')

  test("rewrites 2>$null to 2>/dev/null", () => {
    assertEqual(
      rewritePowerShellNullRedirect('cmd 2>$null'),
      'cmd 2>/dev/null',
      '2>$null must become 2>/dev/null',
    )
  })

  test('rewrites &>$null', () => {
    assertEqual(
      rewritePowerShellNullRedirect('cmd &>$null'),
      'cmd &>/dev/null',
      '&>$null must become &>/dev/null',
    )
  })

  test('rewrites >>$null', () => {
    assertEqual(
      rewritePowerShellNullRedirect('cmd >>$null'),
      'cmd >>/dev/null',
      '>>$null must become >>/dev/null',
    )
  })

  test("case-insensitive: 2>$NULL", () => {
    assertEqual(
      rewritePowerShellNullRedirect('cmd 2>$NULL'),
      'cmd 2>/dev/null',
      'uppercase $NULL must be matched',
    )
  })

  test('does NOT rewrite $null outside redirect position', () => {
    assertEqual(
      rewritePowerShellNullRedirect('echo $null'),
      'echo $null',
      '$null not in redirect must be left alone',
    )
  })

  test('does NOT rewrite $nullable (boundary check)', () => {
    assertEqual(
      rewritePowerShellNullRedirect('cmd 2>$nullable'),
      'cmd 2>$nullable',
      'must not match $nullable',
    )
  })

  console.log('\nrewriteWindowsReservedRedirects:')

  test('rewrites >con to >/dev/null', () => {
    assertEqual(
      rewriteWindowsReservedRedirects('cmd >con'),
      'cmd >/dev/null',
      '>con must be redirected',
    )
  })

  test('rewrites 2>prn case-insensitively', () => {
    assertEqual(
      rewriteWindowsReservedRedirects('cmd 2>PRN'),
      'cmd 2>/dev/null',
      'uppercase PRN must be matched',
    )
  })

  test('rewrites >>aux', () => {
    assertEqual(
      rewriteWindowsReservedRedirects('cmd >>aux'),
      'cmd >>/dev/null',
      '>>aux must be redirected',
    )
  })

  test('does NOT rewrite >con.txt', () => {
    assertEqual(
      rewriteWindowsReservedRedirects('cmd >con.txt'),
      'cmd >con.txt',
      'con.txt is not the reserved name',
    )
  })

  test('does NOT rewrite cat con (no redirect)', () => {
    assertEqual(
      rewriteWindowsReservedRedirects('cat con'),
      'cat con',
      'con not in redirect must be left alone',
    )
  })

  console.log('\nrewriteWindowsCmdAutoRun:')

  test('adds /d before cmd /c to disable AutoRun', () => {
    assertEqual(
      rewriteWindowsCmdAutoRun('cmd /c python test_model.py'),
      'cmd /d /c python test_model.py',
      'cmd /c must become cmd /d /c',
    )
  })

  test('adds /d before cmd.exe /s /c', () => {
    assertEqual(
      rewriteWindowsCmdAutoRun('cmd.exe /s /c echo hi'),
      'cmd.exe /d /s /c echo hi',
      'cmd.exe /s /c must gain /d',
    )
  })

  test('does NOT duplicate existing /d', () => {
    assertEqual(
      rewriteWindowsCmdAutoRun('cmd /d /c echo hi'),
      'cmd /d /c echo hi',
      'existing /d must be preserved',
    )
  })

  test('rewrites cmd after a command separator', () => {
    assertEqual(
      rewriteWindowsCmdAutoRun('echo before && cmd /c echo after'),
      'echo before && cmd /d /c echo after',
      'cmd segment after && must be rewritten',
    )
  })

  console.log('\nrewriteUnsafeGlobalNodeTaskkill:')

  test('blocks taskkill by node.exe image name and preserves later commands', () => {
    const input =
      'taskkill //IM node.exe //F 2>/dev/null; sleep 1; echo "killed"'
    const out = rewriteUnsafeGlobalNodeTaskkill(input)
    assert(
      out.includes('Blocked unsafe taskkill /IM node.exe'),
      'must emit an explicit block message',
    )
    assert(
      !out.includes('taskkill //IM node.exe //F'),
      'must remove the unsafe taskkill invocation',
    )
    assert(out.includes('sleep 1; echo "killed"'), 'later commands remain')
  })

  test('blocks case-insensitive taskkill.exe with quoted node image', () => {
    const input = 'taskkill.exe /F /IM "node.exe"'
    const out = rewriteUnsafeGlobalNodeTaskkill(input)
    assert(out.includes('Blocked unsafe taskkill /IM node.exe'), 'must block')
  })

  test('blocks imagename switch form', () => {
    const input = 'taskkill /imagename=node.exe /f'
    const out = rewriteUnsafeGlobalNodeTaskkill(input)
    assert(out.includes('Blocked unsafe taskkill /IM node.exe'), 'must block')
  })

  test('does NOT block PID-scoped taskkill', () => {
    const input = 'taskkill /PID 1234 /F'
    assertEqual(
      rewriteUnsafeGlobalNodeTaskkill(input),
      input,
      'PID-scoped cleanup must remain available',
    )
  })

  test('does NOT block other image names', () => {
    const input = 'taskkill //IM chrome.exe //F'
    assertEqual(
      rewriteUnsafeGlobalNodeTaskkill(input),
      input,
      'non-node image kills are outside this guard',
    )
  })

  test('does NOT rewrite an echoed taskkill string', () => {
    const input = 'echo "taskkill //IM node.exe //F"'
    assertEqual(
      rewriteUnsafeGlobalNodeTaskkill(input),
      input,
      'taskkill text inside another command must remain text',
    )
  })

  console.log('\nrewriteWindowsNativeToolSlashFlags:')

  test('doubles slash flags for taskkill PID kills', () => {
    assertEqual(
      rewriteWindowsNativeToolSlashFlags('taskkill /PID 17864 /F'),
      'taskkill //PID 17864 //F',
      'slash flags must double so Git Bash passes them through',
    )
  })

  test('doubles slash flags but not quoted filter values', () => {
    assertEqual(
      rewriteWindowsNativeToolSlashFlags('tasklist /FI "PID eq 17864" /NH'),
      'tasklist //FI "PID eq 17864" //NH',
      'flags double, quoted value untouched',
    )
  })

  test('handles colon-attached flag values', () => {
    assertEqual(
      rewriteWindowsNativeToolSlashFlags('findstr /C:TODO src.txt'),
      'findstr //C:TODO src.txt',
      'colon-value flags must double too',
    )
  })

  test('does not touch slash-paths or redirects in the same segment', () => {
    assertEqual(
      rewriteWindowsNativeToolSlashFlags('tasklist /NH > /dev/null'),
      'tasklist //NH > /dev/null',
      'paths with a second slash must stay untouched',
    )
    assertEqual(
      rewriteWindowsNativeToolSlashFlags('robocopy /c/src C:/dest /MIR'),
      'robocopy /c/src C:/dest //MIR',
      'POSIX and Windows path arguments must stay untouched',
    )
  })

  test('does not touch non-listed tools', () => {
    const node = 'node /c/app/server.js'
    assertEqual(rewriteWindowsNativeToolSlashFlags(node), node, 'node untouched')
    const grep = 'grep -r /etc/hosts .'
    assertEqual(rewriteWindowsNativeToolSlashFlags(grep), grep, 'grep untouched')
  })

  test('does not touch slash flags inside quoted strings', () => {
    assertEqual(
      rewriteWindowsNativeToolSlashFlags('findstr /C:"a /b c" file.txt'),
      'findstr //C:"a /b c" file.txt',
      'the /b inside quotes is data, not a flag',
    )
  })

  test('rewrites each tool segment in a compound command', () => {
    assertEqual(
      rewriteWindowsNativeToolSlashFlags('taskkill /PID 123 /F && rm -f app.db'),
      'taskkill //PID 123 //F && rm -f app.db',
      'only the native-tool segment is rewritten',
    )
  })

  test('bails out on heredocs', () => {
    const input = 'cat > kill.bat <<EOF\ntaskkill /PID 1 /F\nEOF'
    assertEqual(rewriteWindowsNativeToolSlashFlags(input), input, 'heredoc untouched')
  })

  test('is idempotent', () => {
    const once = rewriteWindowsNativeToolSlashFlags('ipconfig /all')
    assertEqual(once, 'ipconfig //all', 'first pass doubles')
    assertEqual(rewriteWindowsNativeToolSlashFlags(once), once, 'second pass no-op')
  })

  test('pipeline applies it on Windows and skips it elsewhere', () => {
    assertEqual(
      applyBashDefensiveRewrites('taskkill /PID 17864 /F', 'windows'),
      'taskkill //PID 17864 //F',
      'Windows hosts get the rewrite',
    )
    assertEqual(
      applyBashDefensiveRewrites('tree /F', 'linux'),
      'tree /F',
      'on Linux /F is a real path argument and must stay untouched',
    )
    assertEqual(
      applyBashDefensiveRewrites('tree /F', 'macos'),
      'tree /F',
      'macOS same as Linux',
    )
  })

  test('still blocks node image kills after slash doubling', () => {
    const out = applyBashDefensiveRewrites('taskkill /IM node.exe /F', 'windows')
    assert(
      out.includes('Blocked unsafe taskkill /IM node.exe'),
      'doubled flags must still hit the node image guard',
    )
  })

  console.log('\nrewriteAmbiguousInlineCodeQuoting:')

  test('keeps separate, correctly quoted arguments separate on every platform', () => {
    for (const command of [
      'mkdir -p "workflow/child" "workflow/result folder"',
      'mkdir -p "/c/work/child" "/c/work/result folder"',
      'mkdir -p "C:/work/child" "C:/work/result folder"',
      'mkdir -p "/tmp/work/child" "/tmp/work/result folder"',
      'cp -r "source folder" "destination folder"',
      'grep -e "needle" "input file"',
      'runtime --eval "print(1)" "input file"',
      'runtime --eval="print(1)" "input file"',
    ]) {
      assertEqual(rewriteAmbiguousInlineCodeQuoting(command), command, command)
      for (const platform of ['windows', 'linux', 'macos'] as const) {
        assertEqual(applyBashDefensiveRewrites(command, platform), command, `${platform}: ${command}`)
      }
    }
  })

  test('preserves nested code quotes for generic --eval payloads', () => {
    assertEqual(
      rewriteAmbiguousInlineCodeQuoting(
        'runtime --eval "fn({_id:"value", host:"node:27017"})"',
      ),
      `runtime --eval 'fn({_id:"value", host:"node:27017"})'`,
      'nested code quotes must reach the evaluator intact',
    )
  })

  test('handles equals-form evaluator flags and short evaluator flags', () => {
    assertEqual(
      rewriteAmbiguousInlineCodeQuoting(
        'runtime --eval="fn({name:"value"})"',
      ),
      `runtime --eval='fn({name:"value"})'`,
      'equals-form long flag must preserve code',
    )
    assertEqual(
      rewriteAmbiguousInlineCodeQuoting(
        'node -e "console.log({name:"value"})"',
      ),
      `node -e 'console.log({name:"value"})'`,
      'registered short evaluator flags must be repaired too',
    )
    assertEqual(
      rewriteAmbiguousInlineCodeQuoting(
        'docker exec app node -e "console.log({name:"value"})"',
      ),
      `docker exec app node -e 'console.log({name:"value"})'`,
      'short evaluator flags must work behind process boundaries',
    )
  })

  test('repairs multi-word payloads without blocking', () => {
    assertEqual(
      rewriteAmbiguousInlineCodeQuoting(
        'node -e "console.log("hello world")"',
      ),
      `node -e 'console.log("hello world")'`,
      'the complete quoted span must be rejoined as one argument',
    )
    assertEqual(
      rewriteAmbiguousInlineCodeQuoting(
        'transport exec target runtime --eval "fn({_id:"config Repl", members:[]})"',
      ),
      `transport exec target runtime --eval 'fn({_id:"config Repl", members:[]})'`,
      'the repair is independent of the wrapper/runtime names',
    )
  })

  test('leaves already-safe inline code and unrelated -e flags unchanged', () => {
    const safe = [
      `runtime --eval 'fn({_id:"value"})'`,
      'python -c "print(\\"value\\")"',
      `node -e 'console.log("value")'`,
      'grep -e "a" file.txt',
      'sed -e "s/a/b/" file.txt',
    ]
    for (const command of safe) {
      assertEqual(
        rewriteAmbiguousInlineCodeQuoting(command),
        command,
        `must preserve: ${command}`,
      )
    }
  })

  test('inline-code quoting rewrite is idempotent', () => {
    const once = rewriteAmbiguousInlineCodeQuoting(
      'runtime --eval "fn({name:"value"})"',
    )
    assertEqual(
      rewriteAmbiguousInlineCodeQuoting(once),
      once,
      'second pass must not alter the corrected payload',
    )
  })

  console.log('\nrewritePortablePathOptionSpacing:')

  test('normalizes static path-valued long options to space form', () => {
    const cases: Array<[string, string]> = [
      [
        'runtime --file=/tmp/init.js',
        'runtime --file /tmp/init.js',
      ],
      [
        'tool --config=./config/app.yml --output=/var/tmp/result.json',
        'tool --config ./config/app.yml --output /var/tmp/result.json',
      ],
      [
        'tool --workdir=C:/Projects/app',
        'tool --workdir C:/Projects/app',
      ],
      [
        'tool --arbitrary-path-name=/some/path',
        'tool --arbitrary-path-name /some/path',
      ],
    ]
    for (const [input, expected] of cases) {
      assertEqual(rewritePortablePathOptionSpacing(input), expected, input)
    }
  })

  test('leaves non-path, dynamic, and unrelated equals options unchanged', () => {
    const unchanged = [
      'tool --color=always --format=json',
      'tool --file="$FILE"',
      'tool --count=3',
      'tool --endpoint=https://example.test/a/b',
      'echo --file=/tmp/x',
    ]
    for (const command of unchanged) {
      const expected =
        command === 'echo --file=/tmp/x' ? 'echo --file /tmp/x' : command
      assertEqual(
        rewritePortablePathOptionSpacing(command),
        expected,
        `portable option handling: ${command}`,
      )
    }
  })

  test('path-option spacing composes with Windows remote path protection', () => {
    assertEqual(
      applyBashDefensiveRewrites(
        'docker exec app runtime --file=/tmp/init.js',
        'windows',
      ),
      "MSYS2_ARG_CONV_EXCL='/tmp/init.js' docker exec app runtime --file /tmp/init.js",
      'the separated remote path must also bypass MSYS conversion',
    )
  })

  console.log('\nrewriteWindowsRemotePosixPaths:')

  test('protects direct Docker exec HDFS paths without wrapping the command', () => {
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'docker exec namenode hadoop fs -cat /bigdata/hello.txt',
      ),
      "MSYS2_ARG_CONV_EXCL='/bigdata/hello.txt' docker exec namenode hadoop fs -cat /bigdata/hello.txt",
      'the remote HDFS path must not be converted to a C: path',
    )
  })

  test('protects Docker Compose, Podman, and Nerdctl exec paths', () => {
    const cases: Array<[string, string]> = [
      [
        'docker compose exec namenode hadoop fs -ls /bigdata/',
        "MSYS2_ARG_CONV_EXCL='/bigdata/' docker compose exec namenode hadoop fs -ls /bigdata/",
      ],
      [
        'podman exec app cat /etc/config',
        "MSYS2_ARG_CONV_EXCL='/etc/config' podman exec app cat /etc/config",
      ],
      [
        'nerdctl exec app ls /workspace',
        "MSYS2_ARG_CONV_EXCL='/workspace' nerdctl exec app ls /workspace",
      ],
    ]
    for (const [input, expected] of cases) {
      assertEqual(rewriteWindowsRemotePosixPaths(input), expected, input)
    }
  })

  test('protects unknown transports by boundary argv shape', () => {
    const cases: Array<[string, string]> = [
      [
        'transport exec target command /foreign/data',
        "MSYS2_ARG_CONV_EXCL='/foreign/data' transport exec target command /foreign/data",
      ],
      [
        'transport run image command /foreign/data',
        "MSYS2_ARG_CONV_EXCL='/foreign/data' transport run image command /foreign/data",
      ],
      [
        'transport shell target -- command /foreign/data',
        "MSYS2_ARG_CONV_EXCL='/foreign/data' transport shell target -- command /foreign/data",
      ],
      [
        'newcopy local.txt endpoint:/foreign/data',
        "MSYS2_ARG_CONV_EXCL='endpoint:/foreign/data' newcopy local.txt endpoint:/foreign/data",
      ],
      [
        'filesystem dfs -cat /foreign/data',
        "MSYS2_ARG_CONV_EXCL='/foreign/data' filesystem dfs -cat /foreign/data",
      ],
    ]
    for (const [input, expected] of cases) {
      assertEqual(rewriteWindowsRemotePosixPaths(input), expected, input)
    }
  })

  test('protects remote workdirs and inline remote path options', () => {
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'docker exec -w /workspace app tool --output=/tmp/result.json',
      ),
      "MSYS2_ARG_CONV_EXCL='/workspace;--output=/tmp/result.json' docker exec -w /workspace app tool --output=/tmp/result.json",
      'remote option values on both sides of the container boundary must survive',
    )
  })

  test('protects Docker run command paths but preserves host bind-mount conversion', () => {
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'docker run --rm -v /c/Users/me/data:/data image cat /data/input.txt',
      ),
      "MSYS2_ARG_CONV_EXCL='/data/input.txt' docker run --rm -v /c/Users/me/data:/data image cat /data/input.txt",
      'only the path after the image belongs to the container',
    )
  })

  test('protects Kubernetes exec and copy remote paths', () => {
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'kubectl --kubeconfig /c/Users/me/.kube/config exec pod -- cat /var/log/app.log',
      ),
      "MSYS2_ARG_CONV_EXCL='/var/log/app.log' kubectl --kubeconfig /c/Users/me/.kube/config exec pod -- cat /var/log/app.log",
      'kubeconfig is local; the path after -- is remote',
    )
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'kubectl cp default/pod:/var/log/app.log /c/Users/me/app.log',
      ),
      "MSYS2_ARG_CONV_EXCL='default/pod:/var/log/app.log' kubectl cp default/pod:/var/log/app.log /c/Users/me/app.log",
      'only the pod:path copy endpoint is remote',
    )
  })

  test('protects SSH remote arguments while preserving local identity paths', () => {
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'ssh -i /c/Users/me/.ssh/id_ed25519 host cat /etc/os-release',
      ),
      "MSYS2_ARG_CONV_EXCL='/etc/os-release' ssh -i /c/Users/me/.ssh/id_ed25519 host cat /etc/os-release",
      'the local identity file must retain normal MSYS conversion',
    )
  })

  test('protects SCP and rsync remote specs but not local paths', () => {
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'scp host:/var/log/app.log /c/Users/me/app.log',
      ),
      "MSYS2_ARG_CONV_EXCL='host:/var/log/app.log' scp host:/var/log/app.log /c/Users/me/app.log",
      'scp remote source must be excluded narrowly',
    )
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'rsync -a /c/Users/me/data/ host:/srv/data/',
      ),
      "MSYS2_ARG_CONV_EXCL='host:/srv/data/' rsync -a /c/Users/me/data/ host:/srv/data/",
      'rsync local source must still convert',
    )
  })

  test('protects WSL, ADB, and direct Hadoop/HDFS remote filesystem paths', () => {
    const cases: Array<[string, string]> = [
      [
        'wsl --distribution Ubuntu -- ls /home/me',
        "MSYS2_ARG_CONV_EXCL='/home/me' wsl --distribution Ubuntu -- ls /home/me",
      ],
      [
        'adb shell cat /sdcard/config.json',
        "MSYS2_ARG_CONV_EXCL='/sdcard/config.json' adb shell cat /sdcard/config.json",
      ],
      [
        'hadoop fs -ls /bigdata/',
        "MSYS2_ARG_CONV_EXCL='/bigdata/' hadoop fs -ls /bigdata/",
      ],
      [
        'hdfs dfs -cat /warehouse/item',
        "MSYS2_ARG_CONV_EXCL='/warehouse/item' hdfs dfs -cat /warehouse/item",
      ],
    ]
    for (const [input, expected] of cases) {
      assertEqual(rewriteWindowsRemotePosixPaths(input), expected, input)
    }
  })

  test('preserves WSL management-command host paths', () => {
    const commands = [
      'wsl --import Ubuntu /c/WSL/Ubuntu /c/images/ubuntu.tar',
      'wsl --export Ubuntu /c/backups/ubuntu.tar',
      'wsl --mount /c/disks/linux.vhdx',
    ]
    for (const command of commands) {
      assertEqual(
        rewriteWindowsRemotePosixPaths(command),
        command,
        'WSL management paths belong to the Windows host',
      )
    }
    assertEqual(
      rewriteWindowsRemotePosixPaths('wsl --cd /home/me -- ls /srv/data'),
      "MSYS2_ARG_CONV_EXCL='/home/me;/srv/data' wsl --cd /home/me -- ls /srv/data",
      'both --cd and arguments after -- belong to Linux',
    )
    assertEqual(
      rewriteWindowsRemotePosixPaths('wsl --cd /home/me ls /srv/data'),
      "MSYS2_ARG_CONV_EXCL='/home/me;/srv/data' wsl --cd /home/me ls /srv/data",
      'both the Linux cwd and command path need protection without --',
    )
  })

  test('separates ADB push/pull local and Android paths', () => {
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'adb push /c/Users/me/config.json /sdcard/config.json',
      ),
      "MSYS2_ARG_CONV_EXCL='/sdcard/config.json' adb push /c/Users/me/config.json /sdcard/config.json",
      'adb push source is local and destination is remote',
    )
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'adb pull /sdcard/config.json /c/Users/me/config.json',
      ),
      "MSYS2_ARG_CONV_EXCL='/sdcard/config.json' adb pull /sdcard/config.json /c/Users/me/config.json",
      'adb pull source is remote and destination is local',
    )
  })

  test('separates HDFS upload/download local and remote paths', () => {
    const cases: Array<[string, string]> = [
      [
        'hdfs dfs -put /c/Users/me/input.csv /warehouse/input.csv',
        "MSYS2_ARG_CONV_EXCL='/warehouse/input.csv' hdfs dfs -put /c/Users/me/input.csv /warehouse/input.csv",
      ],
      [
        'hadoop fs -copyFromLocal /c/Users/me/a /c/Users/me/b /warehouse/',
        "MSYS2_ARG_CONV_EXCL='/warehouse/' hadoop fs -copyFromLocal /c/Users/me/a /c/Users/me/b /warehouse/",
      ],
      [
        'hdfs dfs -get /warehouse/result.csv /c/Users/me/result.csv',
        "MSYS2_ARG_CONV_EXCL='/warehouse/result.csv' hdfs dfs -get /warehouse/result.csv /c/Users/me/result.csv",
      ],
      [
        'hdfs dfs -getmerge /warehouse/a /warehouse/b /c/Users/me/all.csv',
        "MSYS2_ARG_CONV_EXCL='/warehouse/a;/warehouse/b' hdfs dfs -getmerge /warehouse/a /warehouse/b /c/Users/me/all.csv",
      ],
    ]
    for (const [input, expected] of cases) {
      assertEqual(rewriteWindowsRemotePosixPaths(input), expected, input)
    }
  })

  test('supports IPv6 SSH copy endpoints', () => {
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'scp user@[2001:db8::1]:/srv/file /c/Users/me/file',
      ),
      "MSYS2_ARG_CONV_EXCL='user@[2001:db8::1]:/srv/file' scp user@[2001:db8::1]:/srv/file /c/Users/me/file",
      'bracketed IPv6 remote specs must be preserved',
    )
  })

  test('supports env/winpty wrappers and pipeline-local insertion', () => {
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'FOO=bar winpty docker exec app cat /etc/config',
      ),
      "MSYS2_ARG_CONV_EXCL='/etc/config' FOO=bar winpty docker exec app cat /etc/config",
      'the exclusion must precede wrapper and environment words',
    )
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        'printf x | docker exec -i app tee /tmp/input',
      ),
      "printf x | MSYS2_ARG_CONV_EXCL='/tmp/input' docker exec -i app tee /tmp/input",
      'only the right-hand native boundary segment needs the exclusion',
    )
  })

  test('handles quoted static paths and each compound command segment', () => {
    assertEqual(
      rewriteWindowsRemotePosixPaths(
        `docker exec a cat '/one path/file' && docker exec b cat /two/file`,
      ),
      `MSYS2_ARG_CONV_EXCL='/one path/file' docker exec a cat '/one path/file' && MSYS2_ARG_CONV_EXCL='/two/file' docker exec b cat /two/file`,
      'quotes are shell syntax, not protection from MSYS argv conversion',
    )
  })

  test('does not alter safe host commands or already protected commands', () => {
    const unchanged = [
      'docker build /c/Users/me/project',
      'kubectl apply -f /c/Users/me/deployment.yaml',
      'ssh -i /c/Users/me/.ssh/id host',
      `docker exec app bash -c 'cat /inside/container'`,
      "MSYS_NO_PATHCONV=1 docker exec app cat /inside",
      "MSYS2_ARG_CONV_EXCL='/inside' docker exec app cat /inside",
      "cat <<'EOF'\ndocker exec app cat /inside\nEOF",
      'echo "$(docker exec app cat /inside)"',
    ]
    for (const command of unchanged) {
      assertEqual(
        rewriteWindowsRemotePosixPaths(command),
        command,
        `must preserve: ${command}`,
      )
    }
  })

  test('the full pipeline applies remote path protection only on Windows', () => {
    const input = 'docker exec namenode hadoop fs -ls /bigdata/'
    assertEqual(
      applyBashDefensiveRewrites(input, 'windows'),
      "MSYS2_ARG_CONV_EXCL='/bigdata/' docker exec namenode hadoop fs -ls /bigdata/",
      'Git Bash needs the conversion exclusion',
    )
    assertEqual(
      applyBashDefensiveRewrites(input, 'linux'),
      input,
      'Linux must receive the original POSIX command',
    )
    assertEqual(
      applyBashDefensiveRewrites(input, 'macos'),
      input,
      'macOS must receive the original POSIX command',
    )
    assertEqual(
      applyBashDefensiveRewrites(input, 'wsl'),
      input,
      'WSL is already Linux and must not receive an MSYS variable',
    )
  })

  test('remote path protection is idempotent', () => {
    const once = rewriteWindowsRemotePosixPaths(
      'docker exec app cat /etc/config',
    )
    assertEqual(
      rewriteWindowsRemotePosixPaths(once),
      once,
      'a second pass must not duplicate the environment assignment',
    )
  })

  test('preserves heredoc bodies while protecting commands after them', () => {
    const input =
      "cat > /tmp/init.js <<'EOF'\nconst path = '/leave/body/alone';\nEOF\ndocker cp /tmp/init.js app:/tmp/init.js\ndocker exec app runtime --file=/tmp/init.js"
    const expected =
      "cat > /tmp/init.js <<'EOF'\nconst path = '/leave/body/alone';\nEOF\nMSYS2_ARG_CONV_EXCL='app:/tmp/init.js' docker cp /tmp/init.js app:/tmp/init.js\nMSYS2_ARG_CONV_EXCL='/tmp/init.js' docker exec app runtime --file /tmp/init.js"
    assertEqual(
      applyBashDefensiveRewrites(input, 'windows'),
      expected,
      'heredoc content is data; later boundary commands still need normalization',
    )
  })

  console.log('\nnormalizeUnicodeSpacesOutsideQuotes:')

  test('rewrites NBSP between tokens to a normal space', () => {
    assertEqual(
      normalizeUnicodeSpacesOutsideQuotes('echo hi'),
      'echo hi',
      'NBSP separator must become a real space',
    )
  })

  test('rewrites assorted Unicode spaces outside quotes', () => {
    // en-space, ideographic space, narrow NBSP
    assertEqual(
      normalizeUnicodeSpacesOutsideQuotes('a b　c d'),
      'a b c d',
      'all Unicode horizontal spaces must normalize outside quotes',
    )
  })

  test('preserves Unicode space INSIDE double quotes', () => {
    assertEqual(
      normalizeUnicodeSpacesOutsideQuotes('echo "a b"'),
      'echo "a b"',
      'intentional NBSP inside a string must be preserved',
    )
  })

  test('preserves Unicode space INSIDE single quotes', () => {
    assertEqual(
      normalizeUnicodeSpacesOutsideQuotes("echo 'a　b'"),
      "echo 'a　b'",
      'intentional Unicode space inside raw string must be preserved',
    )
  })

  test('plain ASCII command is untouched', () => {
    assertEqual(
      normalizeUnicodeSpacesOutsideQuotes('git status -sb'),
      'git status -sb',
      'no false positives on clean commands',
    )
  })

  test('idempotent', () => {
    const once = normalizeUnicodeSpacesOutsideQuotes('echo "keep this"')
    const twice = normalizeUnicodeSpacesOutsideQuotes(once)
    assertEqual(once, 'echo "keep this"', 'outside normalized, inside kept')
    assertEqual(twice, once, 'second pass is a no-op')
  })

  console.log('\nnormalizeSmartQuotesOutsideQuotes:')

  test('rewrites a balanced curly double-quote pair', () => {
    assertEqual(
      normalizeSmartQuotesOutsideQuotes('echo “hello world”'),
      'echo "hello world"',
      'curly double quotes must become ASCII double quotes',
    )
  })

  test('rewrites a balanced curly single-quote pair', () => {
    assertEqual(
      normalizeSmartQuotesOutsideQuotes('echo ‘hello’'),
      "echo 'hello'",
      'curly single quotes must become ASCII single quotes',
    )
  })

  test('SAFETY: leaves a lone stray curly quote (would unbalance) alone', () => {
    // One “ with no closing ” — converting would yield `echo "hi` (syntax err).
    assertEqual(
      normalizeSmartQuotesOutsideQuotes('echo “hi'),
      'echo “hi',
      'odd-count smart quotes must be left as literal (no fabricated syntax error)',
    )
  })

  test('SAFETY: reverts interleaving that would unbalance ASCII quotes', () => {
    // “ ‘ ” ’ → would become "'"' which leaves a dangling single quote.
    const input = '“‘”’'
    assertEqual(
      normalizeSmartQuotesOutsideQuotes(input),
      input,
      'balance-verify must revert an interleave that opens an unterminated quote',
    )
  })

  test('preserves a curly apostrophe INSIDE an ASCII double-quoted string', () => {
    assertEqual(
      normalizeSmartQuotesOutsideQuotes('git commit -m "it’s fixed"'),
      'git commit -m "it’s fixed"',
      'apostrophe inside a real string is content, not a delimiter',
    )
  })

  test('handles double and single pairs together', () => {
    assertEqual(
      normalizeSmartQuotesOutsideQuotes('echo “a” and ‘b’'),
      `echo "a" and 'b'`,
      'independently balanced pairs both convert and stay balanced',
    )
  })

  test('plain ASCII command is untouched', () => {
    assertEqual(
      normalizeSmartQuotesOutsideQuotes(`echo "a" 'b'`),
      `echo "a" 'b'`,
      'no false positives on clean ASCII quoting',
    )
  })

  test('idempotent', () => {
    const once = normalizeSmartQuotesOutsideQuotes('echo “hi”')
    const twice = normalizeSmartQuotesOutsideQuotes(once)
    assertEqual(once, 'echo "hi"', 'converted on first pass')
    assertEqual(twice, once, 'second pass is a no-op')
  })

  console.log('\napplyBashDefensiveRewrites:')

  test('composes all transforms in one pass', () => {
    const input = '﻿cat <<EOF\r\nfoo\r\nEOF\r\n && cmd 2>nul && cmd 2>$null && cmd >con'
    const expected =
      'cat <<EOF\nfoo\nEOF\n && cmd 2>/dev/null && cmd 2>/dev/null && cmd >/dev/null'
    assertEqual(applyBashDefensiveRewrites(input), expected, 'full pipeline')
  })

  test('idempotent: applying twice yields same result', () => {
    const input = 'cat <<EOF\r\nfoo\r\nEOF && cmd 2>$null'
    const once = applyBashDefensiveRewrites(input)
    const twice = applyBashDefensiveRewrites(once)
    assertEqual(once, twice, 'second pass must be a no-op')
  })

  test('adds cmd /d in the full pipeline', () => {
    assertEqual(
      applyBashDefensiveRewrites('cmd /c python test_model.py'),
      'cmd /d /c python test_model.py',
      'pipeline must disable Command Processor AutoRun',
    )
  })

  test('normalizes typography artifacts in the full pipeline', () => {
    // Leading BOM + curly quotes used as delimiters, outside any ASCII quote
    // → should yield clean, runnable bash after the composed rewrites.
    const input = '﻿echo “hi there” | grep hi'
    assertEqual(
      applyBashDefensiveRewrites(input),
      'echo "hi there" | grep hi',
      'BOM stripped and curly quotes ASCII-ified by the pipeline',
    )
  })

  test('typography pass keeps curly apostrophe inside a real string', () => {
    const input = 'git commit -m "fix: it’s done"'
    assertEqual(
      applyBashDefensiveRewrites(input),
      input,
      'in-string apostrophe must survive the full pipeline',
    )
  })

  test('does not break a clean command', () => {
    const input = 'rg --json "pattern" path/ | jq -r ".path.text"'
    assertEqual(applyBashDefensiveRewrites(input), input, 'clean command must pass through')
  })

  test('preserves heredoc body with intentional content', () => {
    const input = "python - <<'PY'\nprint('hi')\nPY"
    assertEqual(applyBashDefensiveRewrites(input), input, 'heredoc body untouched')
  })

  test('preserves jq filter with $ and special chars', () => {
    const input = `jq '.[] | select(.x != .y)' file.json`
    assertEqual(applyBashDefensiveRewrites(input), input, 'jq filter untouched')
  })

  test('preserves intentional bash $null variable read (not redirect)', () => {
    // someone setting and reading a `null` variable on purpose
    const input = 'null=/tmp/foo; echo "$null"'
    assert(
      applyBashDefensiveRewrites(input).includes('echo "$null"'),
      'variable read must not be rewritten',
    )
  })

  test('includes unsafe node.exe taskkill protection in the full pipeline', () => {
    const input = 'taskkill //IM node.exe //F 2>$null'
    const out = applyBashDefensiveRewrites(input)
    assert(
      out.includes('Blocked unsafe taskkill /IM node.exe'),
      'pipeline must block unsafe node image kills',
    )
    assert(!out.includes('2>$null'), 'pipeline still rewrites redirects first')
  })

  test('quotes a URL whose query string carries an unquoted &', () => {
    const out = rewriteUnquotedUrlAmpersand('curl -s http://localhost:8000/x?a=1&b=2')
    assert(out === "curl -s 'http://localhost:8000/x?a=1&b=2'", `got: ${out}`)
  })

  test('quotes the URL but preserves a following && operator', () => {
    const out = rewriteUnquotedUrlAmpersand('curl http://x?a=1&b=2 && echo ok')
    assert(out === "curl 'http://x?a=1&b=2' && echo ok", `got: ${out}`)
  })

  test('leaves `&&` and a real background `&` (no URL query) intact', () => {
    assert(
      rewriteUnquotedUrlAmpersand('echo hi && echo bye') === 'echo hi && echo bye',
      '&& must be untouched',
    )
    assert(
      rewriteUnquotedUrlAmpersand('curl http://x/y & echo done') === 'curl http://x/y & echo done',
      'background & with no URL query must be untouched',
    )
  })

  test('URL ampersand rewrite is idempotent and skips already-quoted URLs', () => {
    const once = rewriteUnquotedUrlAmpersand('curl http://x?a=1&b=2')
    assert(rewriteUnquotedUrlAmpersand(once) === once, 'second pass must be a no-op')
    assert(
      rewriteUnquotedUrlAmpersand("curl 'http://x?a=1&b=2'") === "curl 'http://x?a=1&b=2'",
      'already-quoted URL must be left alone',
    )
  })

  test('the full pipeline quotes a URL ampersand (the reported curl case)', () => {
    const out = applyBashDefensiveRewrites(
      'curl http://localhost:8000/optimize?spindle_load=50&current_feedrate=100',
    )
    assert(
      out === "curl 'http://localhost:8000/optimize?spindle_load=50&current_feedrate=100'",
      `pipeline must quote the URL, got: ${out}`,
    )
  })

  test('URL ampersand rewrite preserves heredoc bodies', () => {
    const input = "cat <<'EOF'\nhttp://x?a=1&b=2\nEOF"
    assertEqual(
      rewriteUnquotedUrlAmpersand(input),
      input,
      'heredoc content must remain byte-for-byte unchanged',
    )
  })

  console.log('\nrewritePipedDockerExecStdin:')

  test('adds -i when a pipeline feeds docker exec', () => {
    assertEqual(
      rewritePipedDockerExecStdin(
        `echo 'rs.status()' | docker exec mongo1 mongosh`,
      ),
      `echo 'rs.status()' | docker exec -i mongo1 mongosh`,
      'piped docker exec must keep stdin open',
    )
  })

  test('preserves existing short and long interactive flags', () => {
    assertEqual(
      rewritePipedDockerExecStdin('printf x | docker exec -it app sh'),
      'printf x | docker exec -it app sh',
      '-it already includes stdin',
    )
    assertEqual(
      rewritePipedDockerExecStdin(
        'printf x | docker exec --interactive app command',
      ),
      'printf x | docker exec --interactive app command',
      '--interactive already includes stdin',
    )
  })

  test('adds -i for piped Podman and Nerdctl exec commands', () => {
    assertEqual(
      rewritePipedDockerExecStdin('printf x | podman exec app cat'),
      'printf x | podman exec -i app cat',
      'Podman exec uses the same stdin contract',
    )
    assertEqual(
      rewritePipedDockerExecStdin('printf x | nerdctl exec app cat'),
      'printf x | nerdctl exec -i app cat',
      'Nerdctl exec uses the same stdin contract',
    )
  })

  test('adds -i to a heredoc pipeline without touching the body', () => {
    const input =
      "cat <<'EOF' | docker exec app runtime\n{\"path\":\"/inside/body\"}\nEOF"
    assertEqual(
      rewritePipedDockerExecStdin(input),
      "cat <<'EOF' | docker exec -i app runtime\n{\"path\":\"/inside/body\"}\nEOF",
      'only the command header may change',
    )
  })

  test('does not rewrite quoted text, heredocs, logical OR, or non-piped docker exec', () => {
    for (const command of [
      `echo "x | docker exec app command"`,
      "cat <<'EOF'\nx | docker exec app command\nEOF",
      'false || docker exec app command',
      'docker exec app command',
    ]) {
      assertEqual(
        rewritePipedDockerExecStdin(command),
        command,
        'non-pipeline occurrence must be untouched',
      )
    }
  })

  test('piped docker exec rewrite is idempotent and part of the full pipeline', () => {
    const input = `echo 'db.items.find()' | docker exec mongo1 mongosh mydb`
    const once = applyBashDefensiveRewrites(input)
    assertEqual(
      once,
      `echo 'db.items.find()' | docker exec -i mongo1 mongosh mydb`,
      'full pipeline must add -i',
    )
    assertEqual(
      applyBashDefensiveRewrites(once),
      once,
      'second pass must not add another -i',
    )
  })

  // Regression: a `<<` that is NOT a heredoc opener (bit-shift, or trailing
  // content after a closed heredoc) used to send the heredoc-splitting rewrites
  // into infinite mutual recursion — the transform saw `includes('<<')`, called
  // transformOutsideHeredocBodies on a chunk that never shrank, and the pair
  // ping-ponged until "Maximum call stack size exceeded". Now gated on a real
  // opener via hasHeredocOpener, so these must return (not throw).
  console.log('\nheredoc opener guard (no infinite recursion):')

  test('bit-shift in arithmetic does not blow the stack', () => {
    assertEqual(
      applyBashDefensiveRewrites('echo $((1 << 2))', 'linux'),
      'echo $((1 << 2))',
      'arithmetic << must pass through untouched',
    )
  })

  test('bare << followed by a non-identifier does not recurse', () => {
    // `<< 2` matches no heredoc-delimiter shape, so it must be left as-is.
    const out = applyBashDefensiveRewrites('echo a << 2', 'linux')
    assert(typeof out === 'string', 'must return a string, not throw')
  })

  test('closed heredoc followed by a bit-shift command does not recurse', () => {
    const input = "cat <<'EOF'\nbody\nEOF\necho $((1 << 2))"
    const out = applyBashDefensiveRewrites(input, 'linux')
    assert(out.includes('body'), 'heredoc body must be preserved')
    assert(out.includes('1 << 2'), 'trailing arithmetic must be preserved')
  })

  test('herestring <<< is handled without throwing', () => {
    const out = applyBashDefensiveRewrites('grep foo <<< "bar"', 'linux')
    assert(typeof out === 'string', 'must return a string, not throw')
  })

  test('real heredoc bodies are still left untouched', () => {
    const input = "python - <<'PY'\nx = 1 << 2\nprint(x)\nPY"
    assertEqual(
      applyBashDefensiveRewrites(input, 'linux'),
      input,
      'quoted heredoc body (incl. its own <<) must be preserved verbatim',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
