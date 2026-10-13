// Only for the disposable stack described in openreply/docs/headless-publishing.md.
// Fake Instagram tokens are stored locally; future test jobs are cancelled.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
const base = 'http://localhost:4017';
const secret = 'test-handoff-secret-not-production';
let checks = 0;
async function request(path, status, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, status, `${path}: expected ${status}, received ${response.status}`);
  checks++;
  return response;
}
const sign = (domain, body) => createHmac('sha256', secret).update(`${domain}${JSON.stringify(body)}`).digest('base64url');
async function provision(workspaceId) {
  const body = { workspaceId, nonce: randomBytes(24).toString('base64url'), timestamp: Date.now() };
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SwayCue-Signature': sign('swaycue:workspace:v1:', body) }, body: JSON.stringify(body) };
  const result = await (await request('/api/swaycue/workspaces', 201, options)).json();
  await request('/api/swaycue/workspaces', 409, options);
  return result.apiKey;
}
await request('/', 404);
await request('/api/auth/login', 404, { method: 'POST' });
await request('/api/public/v1/social/instagram', 404);
await request('/api/public/v1/integrations', 401);
await request('/api/swaycue/workspaces', 401, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const keyA = await provision('headless-test-a');
const keyB = await provision('headless-test-b');
assert.notEqual(keyA, keyB);
const auth = (key) => ({ Authorization: key, 'Content-Type': 'application/json' });
const handoff = {
  handoffId: `${Date.now().toString(36)}_${randomBytes(18).toString('base64url')}`,
  swaycueWorkspaceId: 'headless-test-b', swaycueAccountId: 'fixture-account',
  instagramId: '17841400000000100', username: 'fixture', name: null, picture: null,
  accessToken: 'fake-token-never-published', expiresIn: 5_000_000,
};
await request('/api/public/v1/integrations/provision-instagram', 403, {
  method: 'POST', headers: { ...auth(keyA), 'X-SwayCue-Handoff-Signature': sign('', handoff) }, body: JSON.stringify(handoff),
});
handoff.swaycueWorkspaceId = 'headless-test-a';
const integration = await (await request('/api/public/v1/integrations/provision-instagram', 201, {
  method: 'POST', headers: { ...auth(keyA), 'X-SwayCue-Handoff-Signature': sign('', handoff) }, body: JSON.stringify(handoff),
})).json();
const a = await (await request('/api/public/v1/integrations', 200, { headers: auth(keyA) })).json();
const b = await (await request('/api/public/v1/integrations', 200, { headers: auth(keyB) })).json();
assert.equal(a.length, 1);
assert.equal(b.length, 0);
const file = new FormData();
file.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1QAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'fixture.png');
const media = await (await request('/api/public/v1/upload', 201, { method: 'POST', headers: { Authorization: keyA }, body: file })).json();
assert.ok(media.id);
await request(new URL(media.path).pathname, 200);
const draft = {
  type: 'draft', date: new Date(Date.now() + 3600_000).toISOString(), shortLink: false, tags: [],
  posts: [{ integration: { id: integration.integrationId }, settings: { __type: 'instagram-standalone', post_type: 'post' }, value: [{ content: 'Isolated headless smoke fixture', image: [{ id: media.id, path: media.path }] }] }],
};
await request('/api/public/v1/posts', 201, { method: 'POST', headers: auth(keyA), body: JSON.stringify(draft) });
await request('/api/public/v1/posts', 400, { method: 'POST', headers: auth(keyB), body: JSON.stringify(draft) });
// Exercise the real workflow start/termination boundary without reaching the
// provider: the publication timer is an hour in the future.
draft.type = 'schedule';
const scheduled = await (await request('/api/public/v1/posts', 201, { method: 'POST', headers: auth(keyA), body: JSON.stringify(draft) })).json();
assert.ok(scheduled[0]?.postId);
const connection = await Connection.connect({ address: 'localhost:17233' });
try {
  const temporal = new Client({ connection });
  const workflow = temporal.workflow.getHandle(`post_${scheduled[0].postId}`);
  let running = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { running = (await workflow.describe()).status.name === 'RUNNING'; } catch { /* asynchronous workflow start */ }
    if (running) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(running, 'A real Temporal scheduling workflow must exist');
  checks++;
  await request(`/api/public/v1/posts/${scheduled[0].postId}`, 200, { method: 'DELETE', headers: auth(keyA) });
  assert.equal((await workflow.describe()).status.name, 'TERMINATED');
  checks++;
} finally { await connection.close(); }
console.log(`Passed ${checks} headless checks: no dashboard/login, signed provisioning, replay protection, workspace isolation, upload/retrieval, drafts, real scheduling and cancellation. No external post was published.`);
