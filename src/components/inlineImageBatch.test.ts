/**
 * Checks for inline image renders landing together.
 *
 * The failure this guards against is not a wrong image but a stuck one: a
 * finished render held back for a render that will never finish would keep an
 * image off screen. So beside the batching itself, every way a render can end
 * is checked to release the others.
 *
 * Run via: bun run src/components/inlineImageBatch.test.ts
 */

import {
  applyWithBatch,
  beginImageRender,
  createImageRenderToken,
  endImageRender,
  MAX_BATCH_WAIT_MS,
  resetImageBatchForTesting,
} from './inlineImageBatch.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  resetImageBatchForTesting()
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assertEqual(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(`${hint}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

/** Starts renders for `count` images at time 0. */
function images(count: number): number[] {
  return Array.from({ length: count }, () => {
    const token = createImageRenderToken()
    beginImageRender(token, 0)
    return token
  })
}

await test('renders finishing one after another land together', () => {
  const [a, b, c] = images(3)
  const landed: string[] = []
  applyWithBatch(a!, () => landed.push('a'), 10)
  applyWithBatch(c!, () => landed.push('c'), 20)
  assertEqual(landed.join(), '', 'held while b is still rendering')
  applyWithBatch(b!, () => landed.push('b'), 30)
  assertEqual(landed.join(), 'a,c,b', 'all three in one pass once b finishes')
})

await test('a render alone lands at once', () => {
  const [a] = images(1)
  const landed: string[] = []
  applyWithBatch(a!, () => landed.push('a'), 0)
  assertEqual(landed.join(), 'a', 'nothing to wait for')
})

await test('a render that ends without finishing releases the ones waiting on it', () => {
  const [a, b] = images(2)
  const landed: string[] = []
  applyWithBatch(a!, () => landed.push('a'), 10)
  endImageRender(b!, 20)
  assertEqual(landed.join(), 'a', 'b unmounted, failed, or was superseded')
})

await test('a straggler holds the others for at most the cap', () => {
  const [a, b, c] = images(3)
  const landed: string[] = []
  applyWithBatch(a!, () => landed.push('a'), 0)
  applyWithBatch(c!, () => landed.push('c'), MAX_BATCH_WAIT_MS - 1)
  assertEqual(landed.join(), '', 'still inside the cap')
  endImageRender(createImageRenderToken(), MAX_BATCH_WAIT_MS)
  assertEqual(landed.join(), 'a,c', 'the cap passed: what finished lands')
  applyWithBatch(b!, () => landed.push('b'), MAX_BATCH_WAIT_MS + 5)
  assertEqual(landed.join(), 'a,c,b', 'and the straggler lands alone when it finishes')
})

await test('the cap is kept by a timer when nothing else happens', async () => {
  const a = createImageRenderToken()
  const b = createImageRenderToken()
  beginImageRender(a)
  beginImageRender(b)
  const landed: string[] = []
  applyWithBatch(a, () => landed.push('a'))
  await new Promise(resolve => setTimeout(resolve, MAX_BATCH_WAIT_MS + 150))
  assertEqual(landed.join(), 'a', 'released without any other call')
})

await test('a new render supersedes a finished one that has not landed yet', () => {
  const [a, b] = images(2)
  const landed: string[] = []
  applyWithBatch(a!, () => landed.push('old a'), 10)
  beginImageRender(a!, 20)
  applyWithBatch(b!, () => landed.push('b'), 30)
  assertEqual(landed.join(), '', 'b waits for the new render of a')
  applyWithBatch(a!, () => landed.push('new a'), 40)
  assertEqual(landed.join(), 'b,new a', 'only the new render of a lands')
})

await test('a render with nothing in flight applies at once', () => {
  const landed: string[] = []
  applyWithBatch(createImageRenderToken(), () => landed.push('x'), 0)
  assertEqual(landed.join(), 'x', 'never held')
})

await test('one apply failing does not strand the rest', () => {
  const [a, b] = images(2)
  const landed: string[] = []
  applyWithBatch(
    a!,
    () => {
      throw new Error('boom')
    },
    10,
  )
  applyWithBatch(b!, () => landed.push('b'), 20)
  assertEqual(landed.join(), 'b', 'b still lands')
  const [c] = images(1)
  applyWithBatch(c!, () => landed.push('c'), 30)
  assertEqual(landed.join(), 'b,c', 'and nothing is left waiting behind the failure')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
