const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = readFileSync(require('node:path').join(__dirname, '../../libraries/nestjs-libraries/src/upload/supabase.storage.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');

function harness(key = 'sb_secret_fixture', status = 200) {
  const calls = [];
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, Buffer, URL, Uint8Array, AbortSignal,
    require(name) {
      if (name.includes('webhook.url.validator')) return { isSafePublicHttpsUrl: async () => false };
      if (name.includes('ssrf.safe.dispatcher')) return { ssrfSafeDispatcher: {} };
      if (name === './data.url') return { parseDataUrl: (url) => ({ buffer: Buffer.from(url.split(',')[1], 'base64') }) };
      return require(name);
    },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: status === 200, status }; },
  });
  return { Storage: exports.SupabaseStorage, storage: new exports.SupabaseStorage('https://fixture.supabase.co', key, 'publishing-dev'), calls };
}

test('uploads sniffed media with secret authorization and persistent unique public URLs', async () => {
  const { storage, calls } = harness();
  const first = await storage.uploadFile({ buffer: png, mimetype: 'text/html', originalname: '../fake.html' });
  const second = await storage.uploadFile({ buffer: png });
  assert.equal(first.mimetype, 'image/png');
  assert.match(first.path, /^https:\/\/fixture.supabase.co\/storage\/v1\/object\/public\/publishing-dev\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]+\.png$/);
  assert.notEqual(first.path, second.path);
  assert.equal(calls[0].options.headers.apikey, 'sb_secret_fixture');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.headers['Content-Type'], 'image/png');
  assert.equal(calls[0].options.headers['x-upsert'], 'false');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(png.equals(Buffer.from(calls[0].options.body)));
});

test('legacy service role keys use Bearer; rejected storage responses stay sanitized', async () => {
  const { storage, calls } = harness('legacy-server-key', 403);
  await assert.rejects(storage.uploadFile({ buffer: png }), /request failed \(403\)/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer legacy-server-key');
});

test('rejects unsupported bytes and unsafe sources before storing anything', async () => {
  const { storage, calls, Storage } = harness();
  await assert.rejects(storage.uploadFile({ buffer: Buffer.from('<html>unsafe</html>') }), /Unsupported file type/);
  await assert.rejects(storage.uploadSimple('http://localhost/a.png'), /Unsafe URL/);
  for (const url of ['http://localhost:54321', 'https://fixture.supabase.co/other', 'https://fixture.supabase.co.evil.test', 'https://user:pass@fixture.supabase.co']) {
    assert.throws(() => new Storage(url, 'key', 'bucket'));
  }
  assert.equal(calls.length, 0);
});

test('generated image data uses hosted storage and deletion stays inside the owned bucket', async () => {
  const { storage, calls } = harness();
  const path = await storage.uploadSimple(`data:image/png;base64,${png.toString('base64')}`);
  await storage.removeFile(path);
  const deletion = calls.at(-1);
  assert.equal(deletion.options.method, 'DELETE');
  assert.equal(JSON.parse(deletion.options.body).prefixes[0], path.split('/publishing-dev/')[1]);
  await assert.rejects(storage.removeFile('https://other.supabase.co/storage/v1/object/public/publishing-dev/file.png'));
  await assert.rejects(storage.removeFile('https://fixture.supabase.co/storage/v1/object/public/publishing-dev/../private/file.png'));
  assert.equal(calls.length, 2);
});
