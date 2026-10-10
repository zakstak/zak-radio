import { test, expect } from '@playwright/test';

async function host(page, automaticReady = true) {
  await page.addInitScript(({ automaticReady }) => {
    window.__hostMessages = [];
    window.__playedTracks = [];
    window.__ready = (requestId, ready = true) => window.ZakstakNativeBridge.onmessage({ data: JSON.stringify({
      schema: 'zakstak.native.v1', type: 'media.ready', requestId, ready,
    }) });
    window.ZakstakNativeBridge = { postMessage(value) {
      const message = JSON.parse(value);
      window.__hostMessages.push(message);
      if (message.type === 'hello') queueMicrotask(() => this.onmessage({ data: JSON.stringify({
        schema: 'zakstak.native.v1', type: 'capabilities', mediaBuffering: true, foregroundMediaPreparation: true,
      }) }));
      if (message.type === 'media.prepare' && automaticReady) queueMicrotask(() => window.__ready(message.requestId));
    }};
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelector('#audio').addEventListener('playing', event => {
        window.__playedTracks.push(new URL(event.target.currentSrc).pathname);
      });
    });
  }, { automaticReady });
  await page.goto('/');
  await expect(page.locator('#playPause')).toBeEnabled();
}

test('native foreground readiness precedes playback and stale readiness cannot undo Stop', async ({ page }) => {
  await host(page, false);
  await page.locator('#playPause').click();
  await expect.poll(() => page.evaluate(() => window.__hostMessages.some(m => m.type === 'media.prepare'))).toBe(true);
  expect(await page.locator('#audio').evaluate(audio => audio.paused)).toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('zakstak-native-media-command', { detail: { command: 'stop' } }));
    for (const request of window.__hostMessages.filter(m => m.type === 'media.prepare')) window.__ready(request.requestId);
  });
  await expect.poll(() => page.evaluate(() => window.ZakAudio.owner)).toBe('');
  expect(await page.evaluate(() => window.__playedTracks)).toEqual([]);
});

test('natural track changes remain buffering or playing until an explicit Pause', async ({ page }) => {
  await host(page);
  await page.locator('#playPause').click();
  await expect.poll(() => page.evaluate(() => window.__playedTracks.length)).toBeGreaterThanOrEqual(4);
  const messages = await page.evaluate(() => window.__hostMessages.filter(m => m.type === 'media'));
  const active = messages.slice(messages.findIndex(m => m.state === 'playing'));
  expect(active.some(m => m.state === 'buffering')).toBe(true);
  expect(active.every(m => ['playing', 'buffering'].includes(m.state))).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('zakstak-native-media-command', { detail: { command: 'pause' } })));
  await expect.poll(() => page.evaluate(() => window.__hostMessages.at(-1).state)).toBe('paused');
  const count = await page.evaluate(() => window.__playedTracks.length);
  await expect(async () => {
    await page.waitForTimeout(5100);
    expect(await page.evaluate(() => window.__playedTracks.length)).toBe(count);
    expect(await page.locator('#audio').evaluate(audio => audio.paused)).toBe(true);
  }).toPass({ timeout: 6000 });
});

test('native Stop remains silent across subsequent station revisions', async ({ page }) => {
  await host(page);
  await page.locator('#playPause').click();
  await expect.poll(() => page.evaluate(() => window.__playedTracks.length)).toBeGreaterThanOrEqual(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('zakstak-native-media-command', { detail: { command: 'stop' } })));
  const revision = (await (await page.request.get('/api/station?station_id=main')).json()).revision;
  await expect.poll(async () => (await (await page.request.get('/api/station?station_id=main')).json()).revision, { timeout: 8000 }).toBeGreaterThan(revision + 2);
  expect(await page.evaluate(() => window.ZakAudio.owner)).toBe('');
  expect(await page.locator('#audio').evaluate(audio => audio.paused)).toBe(true);
  expect(await page.evaluate(() => window.__hostMessages.at(-1).state)).toBe('none');
});


test('rejected foreground preparation stays silent through subsequent station updates', async ({ page }) => {
  await host(page, false);
  await page.locator('#playPause').click();
  await expect.poll(() => page.evaluate(() => window.__hostMessages.some(m => m.type === 'media.prepare'))).toBe(true);
  await page.evaluate(() => {
    for (const request of window.__hostMessages.filter(m => m.type === 'media.prepare')) window.__ready(request.requestId, false);
  });
  await expect.poll(() => page.evaluate(() => window.__hostMessages.at(-1).state)).toBe('paused');
  await page.waitForTimeout(4000);
  expect(await page.evaluate(() => window.__playedTracks)).toEqual([]);
  expect(await page.locator('#audio').evaluate(audio => audio.paused)).toBe(true);
});

for (const owner of ['library', 'reader', 'radio']) {
  test(`Pause cancels pending native preparation for ${owner}`, async ({ page }) => {
    await host(page, false);
    await page.evaluate(owner => {
      window.ZakAudio.claim(owner, '/media/alpha/audio', 'Pending track', { stationId: 'main' });
      void window.ZakAudio.play();
    }, owner);
    await expect.poll(() => page.evaluate(() => window.__hostMessages.some(m => m.type === 'media.prepare'))).toBe(true);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('zakstak-native-media-command', { detail: { command: 'pause' } }));
      for (const request of window.__hostMessages.filter(m => m.type === 'media.prepare')) window.__ready(request.requestId);
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__playedTracks)).toEqual([]);
    expect(await page.locator('#audio').evaluate(audio => audio.paused)).toBe(true);
    expect(await page.evaluate(() => window.__hostMessages.at(-1).state)).toBe('paused');
  });
}

test('same-source explicit Pause cancels pending Reader play', async ({ page }) => {
  await host(page, false);
  await page.evaluate(() => {
    window.ZakAudio.claim('reader', '/media/alpha/audio', 'Pending reader');
    void window.ZakAudio.play();
    window.ZakAudio.claim('reader', '/media/alpha/audio', 'Pending reader');
    window.ZakAudio.pause();
    for (const request of window.__hostMessages.filter(m => m.type === 'media.prepare')) window.__ready(request.requestId);
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__playedTracks)).toEqual([]);
  expect(await page.evaluate(() => window.__hostMessages.at(-1).state)).toBe('paused');
});
