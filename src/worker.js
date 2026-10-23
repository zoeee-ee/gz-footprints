// 广州足迹地图 · 后端(Cloudflare Worker + R2)
// 访客:只能读取"公开内容";编辑:需要 EDIT_PASSWORD

const J = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

async function isOwner(req, env) {
  const given = req.headers.get('x-edit-password') || '';
  if (!env.EDIT_PASSWORD || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(String(env.EDIT_PASSWORD))),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function readData(env) {
  const obj = await env.BUCKET.get('data.json');
  if (!obj) return { rev: 0, places: {}, custom: [], photos: {} };
  try { return JSON.parse(await obj.text()); } catch (e) { return { rev: 0, places: {}, custom: [], photos: {} }; }
}

// 给访客看的版本:去掉"仅自己可见"的内容
function publicView(d) {
  const places = {}, photos = {};
  const hidden = new Set();
  for (const [id, p] of Object.entries(d.places || {})) {
    if (p && p.hidden) { hidden.add(String(id)); continue; }
    places[id] = p;
  }
  const custom = (d.custom || []).filter((c) => !hidden.has(String(c.id)));
  for (const [pid, list] of Object.entries(d.photos || {})) {
    if (!hidden.has(String(pid))) photos[pid] = list;
  }
  return { rev: d.rev || 0, places, custom, photos };
}

const ID_RE = /^[a-z0-9]{6,40}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (!env.BUCKET) return J({ error: '服务器没有绑定 R2 存储桶(BUCKET)' }, 500);

    try {
      // ---- 登录检查 ----
      if (path === '/api/login' && req.method === 'POST') {
        if (await isOwner(req, env)) return J({ ok: true });
        await new Promise((r) => setTimeout(r, 800)); // 减缓暴力尝试
        return J({ ok: false }, 401);
      }

      // ---- 读取数据 ----
      if (path === '/api/data' && req.method === 'GET') {
        const d = await readData(env);
        if (url.searchParams.get('full') === '1') {
          if (!(await isOwner(req, env))) return J({ error: '未授权' }, 401);
          return J(d);
        }
        return J(publicView(d), 200, { 'cache-control': 'no-cache' });
      }

      // ---- 保存数据(仅本人)----
      if (path === '/api/data' && req.method === 'PUT') {
        if (!(await isOwner(req, env))) return J({ error: '未授权' }, 401);
        const text = await req.text();
        if (text.length > 3_000_000) return J({ error: '数据过大' }, 413);
        const body = JSON.parse(text);
        const cur = await readData(env);
        if ((body.baseRev || 0) !== (cur.rev || 0)) return J({ error: 'conflict', rev: cur.rev || 0 }, 409);
        const next = {
          rev: (cur.rev || 0) + 1,
          updated: Date.now(),
          places: body.places || {},
          custom: body.custom || [],
          photos: body.photos || {},
        };
        await env.BUCKET.put('data.json', JSON.stringify(next), { httpMetadata: { contentType: 'application/json' } });
        // 每次保存留一份当天备份(同一天覆盖)
        const day = new Date().toISOString().slice(0, 10);
        await env.BUCKET.put(`backup/data-${day}.json`, JSON.stringify(next), { httpMetadata: { contentType: 'application/json' } });
        return J({ ok: true, rev: next.rev });
      }

      // ---- 照片 ----
      const m = path.match(/^\/api\/photo\/([a-z0-9]+)(\/t)?$/);
      if (m) {
        const id = m[1], thumb = !!m[2];
        if (!ID_RE.test(id)) return J({ error: '无效编号' }, 400);
        const key = `photos/${id}${thumb ? '_t' : ''}.jpg`;

        if (req.method === 'PUT') {
          if (!(await isOwner(req, env))) return J({ error: '未授权' }, 401);
          const buf = await req.arrayBuffer();
          if (buf.byteLength > 8_000_000) return J({ error: '照片过大' }, 413);
          if (buf.byteLength < 100) return J({ error: '空文件' }, 400);
          await env.BUCKET.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
          return J({ ok: true });
        }
        if (req.method === 'DELETE') {
          if (!(await isOwner(req, env))) return J({ error: '未授权' }, 401);
          await env.BUCKET.delete([`photos/${id}.jpg`, `photos/${id}_t.jpg`]);
          return J({ ok: true });
        }
        if (req.method === 'GET') {
          const owner = await isOwner(req, env);
          // 属于"仅自己可见"地点的照片,访客拿不到
          const d = await readData(env);
          let hiddenPhoto = false;
          for (const [pid, list] of Object.entries(d.photos || {})) {
            if ((list || []).some((p) => p.id === id) && d.places && d.places[pid] && d.places[pid].hidden) hiddenPhoto = true;
          }
          if (hiddenPhoto && !owner) return new Response('Not found', { status: 404 });
          const obj = await env.BUCKET.get(key);
          if (!obj) return new Response('Not found', { status: 404 });
          return new Response(obj.body, {
            headers: {
              'content-type': 'image/jpeg',
              'cache-control': hiddenPhoto ? 'private, no-store' : 'public, max-age=31536000, immutable',
            },
          });
        }
      }

      return J({ error: '没有这个接口' }, 404);
    } catch (e) {
      return J({ error: String((e && e.message) || e) }, 500);
    }
  },
};
