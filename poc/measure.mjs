// 네컷일기 PoC 측정 스크립트.
// 앱과 같은 core.js(프롬프트·파서·이미지 URL)를 써서 dataset.json의 일기로 C1·C4를 자동 측정하고,
// C2·C3를 사람이 채점할 수 있도록 결과(JSON, 그림, report.html)를 남긴다.
//
// 사용법:  node poc/measure.mjs [--gap 46] [--only d01,d03]
// 결과는 poc/results/<시각>/ 에 새로 만든다(이전 결과를 덮어쓰지 않음).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEXT_API, SPLIT_SYSTEM, splitUserMessage, TRANSLATE_SYSTEM, parseTranslation,
  parseLooseJSON, normalizeComic, hasHangul, imageUrlFor, buildImagePrompt,
} from '../core.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
);
const GAP = Number(args.gap ?? 46) * 1000;
const only = args.only ? new Set(args.only.split(',')) : null;

const dataset = JSON.parse(await readFile(join(here, 'dataset.json'), 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(here, 'results', stamp);
await mkdir(join(outDir, 'images'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const last = { text: 0, image: 0 };

async function waitGap(kind) {
  const wait = last[kind] + GAP - Date.now();
  if (wait > 0) await sleep(wait);
  last[kind] = Date.now();
}

/** 제한(402/429)이면 Retry-After만큼 기다렸다 다시. 그 외 실패는 기록하고 돌려준다. */
async function call(kind, url, init) {
  const tries = [];
  for (let i = 0; i < 5; i++) {
    await waitGap(kind);
    const t0 = Date.now();
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
      const ms = Date.now() - t0;
      tries.push({ status: res.status, ms });
      if (res.status === 402 || res.status === 429) {
        const ra = Number(res.headers.get('retry-after')) || 45;
        log(`  ${kind} ${res.status} → ${ra}s 대기`);
        last[kind] = Date.now() + (ra + 1) * 1000 - GAP;
        continue;
      }
      return { res, tries };
    } catch (e) {
      tries.push({ error: String(e), ms: Date.now() - t0 });
      return { res: null, tries };
    }
  }
  return { res: null, tries };
}

async function askText(system, user) {
  const { res, tries } = await call('text', TEXT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      jsonMode: true,
      seed: Math.floor(Math.random() * 1e6),
    }),
  });
  const raw = res ? await res.text() : null;
  return { ok: !!res?.ok, raw, tries };
}

const results = { startedAt: new Date().toISOString(), gapSec: GAP / 1000, diaries: [] };
const save = () => writeFile(join(outDir, 'results.json'), JSON.stringify(results, null, 2));

for (const d of dataset.diaries) {
  if (only && !only.has(d.id)) continue;
  log(`${d.id} 시작`);
  const r = { id: d.id, hard: d.hard, drawImages: d.drawImages, events: d.events, features: d.features };
  results.diaries.push(r);
  // 한 편의 시간을 공정하게 재려고, 시작 전에 텍스트·이미지 제한이 모두 풀릴 때까지 기다린다.
  const idle = Math.max(last.text, last.image) + GAP - Date.now();
  if (idle > 0) await sleep(idle);
  const t0 = Date.now();

  // 1) 4컷 나누기 (C1: 첫 응답만으로 판정)
  const split = await askText(SPLIT_SYSTEM, splitUserMessage(d.diary, d.hero));
  r.split = { ok: split.ok, tries: split.tries, raw: split.raw };
  const comic = split.ok ? normalizeComic(parseLooseJSON(split.raw)) : null;
  r.c1_formatOk = !!comic;
  r.comic = comic;
  r.splitMs = Date.now() - t0;
  if (comic) {
    r.lang = {
      characterEnglish: !hasHangul(comic.character),
      scenesEnglish: comic.panels.filter((p) => !hasHangul(p.scene)).length,
      captionsKorean: comic.panels.filter((p) => hasHangul(p.caption)).length,
      dialoguesKoreanOrEmpty: comic.panels.filter((p) => !p.dialogue || hasHangul(p.dialogue)).length,
    };
  }
  log(`  나누기 ${r.c1_formatOk ? '성공' : '실패'} (${Math.round(r.splitMs / 1000)}s)`);
  await save();

  // 2) 그림 (C3·C4) — drawImages인 일기만
  if (comic && d.drawImages) {
    let character = comic.character;
    let scenes = comic.panels.map((p) => p.scene);
    if (hasHangul(character) || scenes.some(hasHangul)) {
      const tr = await askText(TRANSLATE_SYSTEM, JSON.stringify({ items: [character, ...scenes] }));
      const items = tr.ok ? parseTranslation(tr.raw, 1 + scenes.length) : null;
      r.translate = { needed: true, ok: !!items, tries: tr.tries };
      if (items) [character, ...scenes] = items;
    } else {
      r.translate = { needed: false };
    }
    const seed = Math.floor(Math.random() * 1e6);
    r.image = { seed, character, panels: [] };
    for (let i = 0; i < 4; i++) {
      const url = imageUrlFor(scenes[i], character, seed);
      const { res, tries } = await call('image', url, {});
      const p = { prompt: buildImagePrompt(scenes[i], character), tries, ok: false };
      if (res?.ok && (res.headers.get('content-type') || '').startsWith('image/')) {
        const file = `${d.id}-${i + 1}.jpg`;
        await writeFile(join(outDir, 'images', file), Buffer.from(await res.arrayBuffer()));
        p.ok = true;
        p.file = `images/${file}`;
      } else if (res) {
        p.body = (await res.text()).slice(0, 300);
      }
      r.image.panels.push(p);
      log(`  그림 ${i + 1} ${p.ok ? '성공' : '실패'}`);
      await save();
    }
    r.totalMs = Date.now() - t0;
    r.c4_under5min = r.image.panels.every((p) => p.ok) && r.totalMs <= 5 * 60_000;
    log(`  한 편 ${Math.round(r.totalMs / 1000)}s`);
  }
  await save();
}

results.finishedAt = new Date().toISOString();
await save();

// 사람이 채점할 보고서 (C2: 사건, C3: 일관성)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const byId = Object.fromEntries(dataset.diaries.map((d) => [d.id, d]));
const html = `<!doctype html><meta charset="utf-8"><title>PoC 결과 ${stamp}</title>
<style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:auto;padding:16px;line-height:1.5}
section{border:1px solid #ddd;border-radius:10px;padding:12px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.grid img{width:100%;border-radius:6px}
td,th{border:1px solid #ddd;padding:4px 6px;vertical-align:top;font-size:14px}table{border-collapse:collapse;width:100%}
.ok{color:#2f9e66}.bad{color:#d6453d}</style>
<h1>네컷일기 PoC 결과 <small>${stamp}</small></h1>
${results.diaries.map((r) => `<section><h2>${r.id}${r.hard ? ' (어려운 일기)' : ''} —
<span class="${r.c1_formatOk ? 'ok' : 'bad'}">C1 ${r.c1_formatOk ? '통과' : '실패'}</span>
${r.totalMs ? ` · ${Math.round(r.totalMs / 1000)}초` : ''}</h2>
<p><b>일기</b> ${esc(byId[r.id].diary)}</p>
<p><b>정답 사건</b> ${r.events.map(esc).join(' / ')}${r.features?.length ? `<br><b>주인공 특징</b> ${r.features.map(esc).join(', ')}` : ''}</p>
${r.comic ? `<p><b>제목</b> ${esc(r.comic.title)} · <b>character</b> ${esc(r.comic.character)}</p>
<table><tr><th>컷</th><th>해설</th><th>대사</th><th>장면</th></tr>
${r.comic.panels.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.caption)}</td><td>${esc(p.dialogue)}</td><td>${esc(p.scene)}</td></tr>`).join('')}</table>`
    : `<pre>${esc((r.split.raw || '').slice(0, 500))}</pre>`}
${r.image ? `<div class="grid">${r.image.panels.map((p, i) => p.ok ? `<img src="${p.file}" alt="${r.id} ${i + 1}컷">` : `<div class="bad">${i + 1}컷 실패</div>`).join('')}</div>` : ''}
</section>`).join('')}`;
await writeFile(join(outDir, 'report.html'), html);
log(`끝: ${outDir}`);
