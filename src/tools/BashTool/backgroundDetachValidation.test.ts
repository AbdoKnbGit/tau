/**
 * Detached background (`&`) detection unit tests.
 *
 * Run: bun run src/tools/BashTool/backgroundDetachValidation.test.ts
 */

import {
  allowsAutomaticBackgrounding,
  buildDetachedBackgroundValidationMessage,
  detectDetachedBackgroundPattern,
  repairDetachedBackgroundCommand,
} from './backgroundDetachValidation.js'

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

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function main(): void {
  console.log('background detach detection:')

  test('flags a server started with a trailing &', () => {
    assert(
      detectDetachedBackgroundPattern('node server.js &') !== null,
      'expected detached process to be flagged',
    )
  })

  test('flags detach followed by more commands', () => {
    assert(
      detectDetachedBackgroundPattern(
        'node server.js & sleep 2 && curl -s http://localhost:8080/api',
      ) !== null,
      'expected start-then-poll pattern to be flagged',
    )
  })

  test('flags common server PID-capture pattern', () => {
    assert(
      detectDetachedBackgroundPattern(
        'npm run dev -- --host 127.0.0.1 > "$TMPDIR/todo-frontend.log" 2>&1 & echo $!',
      ) !== null,
      'expected log-and-pid detached process to be flagged',
    )
  })

  test('run_in_background does not allow raw shell backgrounding', () => {
    const message = buildDetachedBackgroundValidationMessage(
      'npm run dev > "$TMPDIR/app.log" 2>&1 & echo $!',
      true,
    )
    assert(message !== null, 'expected run_in_background + raw & to be blocked')
    assert(
      message.includes('already starts the whole command'),
      'expected guidance to remove redundant shell backgrounding',
    )
  })

  test('plain detached commands get retry guidance to set run_in_background', () => {
    const message = buildDetachedBackgroundValidationMessage('npm run dev &', false)
    assert(message !== null, 'expected detached command to be blocked')
    assert(
      message.includes('setting run_in_background: true'),
      'expected guidance to set run_in_background',
    )
  })

  test('repairs trailing PID-capture detach to a foreground command body', () => {
    const repaired = repairDetachedBackgroundCommand(
      'npm run dev -- --host 127.0.0.1 > "$TMPDIR/todo-frontend.log" 2>&1 & echo $!',
    )
    assert(
      repaired === 'npm run dev -- --host 127.0.0.1 > "$TMPDIR/todo-frontend.log" 2>&1',
      `unexpected repair: ${repaired}`,
    )
  })

  test('repairs Windows port cleanup plus backend server detach', () => {
    const command =
      'cd todo-app/backend && (for p in $(powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"); do taskkill //PID "$p" //F; done) && npm run start > "$TMPDIR/todo-backend.log" 2>&1 & echo $!'
    const repaired = repairDetachedBackgroundCommand(command)
    assert(repaired !== null, 'expected command to be repaired')
    assert(!repaired.includes('& echo $!'), 'pid capture suffix should be removed')
    assert(
      repaired.endsWith('npm run start > "$TMPDIR/todo-backend.log" 2>&1'),
      `server command should remain foreground inside tracked task: ${repaired}`,
    )
  })

  test('repairs relative cd backend dev-server detach', () => {
    const repaired = repairDetachedBackgroundCommand(
      'cd todo-app/backend && npm run dev > ../../todo-backend.log 2>&1 & echo $!',
    )
    assert(
      repaired === 'cd todo-app/backend && npm run dev > ../../todo-backend.log 2>&1',
      `unexpected repair: ${repaired}`,
    )
  })

  test('repairs detached server followed by static status echo', () => {
    const repaired = repairDetachedBackgroundCommand(
      'cd jurk && node server.js > /tmp/jurk-server.log 2>&1 & echo "Server starting on port from server.js"',
    )
    assert(
      repaired === 'cd jurk && node server.js > /tmp/jurk-server.log 2>&1',
      `unexpected repair: ${repaired}`,
    )
  })

  test('repairs no-space trailing detach', () => {
    assert(
      repairDetachedBackgroundCommand('npm start&') === 'npm start',
      'expected no-space trailing detach to be repaired',
    )
  })

  test('repairs common cross-platform detach idioms', () => {
    const cases: Array<[string, string]> = [
      [
        'python -m http.server 8000 > /tmp/http.log 2>&1 &',
        'python -m http.server 8000 > /tmp/http.log 2>&1',
      ],
      [
        'nohup npm run dev > "$TMPDIR/app.log" 2>&1 &',
        'npm run dev > "$TMPDIR/app.log" 2>&1',
      ],
      [
        'PORT=3000 nohup npm run dev > "$TMPDIR/app.log" 2>&1 & disown',
        'PORT=3000 npm run dev > "$TMPDIR/app.log" 2>&1',
      ],
      [
        'bun run dev& echo $! > "$TMPDIR/app.pid"',
        'bun run dev',
      ],
      [
        'pnpm dev & printf "%s\\n" "$!"',
        'pnpm dev',
      ],
      [
        'cd api && nohup uvicorn app:app --host 0.0.0.0 > /tmp/api.log 2>&1 & echo $!',
        'cd api && uvicorn app:app --host 0.0.0.0 > /tmp/api.log 2>&1',
      ],
    ]

    for (const [command, expected] of cases) {
      assert(
        repairDetachedBackgroundCommand(command) === expected,
        `unexpected repair for ${command}`,
      )
    }
  })

  test('repairs non-npm long-running raw background tasks', () => {
    const cases: Array<[string, string]> = [
      [
        'uvicorn app:app --host 0.0.0.0 > /tmp/uvicorn.log 2>&1 & echo $! && echo "API started"',
        'uvicorn app:app --host 0.0.0.0 > /tmp/uvicorn.log 2>&1',
      ],
      [
        'python manage.py runserver 0.0.0.0:8000 & echo "Django started"',
        'python manage.py runserver 0.0.0.0:8000',
      ],
      [
        'flask --app app run --host 0.0.0.0 &',
        'flask --app app run --host 0.0.0.0',
      ],
      [
        'rails server -b 0.0.0.0 > /tmp/rails.log 2>&1 &',
        'rails server -b 0.0.0.0 > /tmp/rails.log 2>&1',
      ],
      [
        'go run ./cmd/api > /tmp/api.log 2>&1 & echo $!',
        'go run ./cmd/api > /tmp/api.log 2>&1',
      ],
      [
        'cargo run --bin api & echo $!',
        'cargo run --bin api',
      ],
      [
        'java -jar target/app.jar > app.log 2>&1 & echo $!',
        'java -jar target/app.jar > app.log 2>&1',
      ],
      [
        'mvn spring-boot:run & echo $!',
        'mvn spring-boot:run',
      ],
      [
        'kubectl port-forward svc/api 8080:80 > /tmp/pf.log 2>&1 & echo $!',
        'kubectl port-forward svc/api 8080:80 > /tmp/pf.log 2>&1',
      ],
      [
        'ssh -N -L 8080:localhost:80 example.com > /tmp/tunnel.log 2>&1 & echo $!',
        'ssh -N -L 8080:localhost:80 example.com > /tmp/tunnel.log 2>&1',
      ],
    ]

    for (const [command, expected] of cases) {
      assert(
        repairDetachedBackgroundCommand(command) === expected,
        `unexpected repair for ${command}`,
      )
    }
  })

  test('repairs common Docker CLI detach flags to foreground tracked commands', () => {
    const cases: Array<[string, string]> = [
      [
        'docker compose up -d',
        'docker compose up',
      ],
      [
        'docker compose -f docker-compose.dev.yml up --detach api',
        'docker compose -f docker-compose.dev.yml up api',
      ],
      [
        'cd infra && docker-compose up --detach=true api',
        'cd infra && docker-compose up api',
      ],
      [
        'docker compose up -d > /tmp/compose.log 2>&1',
        'docker compose up > /tmp/compose.log 2>&1',
      ],
      [
        'docker run --rm -d -p 8080:80 nginx',
        'docker run --rm -p 8080:80 nginx',
      ],
      [
        'docker run --name web --detach nginx',
        'docker run --name web nginx',
      ],
    ]

    for (const [command, expected] of cases) {
      assert(
        repairDetachedBackgroundCommand(command) === expected,
        `unexpected repair for ${command}`,
      )
    }
  })

  test('does not repair start-then-poll or multi-background shapes', () => {
    assert(
      repairDetachedBackgroundCommand(
        'node server.js & sleep 2 && curl -s http://localhost:8080/api',
      ) === null,
      'start-then-poll needs a second tool call, not repair',
    )
    assert(
      repairDetachedBackgroundCommand('lint & typecheck & echo $!') === null,
      'multiple background jobs must not be rewritten',
    )
    assert(
      repairDetachedBackgroundCommand('node server.js & echo started > status.txt') === null,
      'status commands with redirects have side effects and must not be dropped',
    )
    assert(
      repairDetachedBackgroundCommand('node server.js & echo $(touch status.txt)') === null,
      'status commands with command substitution have side effects and must not be dropped',
    )
    assert(
      repairDetachedBackgroundCommand('docker compose up -d && docker compose logs -f') === null,
      'docker detach followed by a second real command must not be rewritten',
    )
    assert(
      repairDetachedBackgroundCommand('docker run -d nginx && curl -s http://localhost:8080') === null,
      'docker detach followed by probing must not be rewritten',
    )
    assert(
      repairDetachedBackgroundCommand('docker compose up --detach=false') === null,
      'explicit non-detach flags must not be rewritten',
    )
    assert(
      repairDetachedBackgroundCommand('docker build -d .') === null,
      'unrelated docker subcommands must not be rewritten',
    )
  })

  test('blocks unsafe Docker CLI detach compounds instead of silently detaching', () => {
    const composeMessage = buildDetachedBackgroundValidationMessage(
      'docker compose up -d && docker compose logs -f',
      false,
    )
    assert(composeMessage !== null, 'expected docker compose detach to be blocked')
    assert(
      composeMessage.includes('Remove Docker detach flags'),
      `unexpected docker compose message: ${composeMessage}`,
    )

    const runMessage = buildDetachedBackgroundValidationMessage(
      'docker run -d nginx && curl -s http://localhost:8080',
      true,
    )
    assert(runMessage !== null, 'expected docker run detach to be blocked')
    assert(
      runMessage.includes('run_in_background: true'),
      `unexpected docker run message: ${runMessage}`,
    )

    assert(
      buildDetachedBackgroundValidationMessage('docker compose up --detach=false', false) === null,
      'non-detach Docker flags must not be blocked',
    )
  })

  test('flags nohup detach', () => {
    assert(
      detectDetachedBackgroundPattern('nohup python app.py &') !== null,
      'expected nohup detach to be flagged',
    )
  })

  test('flags detach without a space before &', () => {
    assert(
      detectDetachedBackgroundPattern('npm start&') !== null,
      'expected no-space detach to be flagged',
    )
  })

  test('allows && chains', () => {
    assert(
      detectDetachedBackgroundPattern('npm run build && npm test') === null,
      '&& must not be flagged',
    )
  })

  test('allows stderr redirection forms', () => {
    assert(
      detectDetachedBackgroundPattern('make 2>&1') === null,
      '2>&1 must not be flagged',
    )
    assert(
      detectDetachedBackgroundPattern('make &> build.log') === null,
      '&> must not be flagged',
    )
    assert(
      detectDetachedBackgroundPattern('exec 3<&0') === null,
      '<& must not be flagged',
    )
  })

  test('allows & inside quoted strings', () => {
    assert(
      detectDetachedBackgroundPattern('echo "fish & chips"') === null,
      'double-quoted & must not be flagged',
    )
    assert(
      detectDetachedBackgroundPattern("git commit -m 'a & b'") === null,
      'single-quoted & must not be flagged',
    )
  })

  test('allows job-control parallelism that ends with wait', () => {
    assert(
      detectDetachedBackgroundPattern('lint & typecheck & wait') === null,
      'jobs reaped by wait must not be flagged',
    )
  })

  test('bails out on heredocs', () => {
    assert(
      detectDetachedBackgroundPattern(
        'cat > run.sh <<EOF\nnode server.js &\nEOF',
      ) === null,
      'heredoc bodies must not be inspected',
    )
  })

  test('allows plain foreground commands', () => {
    assert(detectDetachedBackgroundPattern('node server.js') === null, 'plain command')
    assert(detectDetachedBackgroundPattern('ls -la | grep src') === null, 'pipeline')
  })

  test('does not flag a URL whose query string contains & (auto-quoted)', () => {
    assert(
      detectDetachedBackgroundPattern('curl -s http://localhost:8000/x?a=1&b=2') === null,
      'URL query & must not be read as a background operator',
    )
    assert(
      detectDetachedBackgroundPattern(
        'curl http://localhost:8000/optimize/feedrate?spindle_load=50&current_feedrate=100',
      ) === null,
      'the reported curl case must pass',
    )
  })

  test('still flags a real trailing background & alongside a URL', () => {
    assert(
      detectDetachedBackgroundPattern('curl http://x/y & ') !== null,
      'a real background & must still be flagged',
    )
  })

  console.log('\nautomatic background eligibility:')

  test('keeps pipelines and input-coupled commands in the foreground', () => {
    const foreground = [
      `echo 'db.status()' | docker exec -i db mongosh`,
      'producer | consumer',
      "command <<'EOF'\ninput\nEOF",
      'command < input.txt',
      'command <<< "input"',
      'diff <(left) <(right)',
    ]
    for (const command of foreground) {
      assert(
        !allowsAutomaticBackgrounding(command),
        `must stay foreground: ${command}`,
      )
    }
  })

  test('allows ordinary long-running commands to auto-background', () => {
    for (const command of ['npm run build', 'docker compose up', 'pytest']) {
      assert(
        allowsAutomaticBackgrounding(command),
        `ordinary command may auto-background: ${command}`,
      )
    }
  })

  test('keeps sleep foreground even behind environment assignments', () => {
    assert(!allowsAutomaticBackgrounding('sleep 5'), 'plain sleep')
    assert(
      !allowsAutomaticBackgrounding('LC_ALL=C sleep 5'),
      'environment-prefixed sleep',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
