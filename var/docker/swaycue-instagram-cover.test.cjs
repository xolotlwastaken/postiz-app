require('reflect-metadata');
require('@swc-node/register');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InstagramProvider } = require('../../libraries/nestjs-libraries/src/integrations/social/instagram.provider.ts');
const { InstagramStandaloneProvider } = require('../../libraries/nestjs-libraries/src/integrations/social/instagram.standalone.provider.ts');

const coverUrl = 'https://cdn.example.com/reel cover.jpg?version=2&name=cover+final';

async function createContainers(t, Provider, media, settings = { post_type: 'post' }) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(url);
    assert.ok(request.pathname.endsWith('/instagram_account_1/media'));
    assert.equal(options.method, 'POST');
    requests.push(request);
    return Response.json({ id: `container_${requests.length}` });
  });

  const result = await new Provider().postPending(
    'instagram_account_1',
    'fixture-token',
    [{ id: 'scheduled_post_1', message: 'A Reel with a selected cover', settings, media }],
    { profile: 'fixture_creator' }
  );
  assert.equal(result[0].status, 'pending');
  return requests;
}

for (const [Provider, host] of [
  [InstagramProvider, 'graph.facebook.com'],
  [InstagramStandaloneProvider, 'graph.instagram.com'],
]) {
  test(`${host}: sends the selected Reel cover to Meta`, async (t) => {
    const requests = await createContainers(t, Provider, [{
      type: 'video',
      path: 'https://cdn.example.com/reel.mp4',
      thumbnail: coverUrl,
      thumbnailTimestamp: 1250,
    }]);

    assert.equal(requests.length, 1);
    const [url] = requests;
    assert.equal(url.host, host);
    assert.equal(url.searchParams.get('media_type'), 'REELS');
    assert.equal(url.searchParams.get('cover_url'), coverUrl);
    assert.equal(url.searchParams.has('thumb_offset'), false);
  });

  for (const timestamp of [undefined, 1250]) {
    test(`${host}: uses frame ${timestamp ?? 0} when no cover is selected`, async (t) => {
      const [url] = await createContainers(t, Provider, [{
        type: 'video',
        path: 'https://cdn.example.com/reel.mp4',
        thumbnailTimestamp: timestamp,
      }]);
      assert.equal(url.searchParams.has('cover_url'), false);
      assert.equal(url.searchParams.get('thumb_offset'), timestamp === undefined ? '0' : '1250');
    });
  }

  test(`${host}: keeps Reel cover parameters out of Stories`, async (t) => {
    const [url] = await createContainers(t, Provider, [{
      type: 'video',
      path: 'https://cdn.example.com/story.mp4',
      thumbnail: coverUrl,
    }], { post_type: 'story' });
    assert.equal(url.searchParams.get('media_type'), 'STORIES');
    assert.equal(url.searchParams.has('cover_url'), false);
    assert.equal(url.searchParams.has('thumb_offset'), false);
  });

  test(`${host}: keeps Reel covers out of carousel video items`, async (t) => {
    const [url] = await createContainers(t, Provider, [
      { type: 'video', path: 'https://cdn.example.com/reel.mp4', thumbnail: coverUrl, thumbnailTimestamp: 1250 },
      { type: 'image', path: 'https://cdn.example.com/photo.jpg' },
    ]);
    assert.equal(url.searchParams.get('media_type'), 'VIDEO');
    assert.equal(url.searchParams.get('is_carousel_item'), 'true');
    assert.equal(url.searchParams.get('thumb_offset'), '1250');
    assert.equal(url.searchParams.has('cover_url'), false);
  });
}
