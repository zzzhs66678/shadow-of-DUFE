// Isolated browser regressions for CommunityTopicView and use-wall-unsaved.
// Run: node tests/wall-topic-drafts.browser.mjs
// Local default: installed Chrome. CI default: Playwright Chromium.
// Override WALL_TOPIC_BROWSER_CHANNEL=chromium to use bundled Chromium locally.
//
// Real React components + CSS; only next/link and next/image are shims.
// APIs (including owner mismatch 409) are synthetic, not a backend integration
// test. The tiny router uses native Back/Forward and remounts the real component.
// No app build/dev server, database, deployment, real account or disk output.
// Each scenario owns a fresh browser context; failures exit nonzero.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { validateTopicUpdate } from "../services/auth-api/src/community-contract.mjs";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const channel = process.env.WALL_TOPIC_BROWSER_CHANNEL ?? (process.env.CI ? "chromium" : "chrome");
const bundle = await build({
    stdin: {
        contents: `
      import React, { useEffect, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { CommunityTopicView } from "./app/community/CommunityTopicView";
      function Harness() {
        const [path, setPath] = useState(location.pathname);
        useEffect(() => {
          const change = () => setPath(location.pathname);
          window.addEventListener("popstate", change);
          window.reviewNav = (next) => {
            history.pushState({}, "", next);
            change();
          };
          return () => {
            window.removeEventListener("popstate", change);
            delete window.reviewNav;
          };
        }, []);
        return path.startsWith("/community/topics/topic-")
          ? <CommunityTopicView topicId={path.split("/").at(-1)} />
          : <div id="outside">Outside discussion</div>;
      }
      createRoot(document.getElementById("root")).render(<Harness />);
    `,
        resolveDir: repoRoot,
        loader: "tsx",
    },
    absWorkingDir: repoRoot,
    bundle: true,
    write: false,
    outfile: "wall-topic-drafts-test.js",
    loader: { ".css": "local-css" },
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{
            name: "native-test-links-and-images",
            setup(build) {
                build.onResolve({ filter: /^next\/(link|image)$/ }, ({ path }) => ({ path, namespace: "test-shim" }));
                build.onLoad({ filter: /.*/, namespace: "test-shim" }, ({ path }) => ({
                    loader: "jsx",
                    resolveDir: repoRoot,
                    contents: path.endsWith("link")
                        ? 'import React from "react"; export default function Link({ children, ...props }) { return <a {...props}>{children}</a>; }'
                        : 'import React from "react"; export default function Image({ unoptimized, ...props }) { return <img {...props} />; }',
                }));
            },
        }],
});
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
const server = createServer((request, response) => {
    if (request.url === "/a.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(js);
    }
    else if (request.url === "/a.css") {
        response.setHeader("Content-Type", "text/css");
        response.end(css);
    }
    else {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wall topic drafts test</title><link rel="stylesheet" href="/a.css"></head><body><div id="root"></div><script type="module" src="/a.js"></script></body></html>');
    }
});
await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
});
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
const A = { id: 'user-A', username: 'alice', displayName: 'Alice', avatarUrl: null, role: 'user' };
const B = { ...A, id: 'user-B', username: 'bob', displayName: 'Bob' };
const time = '2026-10-09T00:00:00Z';
const baseTopic = { id: 'topic-1', title: '好', body: '好', status: 'published', visibility: 'public', version: 1, author: A, likeCount: 0, commentCount: 3, liked: false, bookmarked: false, createdAt: time, updatedAt: time, editedAt: null };
const root = { id: 'comment-A', topicId: 'topic-1', parentCommentId: null, rootCommentId: null, replyToUserId: null, body: 'Alice root comment', status: 'published', version: 1, author: A, likeCount: 0, liked: false, createdAt: time, updatedAt: time, editedAt: null };
const other = { ...root, id: 'comment-B', body: 'Bob root comment', author: B };
const nested = { ...other, id: 'comment-child', parentCommentId: root.id, rootCommentId: root.id, body: 'Nested comment' };
const key = (owner = 'user-A', topic = 'topic-1') => 'dufe:wall:topic-draft:v1:' + encodeURIComponent(owner) + ':' + encodeURIComponent(topic);
const results = [];
async function fixture(width = 390, init) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    try {
        const p = await context.newPage();
        p.setDefaultTimeout(10000);
        p.setDefaultNavigationTimeout(15000);
        // Never allow a fixture change to reach an external service.
        await p.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const env = { owner: A, topic: structuredClone(baseTopic), comments: [structuredClone(root), structuredClone(other), structuredClone(nested)], writes: [], errors: [] };
        p.on('pageerror', e => env.errors.push(e.message));
        if (init)
            await p.addInitScript(init);
        await p.route('**/api/**', async (route) => {
            const req = route.request(), u = new URL(req.url()), method = req.method();
            const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
            if (u.pathname === '/api/auth/session') {
                if (env.sessionHandler && await env.sessionHandler(route))
                    return;
                return json({ authenticated: !!env.owner, user: env.owner });
            }
            if (method !== 'GET') {
                const w = { path: u.pathname, method, headers: req.headers(), body: req.postDataJSON() };
                env.writes.push(w);
                if (w.headers['x-community-owner'] !== (env.owner?.id ?? ''))
                    return json({ error: 'community_account_changed' }, 409);
                if (env.writeHandler && await env.writeHandler(route, w))
                    return;
                if (method === 'PATCH' && /^\/api\/community\/topics\/[^/]+$/.test(u.pathname)) {
                    if (!validateTopicUpdate(w.body))
                        return json({ error: 'invalid_community_body' }, 400);
                    env.topic = { ...env.topic, ...w.body, version: env.topic.version + 1 };
                }
                return json({ like: { active: method === 'PUT', total: 1 }, bookmark: { active: method === 'PUT' } });
            }
            if (u.pathname.endsWith('/unread-count'))
                return json({ unread: 0 });
            if (/^\/api\/community\/topics\/[^/]+\/comments$/.test(u.pathname))
                return json({ items: env.comments, nextCursor: null });
            if (/^\/api\/community\/topics\/[^/]+$/.test(u.pathname))
                return json({ topic: { ...env.topic, id: u.pathname.split('/').at(-1) } });
            return json({});
        });
        await p.goto(origin + '/community');
        await p.evaluate(() => window.reviewNav('/community/topics/topic-1'));
        await expect(p.locator('#community-reply')).toBeVisible();
        return { p, env, context };
    }
    catch (error) {
        await context.close();
        throw error;
    }
}
async function check(name, fn, width = 390, init) {
    let f;
    try {
        f = await fixture(width, init);
        await fn(f);
        await f.p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(f.env.errors, []);
        results.push({ name, width, ok: true });
    }
    catch (e) {
        results.push({ name, width, ok: false, error: e.stack ?? String(e) });
    }
    finally {
        await f?.context.close();
    }
    console.log(JSON.stringify(results.at(-1)));
}
const composer = p => p.locator('form').filter({ has: p.locator('#community-reply') });
const saved = (p, owner = 'user-A', topic = 'topic-1') => p.evaluate(k => JSON.parse(sessionStorage.getItem(k) || 'null'), key(owner, topic));
const dirty = p => p.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
async function startEdit(p) {
    await p.getByLabel('帖子更多操作', { exact: true }).click();
    await p.getByRole('button', { name: '编辑帖子', exact: true }).click();
}
async function backForward(p) {
    const n = await p.evaluate(() => history.length);
    await p.goBack();
    await expect(p.locator('#outside')).toBeVisible();
    await p.goForward();
    await expect(p.locator('#community-reply')).toBeAttached();
    assert.equal(await p.evaluate(() => history.length), n);
}
// Hold the actual request until the scenario explicitly releases it; no sleeps
// or timing-dependent fake latency are needed for the request-race assertions.
async function holdWrite(env, predicate) {
    let route;
    env.writeHandler = async (requestRoute, write) => {
        if (!predicate(write)) return false;
        route = requestRoute;
        return true;
    };
    return {
        wait: async () => {
            await expect.poll(() => Boolean(route)).toBe(true);
            return route;
        },
    };
}
try {
    browser = await chromium.launch({ channel: channel === "chromium" ? undefined : channel, headless: true });
    for (const width of [390, 1280])
        await check('pending reply locks textarea, all reply targets and survives concurrent like', async ({ p, env }) => {
            await p.getByRole('button', { name: '回复', exact: true }).nth(1).click();
            await p.locator('#community-reply').fill('第一段回复');
            const hold = await holdWrite(env, w => w.method === 'POST');
            await composer(p).getByRole('button', { name: '回复', exact: true }).click();
            const route = await hold.wait();
            await expect(p.locator('#community-reply')).toBeDisabled();
            await expect(p.getByRole('button', { name: '取消指定回复' })).toBeDisabled();
            for (const b of await p.getByRole('button', { name: '回复', exact: true }).all())
                await expect(b).toBeDisabled();
            await p.getByRole('button', { name: '点赞 0', exact: true }).click();
            await expect(p.getByRole('button', { name: '取消点赞 1', exact: true })).toBeEnabled();
            await expect(p.locator('#community-reply')).toBeDisabled();
            assert.equal(env.writes.find(w => w.method === 'POST').headers['x-community-owner'], 'user-A');
            assert.equal(env.writes.find(w => w.method === 'POST').body.replyToCommentId, 'comment-A');
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
            await expect(p.locator('#community-reply')).toHaveValue('');
            await expect(p.locator('#community-reply')).toBeEnabled();
            assert.equal(await saved(p), null);
            assert.equal(await dirty(p), false);
        }, width);
    await check('failed reply keeps draft and target; dirty unload guard', async ({ p, env }) => {
        assert.equal(await dirty(p), false);
        await p.getByRole('button', { name: '回复', exact: true }).nth(1).click();
        await p.locator('#community-reply').fill('失败仍保留');
        env.writeHandler = async (route, write) => {
            if (write.method !== 'POST') return false;
            await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"service_unavailable"}' });
            return true;
        };
        await composer(p).getByRole('button', { name: '回复', exact: true }).click();
        await expect.poll(() => env.writes.length).toBe(1);
        await expect(p.locator('#community-reply')).toBeEnabled();
        await expect(p.locator('#community-reply')).toHaveValue('失败仍保留');
        assert.equal((await saved(p)).replyTo.id, 'comment-A');
        assert.equal(await dirty(p), true);
    });
    await check('browser Back/Forward restores reply + target without history growth; topic isolation', async ({ p }) => {
        await p.getByRole('button', { name: '回复', exact: true }).nth(1).click();
        await p.locator('#community-reply').fill('后退草稿');
        await backForward(p);
        await expect(p.locator('#community-reply')).toHaveValue('后退草稿');
        await expect(composer(p).locator('label')).toHaveText('回复 Alice');
        await p.evaluate(() => window.reviewNav('/community/topics/topic-2'));
        await expect(p.locator('#community-reply')).toHaveValue('');
        await p.locator('#community-reply').fill('帖子二草稿');
        await p.goBack();
        await expect(p.locator('#community-reply')).toHaveValue('后退草稿');
        assert.equal((await saved(p, 'user-A', 'topic-2')).replyBody, '帖子二草稿');
    });
    await check('topic edit Back restores original version and omits unchanged one-character title', async ({ p, env }) => {
        await startEdit(p);
        assert.equal(await dirty(p), false);
        await p.getByLabel(/^正文/).fill('修改的正文');
        env.topic.version = 2;
        env.topic.title = '服务器新版标题';
        env.topic.body = '服务器新版正文';
        await backForward(p);
        await expect(p.getByLabel(/^标题/)).toHaveValue('好');
        await expect(p.getByLabel(/^正文/)).toHaveValue('修改的正文');
        const hold = await holdWrite(env, w => w.method === 'PATCH');
        await p.getByRole('button', { name: '保存更改', exact: true }).click();
        const route = await hold.wait();
        const write = env.writes.find(w => w.method === 'PATCH');
        assert.equal(write.body.version, 1);
        assert.equal('title' in write.body, false);
        assert.ok(validateTopicUpdate(write.body));
        assert.equal(write.headers['x-community-owner'], 'user-A');
        await route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"community_version_conflict","currentVersion":2}' });
        await expect(p.getByLabel(/^正文/)).toBeEnabled();
        assert.equal((await saved(p)).topicEdit.body, '修改的正文');
    });
    await check('Unicode title minimum uses normalized codepoints; short automatic title still editable', async ({ p, env }) => {
        await startEdit(p);
        await p.getByLabel(/^正文/).fill('新的正文');
        const title = p.getByLabel(/^标题/), save = p.getByRole('button', { name: '保存更改', exact: true });
        await expect(save).toBeEnabled();
        await title.fill('😀😀');
        await expect(save).toBeDisabled();
        await title.fill('  你好  ');
        await expect(save).toBeDisabled();
        await title.fill('😀😀😀😀');
        await expect(save).toBeEnabled();
        await save.click();
        await expect(p.getByLabel(/^标题/)).toHaveCount(0);
        assert.equal(env.writes.at(-1).body.title, '😀😀😀😀');
        assert.equal(await saved(p), null);
        assert.equal(await dirty(p), false);
        await startEdit(p);
        await title.fill('ﬃa');
        await expect(save).toBeEnabled();
        await save.click();
        await expect(p.getByLabel(/^标题/)).toHaveCount(0);
        assert.equal(env.writes.at(-1).body.title, 'ffia');
        assert.ok(validateTopicUpdate(env.writes.at(-1).body));
    });
    await check('comment edit Back restores text/version; pending editor cannot close, success clears', async ({ p, env }) => {
        await p.getByLabel('回复更多操作', { exact: true }).first().click();
        await p.getByRole('button', { name: '编辑', exact: true }).click();
        await p.getByLabel(/^回复正文/).fill('修改评论草稿');
        env.comments[0].version = 5;
        env.comments[0].body = '服务器更新评论';
        await backForward(p);
        await expect(p.getByLabel(/^回复正文/)).toHaveValue('修改评论草稿');
        const hold = await holdWrite(env, w => w.method === 'PATCH');
        await p.getByRole('dialog').getByRole('button', { name: '保存更改' }).click();
        const route = await hold.wait();
        await expect(p.getByLabel(/^回复正文/)).toBeDisabled();
        await expect(p.getByRole('dialog').getByRole('button', { name: '取消', exact: true })).toBeDisabled();
        await p.keyboard.press('Escape');
        await expect(p.getByRole('dialog')).toBeVisible();
        assert.equal(env.writes.at(-1).body.version, 1);
        assert.equal(env.writes.at(-1).headers['x-community-owner'], 'user-A');
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        await expect(p.getByRole('dialog')).toHaveCount(0);
        assert.equal(await saved(p), null);
        assert.equal(await dirty(p), false);
    });
    await check('account switch isolates drafts, late old-account reply cannot clear new draft', async ({ p, env }) => {
        await p.locator('#community-reply').fill('A发送中');
        const hold = await holdWrite(env, w => w.method === 'POST');
        await composer(p).getByRole('button', { name: '回复', exact: true }).click();
        const route = await hold.wait();
        env.owner = B;
        await p.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(p.locator('#community-reply')).toHaveValue('');
        await p.locator('#community-reply').fill('B私有草稿');
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        await expect.poll(() => saved(p)).toBe(null);
        await expect(p.locator('#community-reply')).toHaveValue('B私有草稿');
        assert.equal((await saved(p, 'user-B')).replyBody, 'B私有草稿');
        env.owner = A;
        await p.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(p.locator('#community-reply')).toHaveValue('');
    });
    await check('409 stale-account write uses old owner and recovers only old-account draft', async ({ p, env }) => {
        await p.locator('#community-reply').fill('A未发送草稿');
        env.owner = B;
        await composer(p).getByRole('button', { name: '回复', exact: true }).click();
        await expect(p.locator('#community-reply')).toHaveValue('');
        assert.equal(env.writes[0].headers['x-community-owner'], 'user-A');
        assert.equal((await saved(p)).replyBody, 'A未发送草稿');
        assert.equal(await saved(p, 'user-B'), null);
        env.owner = A;
        await p.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(p.locator('#community-reply')).toHaveValue('A未发送草稿');
    });
    await check('late session response cannot restore previous account', async ({ p, env }) => {
        await p.locator('#community-reply').fill('A隔离草稿');
        let late;
        env.sessionHandler = async (route) => {
            if (late) return false;
            late = route;
            return true;
        };
        await p.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(() => Boolean(late)).toBe(true);
        env.owner = B;
        await p.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(p.locator('#community-reply')).toHaveValue('');
        await late.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, user: A }) });
        await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await p.locator('#community-reply').fill('B新稿');
        assert.equal((await saved(p, 'user-B')).replyBody, 'B新稿');
        assert.equal((await saved(p)).replyBody, 'A隔离草稿');
    });
    await check('Back during pending write keeps scope locked until success, then clears restored draft', async ({ p, env }) => {
        await p.locator('#community-reply').fill('即将成功');
        const hold = await holdWrite(env, w => w.method === 'POST');
        await composer(p).getByRole('button', { name: '回复', exact: true }).click();
        const route = await hold.wait();
        await backForward(p);
        await expect(p.locator('#community-reply')).toHaveValue('即将成功');
        await expect(p.locator('#community-reply')).toBeDisabled();
        await p.evaluate(() => document.querySelector('#community-reply').form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        assert.equal(env.writes.filter(w => w.method === 'POST').length, 1);
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        await expect(p.locator('#community-reply')).toHaveValue('');
        await expect(p.locator('#community-reply')).toBeEnabled();
        assert.equal(await saved(p), null);
    });
    await check('real beforeunload dialog protects dirty draft; reload restore and successful clear', async ({ p }) => {
        await p.locator('#community-reply').fill('刷新保留草稿');
        const dialogs = [];
        p.on('dialog', async (dialog) => {
            dialogs.push(dialog.type());
            await dialog.accept();
        });
        await p.reload();
        await expect(p.locator('#community-reply')).toHaveValue('刷新保留草稿');
        assert.deepEqual(dialogs, ['beforeunload']);
        await composer(p).getByRole('button', { name: '回复', exact: true }).click();
        await expect(p.locator('#community-reply')).toHaveValue('');
        await p.reload();
        await expect(p.locator('#community-reply')).toHaveValue('');
        assert.deepEqual(dialogs, ['beforeunload']);
    });
    await check('unavailable sessionStorage remains usable with beforeunload protection', async ({ p }) => {
        await p.locator('#community-reply').fill('存储不可用的草稿');
        assert.equal(await dirty(p), true);
        await backForward(p);
        await expect(p.locator('#community-reply')).toHaveValue('存储不可用的草稿');
        assert.equal(await dirty(p), true);
    }, 390, () => { Storage.prototype.setItem = function () { throw new DOMException('Blocked', 'SecurityError'); }; });
    await check('corrupt stored drafts do not crash or reveal unvalidated objects', async ({ p }) => {
        await expect(p.locator('#community-reply')).toHaveValue('');
        assert.equal(await dirty(p), false);
    }, 390, () => sessionStorage.setItem('dufe:wall:topic-draft:v1:user-A:topic-1', '{"replyBody":{},"replyTo":{"id":"bad","author":{}},"topicEdit":{},"commentEdit":{}}'));
    await check('all topic/comment mutation routes attach owner header', async ({ p, env }) => {
        await p.getByRole('button', { name: '点赞 0', exact: true }).click();
        await expect(p.getByRole('button', { name: '取消点赞 1', exact: true })).toBeEnabled();
        await p.getByRole('button', { name: '取消点赞 1', exact: true }).click();
        await p.getByRole('button', { name: '收藏', exact: true }).click();
        await expect(p.getByRole('button', { name: '已收藏', exact: true })).toBeEnabled();
        await p.getByRole('button', { name: '已收藏', exact: true }).click();
        await p.getByRole('button', { name: '点赞回复 0', exact: true }).first().click();
        await expect(p.getByRole('button', { name: '取消点赞回复 1', exact: true })).toBeEnabled();
        await p.getByRole('button', { name: '取消点赞回复 1', exact: true }).click();
        p.on('dialog', d => d.accept());
        await p.getByLabel('回复更多操作', { exact: true }).first().click();
        await p.getByRole('button', { name: '删除', exact: true }).click();
        await expect.poll(() => env.writes.some(w => w.path === '/api/community/comments/comment-A' && w.method === 'DELETE')).toBe(true);
        await p.getByLabel('帖子更多操作', { exact: true }).click();
        await p.getByRole('button', { name: '删除帖子', exact: true }).click();
        await expect.poll(() => env.writes.some(w => w.path === '/api/community/topics/topic-1' && w.method === 'DELETE')).toBe(true);
        // Deletion performs a full-page navigation. Wait for its new document
        // before check() inspects page errors/paint, not only the outgoing API.
        await expect(p).toHaveURL(origin + '/community');
        await expect(p.locator('#outside')).toBeVisible();
        assert.ok(env.writes.length >= 8);
        assert.ok(env.writes.every(w => w.headers['x-community-owner'] === 'user-A'));
    });
}
finally {
    try {
        await browser?.close();
    }
    finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}
console.log(JSON.stringify({ passed: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length }));
if (results.some(x => !x.ok))
    process.exitCode = 1;
