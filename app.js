/* 네컷일기 — 일기를 AI 4컷 웹툰으로.
 * 외부 서비스: Pollinations.ai (무료, API 키 없음)
 *   - 텍스트: POST https://text.pollinations.ai/
 *   - 이미지: GET  https://image.pollinations.ai/prompt/<prompt>?width=768&height=768&seed=<n>
 * 무료 이미지는 "IP당 45초에 1장" 제한이 있어 이미지를 한 장씩 순서대로 요청한다.
 */
import {
  hasHangul, splitWith, translateWith, imageUrlFor, TEXT_API,
} from './core.js';
import { checkHero } from './hero-check.js';
import { community } from './community.js';
import { toast, ask } from './ui.js';

(() => {

  // ---------- 설정 ----------
  const IMAGE_GAP_MS = 46_000; // 무료 제한: 45초에 1장
  const BEATS = ['기 · 시작', '승 · 전개', '전 · 반전', '결 · 마무리'];
  const LS_GALLERY = 'comicDiary.gallery';
  const LS_LAST_IMG = 'comicDiary.lastImageAt';
  const LS_LAST_TEXT = 'comicDiary.lastTextAt';
  const TEXT_GAP_MS = 46_000; // 무료 제한: 45초에 1회
  const GALLERY_MAX = 20;

  // 캔버스 레이아웃 (1080 x 1240)
  const W = 1080, H = 1240, HEADER = 140, MARGIN = 24, GAP = 16;
  const PANEL = (W - MARGIN * 2 - GAP) / 2; // 508

  // ---------- 상태 ----------
  const state = {
    title: '',
    character: '',
    seed: 0,
    panels: [], // {scene, caption, dialogue, seed, status, msg, img}
    job: 0, // 새 만화를 시작하면 증가 → 이전 작업 취소
    queue: [],
    running: false,
    date: new Date(),
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    diary: $('diary'), hero: $('hero'),
    btnSplit: $('btnSplit'), btnManual: $('btnManual'), splitStatus: $('splitStatus'),
    stepEdit: $('step-edit'), stepResult: $('step-result'),
    title: $('title'), character: $('character'), panelEditors: $('panelEditors'),
    btnDraw: $('btnDraw'), btnBack: $('btnBack'),
    drawStatus: $('drawStatus'), heroStatus: $('heroStatus'), canvas: $('comic'), panelControls: $('panelControls'),
    btnDownload: $('btnDownload'), btnSave: $('btnSave'), btnShare: $('btnShare'), btnNew: $('btnNew'),
    loginNote: $('loginNote'),
    galleryGrid: $('galleryGrid'), galleryCount: $('galleryCount'),
    viewer: $('viewer'), viewerImg: $('viewerImg'), viewerDownload: $('viewerDownload'),
    viewerDelete: $('viewerDelete'), viewerClose: $('viewerClose'),
  };
  const ctx = el.canvas.getContext('2d');

  // ---------- 유틸 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randSeed = () => Math.floor(Math.random() * 1_000_000);
  const lsGet = (k, fallback) => {
    try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  const fmtDate = (d) => {
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} (${days[d.getDay()]})`;
  };
  const fileDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function setStatus(node, text, kind = '', spin = false) {
    node.className = 'status' + (kind ? ' ' + kind : '');
    node.innerHTML = '';
    if (spin) { const s = document.createElement('span'); s.className = 'spinner'; node.appendChild(s); }
    node.appendChild(document.createTextNode(text));
  }
  const isLocalhostName = () => location.hostname === 'localhost';

  async function fetchWithTimeout(url, opts = {}, ms = 90_000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ac.signal }); }
    finally { clearTimeout(t); }
  }

  // ---------- 텍스트 AI ----------
  // 무료 텍스트도 "IP당 45초에 1회" 제한 → 402면 Retry-After 만큼 기다렸다 다시 요청.
  async function askText(system, user, { json = true, onWait } = {}) {
    let lastErr;
    let waits = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const last = Number(lsGet(LS_LAST_TEXT, 0)) || 0;
        let until = last + TEXT_GAP_MS;
        while (Date.now() < until) {
          onWait?.(Math.ceil((until - Date.now()) / 1000));
          await sleep(Math.min(1000, until - Date.now()));
        }
        onWait?.(0);
        lsSet(LS_LAST_TEXT, Date.now());
        const res = await fetchWithTimeout(TEXT_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            jsonMode: json,
            seed: randSeed(),
          }),
        }, 60_000);
        const body = await res.text();
        if (res.status === 403 && /turnstile/i.test(body)) throw new Error('BLOCKED');
        if ((res.status === 402 || res.status === 429) && waits < 3) {
          waits++;
          const ra = Number(res.headers.get('Retry-After')) || 45;
          lsSet(LS_LAST_TEXT, Date.now() + (ra + 1) * 1000 - TEXT_GAP_MS);
          attempt--; // 제한 대기는 실패 횟수로 세지 않음
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return body;
      } catch (e) {
        lastErr = e;
        if (e.message === 'BLOCKED') break;
        await sleep(1500);
      }
    }
    throw lastErr;
  }

  // 형식이 깨지면 한 번 더 요청한다(45초쯤 더 걸림).
  async function splitDiary(diary, hero, onWait) {
    const { comic } = await splitWith((sys, user) => askText(sys, user, { onWait }), diary, hero);
    return comic;
  }

  /** 한국어가 섞인 주인공 묘사/장면을 영어 프롬프트로 번역. ok=false면 번역 실패. */
  const translatePrompts = (character, scenes, onWait) =>
    translateWith((sys, user) => askText(sys, user, { onWait }), character, scenes);

  // ---------- 이미지 ----------
  const imageUrl = (p) => imageUrlFor(p.scene, state.character, p.seed);

  function enqueue(i) {
    if (!state.queue.includes(i)) state.queue.push(i);
    state.panels[i].status = 'waiting';
    state.panels[i].msg = '대기 중';
    renderControls();
    if (!state.running) runQueue(state.job);
  }

  async function runQueue(job) {
    state.running = true;
    while (state.queue.length && job === state.job) {
      const i = state.queue[0];
      await drawPanelImage(i, job);
      state.queue.shift();
    }
    if (job === state.job) state.running = false;
    if (job === state.job) afterQueue();
  }

  async function waitForSlot(i, job, extraMs = 0) {
    const last = Number(lsGet(LS_LAST_IMG, 0)) || 0;
    const until = Math.max(last + IMAGE_GAP_MS, Date.now() + extraMs);
    while (Date.now() < until) {
      if (job !== state.job) return false;
      const sec = Math.ceil((until - Date.now()) / 1000);
      state.panels[i].msg = `${sec}초 뒤 그려요`;
      updateDrawStatus(`무료 서버 순서 기다리는 중… ${i + 1}번 컷은 ${sec}초 뒤 시작`);
      renderControls();
      await sleep(Math.min(1000, until - Date.now()));
    }
    return job === state.job;
  }

  async function drawPanelImage(i, job) {
    const p = state.panels[i];
    let extra = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (!(await waitForSlot(i, job, extra))) return;
      extra = 0;
      p.status = 'loading';
      p.msg = '그리는 중…';
      updateDrawStatus(`${i + 1}번 컷 그리는 중… (보통 10~20초)`, true);
      renderControls();
      lsSet(LS_LAST_IMG, Date.now());
      try {
        const res = await fetchWithTimeout(imageUrl(p), {}, 120_000);
        if (job !== state.job) return;
        if (res.status === 402 || res.status === 429) {
          const ra = Number(res.headers.get('Retry-After')) || 45;
          extra = (ra + 1) * 1000;
          lsSet(LS_LAST_IMG, 0);
          continue;
        }
        if (res.status === 403) {
          const body = await res.text();
          throw new Error(/turnstile/i.test(body) ? 'BLOCKED' : 'HTTP 403');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (!blob.type.startsWith('image/')) throw new Error('이미지가 아닌 응답');
        p.img = await blobToImage(blob);
        p.status = 'done';
        p.msg = '완성';
        lsSet(LS_LAST_IMG, Date.now());
        renderControls();
        await renderComic();
        return;
      } catch (e) {
        if (job !== state.job) return;
        if (e.message === 'BLOCKED') {
          p.status = 'error';
          p.msg = '차단됨';
          updateDrawStatus(blockedMessage(), false, 'err');
          renderControls();
          return;
        }
        p.msg = `실패, 다시 시도 (${attempt + 1})`;
        renderControls();
        extra = 3000;
      }
    }
    p.status = 'error';
    p.msg = '실패 — 다시 그리기를 눌러 주세요';
    renderControls();
    await renderComic();
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지 디코딩 실패')); };
      img.src = url;
    });
  }

  function blockedMessage() {
    return isLocalhostName()
      ? 'Pollinations가 localhost 요청을 막았어요. 주소창의 localhost를 127.0.0.1로 바꿔서 열어 주세요.'
      : 'Pollinations가 요청을 막았어요(봇 확인). 잠시 후 다시 시도해 주세요.';
  }

  function afterQueue() {
    const done = state.panels.filter((p) => p.status === 'done').length;
    const failed = state.panels.some((p) => p.status === 'error');
    const all = done === 4;
    el.btnDownload.disabled = !all;
    el.btnSave.disabled = !all;
    el.btnShare.disabled = !all;
    el.btnDraw.disabled = false;
    if (all) {
      updateDrawStatus('완성! PNG로 내려받거나 갤러리에 저장하세요. 마음에 안 드는 컷은 다시 그릴 수 있어요.', false, 'ok');
      runHeroCheck(state.job);
    }
    else if (failed && !el.drawStatus.classList.contains('err')) updateDrawStatus('일부 컷을 그리지 못했어요. 해당 컷의 “다시 그리기”를 눌러 주세요.', false, 'err');
  }

  function updateDrawStatus(text, spin = false, kind = '') { setStatus(el.drawStatus, text, kind, spin); }

  // ---------- 주인공 검사 (YOLO, 브라우저 안에서 실행) ----------
  // 4컷이 다 그려지면 컷마다 사람을 찾고, 머리·옷 색이 다른 컷을 ⚠️로 알려 준다.
  async function runHeroCheck(job) {
    const status = (t, kind = '', spin = false) => setStatus(el.heroStatus, t, kind, spin);
    el.heroStatus.classList.remove('hidden');
    try {
      const r = await checkHero(state.panels.map((p) => p.img), (m) => job === state.job && status(m, '', true));
      if (job !== state.job) return;
      r.panels.forEach((c, i) => {
        const p = state.panels[i];
        p.hero = c;
        p.msg = c.verdict === 'ok' ? '완성 · 👤 주인공 OK'
          : c.verdict === 'none' ? '완성 · ⚠️ 주인공이 안 보여요'
            : `완성 · ⚠️ 다른 사람 같아요 (비슷함 ${Math.round(c.same * 100)}%)`;
      });
      renderControls();
      status(r.summary, r.ok ? 'ok' : 'err');
    } catch (e) {
      if (job !== state.job) return;
      console.warn('주인공 검사 실패', e);
      status('주인공 검사를 하지 못했어요(모델을 불러오지 못함). 만화는 그대로 쓸 수 있어요.', 'err');
    }
  }

  // ---------- 캔버스 그리기 ----------
  const FONT_TITLE = '700 64px Gaegu';
  const FONT_DATE = '400 26px "Noto Sans KR"';
  const FONT_CAPTION = '700 25px "Noto Sans KR"';
  const FONT_BUBBLE = '700 36px Gaegu';
  const FONT_SMALL = '400 18px "Noto Sans KR"';

  async function ensureFonts() {
    if (!document.fonts?.load) return;
    const text = [state.title, ...state.panels.flatMap((p) => [p.caption, p.dialogue]), '네컷일기 0123456789.()월화수목금토일 그리는중대기'].join('');
    try {
      await Promise.all([
        document.fonts.load(FONT_TITLE, text), document.fonts.load(FONT_BUBBLE, text),
        document.fonts.load(FONT_CAPTION, text), document.fonts.load(FONT_DATE, text),
      ]);
    } catch { /* 시스템 글꼴로 대체 */ }
  }

  function wrapText(text, maxWidth, maxLines) {
    const lines = [];
    let line = '';
    for (const word of text.split(/(\s+)/)) {
      const test = line + word;
      if (ctx.measureText(test).width <= maxWidth) { line = test; continue; }
      if (line.trim()) { lines.push(line.trim()); line = ''; }
      // 단어 자체가 길면 글자 단위로 자른다 (한국어 대응)
      for (const ch of word.trimStart()) {
        if (ctx.measureText(line + ch).width > maxWidth && line) { lines.push(line); line = ''; }
        line += ch;
      }
    }
    if (line.trim()) lines.push(line.trim());
    if (lines.length > maxLines) {
      lines.length = maxLines;
      let last = lines[maxLines - 1];
      while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
      lines[maxLines - 1] = last + '…';
    }
    return lines;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCover(img, x, y, size) {
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - s) / 2, sy = (img.naturalHeight - s) / 2;
    ctx.drawImage(img, sx, sy, s, s, x, y, size, size);
  }

  function drawBubble(text, px, py, right) {
    ctx.font = FONT_BUBBLE;
    const lines = wrapText(text, PANEL * 0.62, 3);
    const lh = 40;
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 44;
    const h = lines.length * lh + 26;
    const bx = right ? px + PANEL - w - 18 : px + 18;
    const by = py + 18;
    // 꼬리
    const tx = bx + (right ? w * 0.3 : w * 0.7);
    ctx.beginPath();
    ctx.moveTo(tx - 14, by + h - 4);
    ctx.lineTo(tx + (right ? -26 : 26), by + h + 30);
    ctx.lineTo(tx + 14, by + h - 4);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1b1b1b';
    ctx.lineWidth = 3;
    ctx.fill();
    ctx.stroke();
    roundRect(bx, by, w, h, 28);
    ctx.fill();
    ctx.stroke();
    // 꼬리와 몸통 사이 선 지우기
    ctx.fillRect(tx - 12, by + h - 6, 24, 5);
    ctx.fillStyle = '#1b1b1b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((l, k) => ctx.fillText(l, bx + w / 2, by + 13 + lh / 2 + k * lh + 2));
  }

  function drawCaption(text, px, py) {
    ctx.font = FONT_CAPTION;
    const lines = wrapText(text, PANEL - 48, 2);
    const lh = 34;
    const h = lines.length * lh + 18;
    const y = py + PANEL - h;
    ctx.fillStyle = 'rgba(255, 251, 240, 0.93)';
    ctx.fillRect(px, y, PANEL, h);
    ctx.strokeStyle = '#1b1b1b';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px + PANEL, y); ctx.stroke();
    ctx.fillStyle = '#2b2118';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((l, k) => ctx.fillText(l, px + PANEL / 2, y + 9 + lh / 2 + k * lh));
  }

  function drawPlaceholder(p, i, x, y) {
    ctx.fillStyle = '#f1ebe3';
    ctx.fillRect(x, y, PANEL, PANEL);
    ctx.fillStyle = '#b9ab9b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 120px Gaegu';
    ctx.fillText(String(i + 1), x + PANEL / 2, y + PANEL / 2 - 30);
    ctx.font = '400 26px "Noto Sans KR"';
    ctx.fillText(p.msg || '', x + PANEL / 2, y + PANEL / 2 + 60);
  }

  async function renderComic() {
    await ensureFonts();
    ctx.save();
    ctx.fillStyle = '#fffaf2';
    ctx.fillRect(0, 0, W, H);

    // 머리말
    ctx.fillStyle = '#2b2118';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = FONT_TITLE;
    let title = state.title || '오늘의 일기';
    while (ctx.measureText(title).width > W - MARGIN * 2 - 280 && title.length > 1) title = title.slice(0, -1);
    ctx.fillText(title, MARGIN + 4, 92);
    ctx.font = FONT_DATE;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#7a6a5c';
    ctx.fillText(fmtDate(state.date), W - MARGIN - 4, 88);
    ctx.strokeStyle = '#2b2118';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(MARGIN, 118); ctx.lineTo(W - MARGIN, 118); ctx.stroke();

    // 4컷
    state.panels.forEach((p, i) => {
      const x = MARGIN + (i % 2) * (PANEL + GAP);
      const y = HEADER + Math.floor(i / 2) * (PANEL + GAP);
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, PANEL, PANEL); ctx.clip();
      if (p.img) drawCover(p.img, x, y, PANEL); else drawPlaceholder(p, i, x, y);
      if (p.dialogue) drawBubble(p.dialogue, x, y, i % 2 === 1);
      if (p.caption) drawCaption(p.caption, x, y);
      ctx.restore();
      ctx.strokeStyle = '#1b1b1b';
      ctx.lineWidth = 5;
      ctx.strokeRect(x, y, PANEL, PANEL);
    });

    // 꼬리말
    ctx.font = FONT_SMALL;
    ctx.fillStyle = '#9a8a7a';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('네컷일기 · 그림 Pollinations.ai', W - MARGIN - 4, H - 22);
    ctx.restore();
  }

  // ---------- 화면: 편집 ----------
  function showEdit(comic) {
    state.title = comic.title;
    state.character = comic.character;
    state.panels = comic.panels.map((p) => ({ ...p }));
    el.title.value = comic.title;
    el.character.value = comic.character;
    el.panelEditors.innerHTML = '';
    comic.panels.forEach((p, i) => {
      const box = document.createElement('div');
      box.className = 'panel-editor';
      box.innerHTML = `
        <h3>${i + 1}컷<em>${BEATS[i]}</em></h3>
        <label>장면 설명 (한국어로 써도 자동으로 영어 프롬프트로 바꿔요)<textarea rows="2" data-k="scene" data-i="${i}" maxlength="400"></textarea></label>
        <label>말풍선 대사<input type="text" data-k="dialogue" data-i="${i}" maxlength="40" /></label>
        <label>아래 해설<input type="text" data-k="caption" data-i="${i}" maxlength="50" /></label>`;
      box.querySelectorAll('[data-k]').forEach((f) => { f.value = p[f.dataset.k] || ''; });
      el.panelEditors.appendChild(box);
    });
    el.stepEdit.classList.remove('hidden');
    el.stepResult.classList.add('hidden');
    el.stepEdit.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function readEditor() {
    state.title = el.title.value.trim() || '오늘의 일기';
    state.character = el.character.value.trim();
    el.panelEditors.querySelectorAll('[data-k]').forEach((f) => {
      state.panels[f.dataset.i][f.dataset.k] = f.value.trim();
    });
  }

  // ---------- 화면: 결과 ----------
  function renderControls() {
    if (!el.panelControls.children.length) {
      state.panels.forEach((_, i) => {
        const box = document.createElement('div');
        box.className = 'panel-ctl';
        box.innerHTML = `
          <div class="ctl-head">
            <b>${i + 1}컷</b><span class="state"></span>
            <button class="ghost small" data-regen="${i}">🔄 다시 그리기</button>
          </div>
          <input type="text" data-k="dialogue" data-i="${i}" maxlength="40" placeholder="말풍선 대사" aria-label="${i + 1}컷 말풍선 대사" />
          <input type="text" data-k="caption" data-i="${i}" maxlength="50" placeholder="아래 해설" aria-label="${i + 1}컷 해설" />`;
        box.querySelectorAll('input').forEach((f) => { f.value = state.panels[i][f.dataset.k] || ''; });
        el.panelControls.appendChild(box);
      });
    }
    state.panels.forEach((p, i) => {
      const s = el.panelControls.children[i].querySelector('.state');
      s.textContent = p.msg || '';
      const warn = p.status === 'done' && p.hero && p.hero.verdict !== 'ok';
      s.className = 'state' + (warn ? ' err' : p.status === 'done' ? ' ok' : p.status === 'error' ? ' err' : '');
      el.panelControls.children[i].querySelector('[data-regen]').disabled =
        p.status === 'waiting' || p.status === 'loading';
    });
  }

  async function startDrawing() {
    readEditor();
    if (!community.requireLogin({ diary: el.diary.value, hero: el.hero.value })) return;
    if (state.panels.some((p) => !p.scene)) {
      toast('4컷 모두 장면을 적어 주세요.', 'err');
      return;
    }
    state.job++;
    state.queue = [];
    state.running = false;
    state.seed = randSeed();
    state.date = new Date();
    el.btnDraw.disabled = true;
    el.btnDownload.disabled = true;
    el.btnSave.disabled = true;
    el.btnShare.disabled = true;
    el.heroStatus.classList.add('hidden');
    el.panelControls.innerHTML = '';
    el.stepResult.classList.remove('hidden');
    el.stepResult.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // 한국어로 쓴 장면은 영어 프롬프트로 번역
    if (hasHangul(state.character) || state.panels.some((p) => hasHangul(p.scene))) {
      const job = state.job;
      updateDrawStatus('장면 설명을 영어 프롬프트로 바꾸는 중…', true);
      const t = await translatePrompts(state.character, state.panels.map((p) => p.scene),
        (sec) => updateDrawStatus(sec > 0 ? `장면 설명을 영어로 바꾸려고 기다리는 중… (무료 서버 제한 ${sec}초)` : '장면 설명을 영어로 바꾸는 중…', true));
      if (job !== state.job) return;
      if (!t.ok) {
        // 한국어 묘사 그대로 그리면 컷마다 다른 사람이 나온다(PoC 1차 측정 d03) → 그리지 않고 멈춘다.
        updateDrawStatus('장면 설명을 영어로 바꾸지 못했어요. “그림 그리기”를 다시 눌러 주세요.', false, 'err');
        el.btnDraw.disabled = false;
        return;
      }
      state.character = t.character;
      t.scenes.forEach((s, i) => { state.panels[i].scene = s; });
    }

    state.panels.forEach((p) => {
      p.seed = state.seed; // 같은 seed → 캐릭터 일관성 ↑
      p.img = null;
      p.hero = null;
      p.status = 'idle';
      p.msg = '';
    });
    renderControls();
    await renderComic();
    state.panels.forEach((_, i) => enqueue(i));
  }

  // ---------- 다운로드 / 갤러리 ----------
  function download() {
    el.canvas.toBlob((blob) => {
      if (!blob) return toast('이미지를 만들지 못했어요.', 'err');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `네컷일기_${fileDate(state.date)}_${(state.title || '').replace(/[\\/:*?"<>|\s]+/g, '_')}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
  }

  function loadGallery() { return lsGet(LS_GALLERY, []); }

  function saveToGallery() {
    const item = {
      id: Date.now().toString(36),
      title: state.title,
      date: fmtDate(state.date),
      img: el.canvas.toDataURL('image/jpeg', 0.82),
    };
    const list = [item, ...loadGallery()].slice(0, GALLERY_MAX);
    while (list.length) {
      if (lsSet(LS_GALLERY, list)) {
        el.btnSave.disabled = true;
        updateDrawStatus(`갤러리에 저장했어요 (${list.length}개).`, false, 'ok');
        renderGallery();
        return;
      }
      if (list.length === 1) break;
      list.pop(); // 저장 공간이 부족하면 가장 오래된 것부터 지움
    }
    updateDrawStatus('브라우저 저장 공간이 부족해서 저장하지 못했어요. PNG로 내려받아 주세요.', false, 'err');
  }

  function renderGallery() {
    const list = loadGallery();
    el.galleryCount.textContent = list.length ? `(${list.length})` : '';
    el.galleryGrid.innerHTML = '';
    if (!list.length) {
      el.galleryGrid.innerHTML = '<p class="empty">아직 저장한 네컷이 없어요.</p>';
      return;
    }
    list.forEach((it) => {
      const b = document.createElement('button');
      b.className = 'gallery-item';
      const img = document.createElement('img');
      img.src = it.img; img.alt = it.title; img.loading = 'lazy';
      const cap = document.createElement('span');
      const t = document.createElement('b'); t.textContent = it.title;
      cap.append(t, document.createTextNode(it.date));
      b.append(img, cap);
      b.addEventListener('click', () => openViewer(it));
      el.galleryGrid.appendChild(b);
    });
  }

  let viewing = null;
  function openViewer(it) {
    viewing = it;
    el.viewerImg.src = it.img;
    el.viewerImg.alt = it.title;
    el.viewerDownload.href = it.img;
    el.viewerDownload.download = `네컷일기_${it.title}.jpg`;
    el.viewer.showModal();
  }

  // ---------- 이벤트 ----------
  function switchView(view) {
    document.querySelectorAll('.tab[data-view]').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    document.body.dataset.view = view;
    if (view === 'gallery') renderGallery();
    if (view === 'community') community.renderBoard();
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll('.tab[data-view]').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  el.btnSplit.addEventListener('click', async () => {
    if (!community.requireLogin({ diary: el.diary.value, hero: el.hero.value })) return;
    const diary = el.diary.value.trim();
    if (diary.length < 10) {
      setStatus(el.splitStatus, '일기를 조금만 더 길게 써 주세요 (10자 이상).', 'err');
      el.diary.focus();
      return;
    }
    el.btnSplit.disabled = true;
    setStatus(el.splitStatus, 'AI가 일기를 기승전결 4컷으로 나누는 중… (10초쯤 걸려요)', '', true);
    try {
      const comic = await splitDiary(diary, el.hero.value.trim(),
        (sec) => setStatus(el.splitStatus, sec > 0 ? `무료 AI 서버 순서 기다리는 중… ${sec}초` : 'AI가 일기를 기승전결 4컷으로 나누는 중… (10~20초)', '', true));
      if (!comic) throw new Error('PARSE');
      setStatus(el.splitStatus, '4컷으로 나눴어요! 아래에서 대사와 장면을 고칠 수 있어요.', 'ok');
      showEdit(comic);
    } catch (e) {
      const msg = e.message === 'BLOCKED' ? blockedMessage()
        : 'AI가 4컷을 제대로 나누지 못했어요. 직접 4컷을 써 주세요 (다시 눌러 봐도 돼요).';
      setStatus(el.splitStatus, msg, 'err');
      if (e.message !== 'BLOCKED') showManual();
    } finally {
      el.btnSplit.disabled = false;
    }
  });

  function showManual() {
    showEdit({
      title: '오늘의 일기',
      character: el.hero.value.trim(),
      panels: Array.from({ length: 4 }, () => ({ scene: '', caption: '', dialogue: '' })),
    });
  }
  el.btnManual.addEventListener('click', () => {
    if (!community.requireLogin({ diary: el.diary.value, hero: el.hero.value })) return;
    showManual();
  });

  el.btnDraw.addEventListener('click', startDrawing);
  el.btnBack.addEventListener('click', () => { el.diary.focus(); el.diary.scrollIntoView({ behavior: 'smooth' }); });

  el.panelControls.addEventListener('click', (e) => {
    const b = e.target.closest('[data-regen]');
    if (!b) return;
    const i = Number(b.dataset.regen);
    const p = state.panels[i];
    p.seed = randSeed();
    p.img = null;
    p.hero = null;
    el.heroStatus.classList.add('hidden');
    el.btnDownload.disabled = true;
    el.btnSave.disabled = true;
    el.btnShare.disabled = true;
    enqueue(i);
    renderComic();
  });
  el.panelControls.addEventListener('input', (e) => {
    const f = e.target.closest('[data-k]');
    if (!f) return;
    state.panels[f.dataset.i][f.dataset.k] = f.value.trim();
    if (!el.btnDownload.disabled) el.btnSave.disabled = false;
    renderComic();
  });

  el.btnDownload.addEventListener('click', download);
  el.btnSave.addEventListener('click', saveToGallery);
  el.btnShare.addEventListener('click', () => community.openShare(el.canvas, state.title));
  el.btnNew.addEventListener('click', () => {
    state.job++;
    state.queue = [];
    state.running = false;
    el.stepEdit.classList.add('hidden');
    el.stepResult.classList.add('hidden');
    el.diary.value = '';
    setStatus(el.splitStatus, '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    el.diary.focus();
  });

  el.viewerClose.addEventListener('click', () => el.viewer.close());
  el.viewer.addEventListener('click', (e) => { if (e.target === el.viewer) el.viewer.close(); });
  el.viewerDelete.addEventListener('click', async () => {
    if (!viewing) return;
    el.viewer.close();
    const ok = await ask({ icon: '🗑', title: '내 갤러리에서 지울까요?', message: `“${viewing.title}” — 이 브라우저에서 지워져요.`, ok: '지우기', danger: true });
    if (!ok) return;
    lsSet(LS_GALLERY, loadGallery().filter((it) => it.id !== viewing.id));
    el.viewer.close();
    renderGallery();
  });

  if (new URLSearchParams(location.search).has('debug')) window.comicDiary = { state, imageUrl };
  renderGallery();

  // ---------- 로그인 ----------
  const draft = community.takeDraft(); // 로그인하러 갔다 오기 전에 쓰던 일기 되살리기
  if (draft) { el.diary.value = draft.diary || ''; el.hero.value = draft.hero || ''; }
  const showLoginNote = (u) => el.loginNote.classList.toggle('hidden', !community.enabled || Boolean(u));
  el.btnShare.classList.toggle('hidden', !community.enabled); // 서버 설정 전엔 공유 버튼 숨김
  community.onAuth(showLoginNote);
  showLoginNote(null);
  community.init();
  const startView = location.hash === '#community' ? 'community' : 'write';
  switchView(startView);

  if (isLocalhostName()) setStatus(el.splitStatus, '참고: localhost 주소에서는 무료 AI가 막혀요. 127.0.0.1로 열어 주세요.', 'err');
})();
