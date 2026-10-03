/**
 * Tests for credential masking of request payloads and response bodies.
 * The caught/untouched lists are Browsentic's, so the port is held to the
 * same bar as the original.
 *
 * Run: bun run src/services/browser/secrets.test.ts
 */

import { findSecrets, kindForKey, maskBody, maskSecrets } from "./secrets.js";

let passed = 0;
let failed = 0;

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

function assert(cond: boolean, hint: string): void {
  if (!cond) throw new Error(hint);
}

console.log("detection: what has to be caught");
const CAUGHT: Array<[text: string, shape: string]> = [
  ["sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345", "anthropic-key"],
  ["ghp_AbCdEf0123456789AbCdEf0123456789abcd", "github-token"],
  ["AKIAIOSFODNN7EXAMPLE", "aws-access-key"],
  ["AIzaSyA1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q", "google-key"],
  ["sk_live_AbCdEf0123456789xyz", "stripe-key"],
  ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdef", "jwt"],
  ["password: hunter2Nowaythis", "labelled-password"],
  ['api_key = "AbCdEf0123456789"', "labelled-token"],
  ["Authorization: Bearer abc123def456ghi", "labelled-token"],
  ["Cookie: session=abc123def456; theme=dark", "cookie-header"],
  ["https://user:s3cretPassw0rd@example.com/x", "basic-auth"],
  ["4242 4242 4242 4242", "card"],
  ["Your temporary password is Tr0ub4dor&3xK9", "prose-password"],
  ["Your new password will be: Hunter2Kestrel", "prose-password"],
  ["The API key is AbCdEf0123456789xyz", "prose-token"],
  ["Xk9mPq2LvRt7Yn4WzB8sJd3HgF6cA1eU", "high-entropy"],
  [
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----",
    "private-key",
  ],
];
for (const [text, shape] of CAUGHT) {
  test(`detects ${shape} in ${JSON.stringify(text.slice(0, 32))}`, () => {
    const shapes = findSecrets(text).map((span) => span.shape);
    assert(shapes.includes(shape), `found ${JSON.stringify(shapes)}`);
  });
}

console.log("detection: what must not be caught");
const UNTOUCHED = [
  "Sign in to your account to continue reading the article",
  "see https://cdn.site.com/assets/index-a1b2c3d4e5f6a7b8.js for details",
  "commit 5f2a9c8e1b3d7f0a4c6e8b2d5a7f9c1e3b6d8a0f",
  "id 550e8400-e29b-41d4-a716-446655440000",
  "ThisIsALongCamelCaseIdentifier12",
  "GetUserProfileByAccountIdV2Handler",
  "ContinueReadingTheFullArticleHere",
  "password: ********",
  "password: your-password-here",
  "password: null",
  "A password is required to continue",
  "Your password is incorrect. Please try again.",
  "The password is case-sensitive",
  "This session is expired",
  "order 1234567890123456789012345678",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg",
  `password: ${String.fromCharCode(0x2022).repeat(8)}`,
];
for (const text of UNTOUCHED) {
  test(`leaves alone: ${text.slice(0, 44)}`, () => {
    const masked = maskSecrets(text);
    assert(masked.text === text && masked.masked === 0, `became ${JSON.stringify(masked.text)}`);
  });
}

console.log("what survives a mask");
test("an api key keeps only its public prefix", () => {
  const { text } = maskSecrets("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345");
  assert(text === "sk-ant-[masked api-key]", text);
});
test("a github token keeps only its public prefix", () => {
  const { text } = maskSecrets("ghp_AbCdEf0123456789AbCdEf0123456789abcd");
  assert(text === "ghp_[masked token]", text);
});
test("a password reveals nothing at all", () => {
  const { text } = maskSecrets("password: hunter2Nowaythis");
  assert(text === "password: [masked password]", text);
});
test("a card keeps its last four", () => {
  const { text } = maskSecrets("4242 4242 4242 4242");
  assert(text === "[masked card]...4242", text);
});
test("a jwt payload never survives", () => {
  const { text } = maskSecrets(
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdef",
  );
  assert(!text.includes("eyJzdWIi"), text);
});

console.log("bodies and payloads");
test("a JSON body keeps its shape and loses its credentials", () => {
  const body =
    '{"user":"bob","password":"hunter2","access_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdef","plan":"pro"}';
  const { text, masked } = maskSecrets(body);
  assert(!text.includes("hunter2"), text);
  assert(!text.includes("eyJzdWIi"), text);
  assert(text.includes('"user":"bob"') && text.includes('"plan":"pro"'), text);
  assert(masked === 2, `masked ${masked}`);
});
test("a form payload masks the password and keeps the rest", () => {
  const { text } = maskSecrets("username=bob&password=hunter2Now&remember=1");
  assert(text === "username=bob&password=[masked password]&remember=1", text);
});
test("an apiKey field in JSON is caught by its label", () => {
  const { text } = maskSecrets('{"apiKey":"AbCdEf0123456789"}');
  assert(!text.includes("AbCdEf0123456789"), text);
});
test("ordinary API data passes through untouched", () => {
  const body =
    '{"id":42,"name":"Eau de rose","price":"12.90","sku":"ER-100","updated":"2026-10-03T12:00:00Z","tags":["floral","spring"]}';
  assert(maskSecrets(body).text === body, "a plain product record was altered");
  assert(maskBody(body) === body, "maskBody altered a plain product record");
});

console.log("whole bodies");
test("JSON echoed inside a JSON string is read unescaped", () => {
  const echo = JSON.stringify({
    data: JSON.stringify({ username: "test", password: "Hunter2Kestrel" }),
    json: { username: "test", password: "Hunter2Kestrel" },
  });
  const out = maskBody(echo);
  assert(!out.includes("Hunter2Kestrel"), out);
  const parsed = JSON.parse(out) as { data: string; json: { username: string } };
  assert(JSON.parse(parsed.data).username === "test", "the echoed string is no longer valid JSON");
  assert(parsed.json.username === "test", "a plain field was altered");
});
test("a value under a credential key is masked whole, even with no label inside", () => {
  const out = maskBody('{"apiKey":"abc123xyz","pwd":"letmein","name":"Bob"}');
  assert(out === '{"apiKey":"[masked token]","pwd":"[masked password]","name":"Bob"}', out);
});
test("a keyed vendor key keeps its public prefix", () => {
  const out = maskBody('{"apiKey":"sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345"}');
  assert(out === '{"apiKey":"sk-ant-[masked api-key]"}', out);
});
test("a form post is decoded, so free text is masked too", () => {
  const out = maskBody("custname=Test+User&comments=Ring+twice.+password%3A+Hunter2Kestrel");
  assert(out === "custname=Test User&comments=Ring twice. password: [masked password]", out);
});
test("a form post's password field is masked by its name", () => {
  const out = maskBody("username=bob&password=p%40ss");
  assert(out === "username=bob&password=[masked password]", out);
});
test("plain text and broken JSON fall back to text scanning", () => {
  assert(maskBody("Hello world, nothing secret here.") === "Hello world, nothing secret here.", "text altered");
  const broken = '{"password": "Hunter2Kestrel", "cut';
  assert(!maskBody(broken).includes("Hunter2Kestrel"), maskBody(broken));
});

console.log("credential keys");
for (const key of ["password", "newPassword", "user_password", "PASSWD", "apiKey", "api_key", "accessToken", "access_token", "clientSecret", "refreshToken", "sessionId", "csrfToken", "cookie", "pwd", "otp", "passwords"]) {
  test(`"${key}" names a credential`, () => {
    assert(kindForKey(key) !== null, "not recognised");
  });
}
for (const key of ["username", "email", "title", "href", "summary", "passenger", "sessionCount", "tokenizer", "id"]) {
  test(`"${key}" does not`, () => {
    assert(kindForKey(key) === null, `read as ${kindForKey(key)}`);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
