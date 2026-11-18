/* 모두의 네컷 — 구글 로그인, 작품 공유, 하트 투표, 신고, 관리자 삭제.
 * 서버: Supabase (DB 규칙은 supabase/setup.sql — 보안은 DB의 RLS가 최종 책임)
 * 이 파일은 화면만 담당한다. 사용자가 쓴 글은 전부 textContent로 넣어 XSS를 막는다.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.99.3/+esm';
const BUCKET = 'comics';
const PAGE = 60;
const LS_NICK = 'comicDiary.nickname';
const SS_DRAFT = 'comicDiary.draft';

const $ = (id) => document.getElementById(id);
const enabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let sb = null;
let user = null;
let admin = false;
let sort = 'popular'; // popular | recent | mine
const listeners = [];

// ---------- 공통 ----------
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  n.append(...kids.filter(Boolean));
  return n;
}
const fmt = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
};
const errText = (e) => {
  const m = String(e?.message || e || '');
  if (/하루에|로그인이|내 작품만|관리자만|경로가/.test(m)) return m;
  if (/duplicate|unique/i.test(m)) return '이미 했어요.';
  if (/row-level|permission|not allowed|unauthorized|jwt/i.test(m)) return '권한이 없어요. 다시 로그인해 주세요.';
  if (/payload too large|exceeded|size/i.test(m)) return '그림 파일이 너무 커요 (2MB까지).';
  return '서버와 연결하지 못했어요. 잠시 뒤 다시 해 주세요.';
};
const userName = (u) => u?.user_metadata?.name || u?.user_metadata?.full_name || (u?.email || '').split('@')[0] || '나';

// ---------- 로그인 ----------
async function init() {
  renderAuth();
  if (!enabled) { renderBoard(); return; }
  try {
    const { createClient } = await import(SUPABASE_JS);
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    const { data } = await sb.auth.getSession();
    await setUser(data.session?.user || null);
    sb.auth.onAuthStateChange((_ev, session) => {
      const next = session?.user || null;
      if ((next?.id || null) !== (user?.id || null)) setUser(next);
    });
    // 로그인 후 돌아온 주소(?code=…)를 깨끗하게
    if (location.search.includes('code=')) history.replaceState(null, '', location.pathname + location.hash);
  } catch (e) {
    console.error(e);
    sb = null;
    renderAuth('로그인 서버에 연결하지 못했어요');
  }
}

async function setUser(u) {
  user = u;
  admin = false;
  if (user && sb) {
    const { data } = await sb.rpc('is_admin');
    admin = data === true;
  }
  renderAuth();
  listeners.forEach((fn) => fn(user));
  if (document.body.dataset.view === 'community') renderBoard();
}

async function login() {
  if (!sb) return alert('로그인 서버가 아직 설정되지 않았어요.');
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } },
  });
  if (error) alert(errText(error));
}

async function logout() {
  if (!sb) return;
  await sb.auth.signOut();
}

function renderAuth(msg) {
  const box = $('authBox');
  if (!box) return;
  box.replaceChildren();
  if (!enabled) return;
  if (msg) { box.append(h('span', { class: 'auth-name', text: msg })); return; }
  if (user) {
    box.append(
      h('span', { class: 'auth-name', title: user.email || '', text: (admin ? '👑 ' : '') + userName(user) }),
      h('button', { class: 'ghost small', onclick: logout, text: '로그아웃' }),
    );
  } else {
    box.append(h('button', { class: 'google small', onclick: login },
      h('span', { class: 'g', text: 'G' }), '구글 로그인'));
  }
}

/** 쓰기 전에 부른다. 로그인 돼 있으면 true. 아니면 안내 후 로그인으로 보낸다(일기 초안은 잠깐 보관). */
function requireLogin(draft) {
  if (!enabled || user) return true;
  if (confirm('네컷일기를 만들려면 구글 로그인이 필요해요.\n지금 로그인할까요? (쓰던 일기는 그대로 남아요)')) {
    try { if (draft) sessionStorage.setItem(SS_DRAFT, JSON.stringify(draft)); } catch { /* 무시 */ }
    login();
  }
  return false;
}

function takeDraft() {
  try {
    const v = sessionStorage.getItem(SS_DRAFT);
    sessionStorage.removeItem(SS_DRAFT);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

// ---------- 공유하기 ----------
function openShare(canvas, title) {
  if (!enabled) return alert('공유 서버가 아직 설정되지 않았어요.');
  if (!requireLogin()) return;
  const dlg = $('shareDialog');
  $('shareTitle').value = (title || '오늘의 일기').slice(0, 30);
  try { $('shareNick').value = localStorage.getItem(LS_NICK) || ''; } catch { /* 무시 */ }
  $('sharePublic').checked = true;
  $('shareStatus').textContent = '';
  $('shareStatus').className = 'status';
  $('shareSubmit').disabled = false;
  $('shareSubmit').onclick = (e) => { e.preventDefault(); submitShare(canvas); };
  dlg.showModal();
  $('shareNick').focus();
}

async function submitShare(canvas) {
  const title = $('shareTitle').value.trim();
  const nickname = $('shareNick').value.trim();
  const isPublic = $('sharePublic').checked;
  const st = $('shareStatus');
  const say = (t, kind = '') => { st.textContent = t; st.className = 'status' + (kind ? ' ' + kind : ''); };
  if (!title) return say('제목을 적어 주세요.', 'err');
  if (!nickname) return say('닉네임을 적어 주세요. (실명 대신 별명을 권해요)', 'err');
  if (!user) return say('로그인이 풀렸어요. 다시 로그인해 주세요.', 'err');

  $('shareSubmit').disabled = true;
  say('올리는 중…');
  try { localStorage.setItem(LS_NICK, nickname); } catch { /* 무시 */ }

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) { $('shareSubmit').disabled = false; return say('그림을 만들지 못했어요.', 'err'); }
  const path = `${user.id}/${crypto.randomUUID()}.jpg`;

  const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (up.error) { $('shareSubmit').disabled = false; return say(errText(up.error), 'err'); }

  const ins = await sb.from('comics').insert({ title, nickname, image_path: path, is_public: isPublic });
  if (ins.error) {
    await sb.storage.from(BUCKET).remove([path]); // 짝 잃은 그림 정리
    $('shareSubmit').disabled = false;
    return say(errText(ins.error), 'err');
  }
  say(isPublic ? '올렸어요! “모두의 네컷”에서 볼 수 있어요.' : '나만 보기로 올렸어요. “내 작품”에서 볼 수 있어요.', 'ok');
  setTimeout(() => { $('shareDialog').close(); }, 1200);
}

// ---------- 모두의 네컷 ----------
async function renderBoard() {
  const grid = $('boardGrid');
  const note = $('boardNote');
  if (!grid) return;
  document.querySelectorAll('[data-sort]').forEach((b) => {
    b.classList.toggle('active', b.dataset.sort === sort);
    if (b.dataset.sort === 'mine') b.classList.toggle('hidden', !user);
  });
  if (!enabled) {
    note.textContent = '공유 서버가 아직 설정되지 않았어요. (관리자: supabase/SETUP.md 참고)';
    grid.replaceChildren();
    return;
  }
  if (!sb) { note.textContent = '서버를 준비하는 중…'; return; }
  note.textContent = '불러오는 중…';

  let q = sb.from('comics')
    .select('id,user_id,title,nickname,image_path,is_public,is_hidden,like_count,report_count,created_at')
    .limit(PAGE);
  if (sort === 'mine' && user) q = q.eq('user_id', user.id).order('created_at', { ascending: false });
  else {
    if (!admin) q = q.eq('is_public', true).eq('is_hidden', false);
    else q = q.eq('is_public', true); // 관리자는 숨김 작품도 보고 풀어 줄 수 있음
    q = sort === 'popular'
      ? q.order('like_count', { ascending: false }).order('created_at', { ascending: false })
      : q.order('created_at', { ascending: false });
  }
  const { data: rows, error } = await q;
  if (error) { note.textContent = errText(error); grid.replaceChildren(); return; }

  const urls = {};
  if (rows.length) {
    const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(rows.map((r) => r.image_path), 3600);
    (signed || []).forEach((s) => { if (s.signedUrl) urls[s.path] = s.signedUrl; });
  }
  const liked = new Set();
  const reported = new Set();
  if (user && rows.length) {
    const ids = rows.map((r) => r.id);
    const [l, r] = await Promise.all([
      sb.from('likes').select('comic_id').in('comic_id', ids),
      sb.from('reports').select('comic_id').in('comic_id', ids),
    ]);
    (l.data || []).forEach((x) => liked.add(x.comic_id));
    (r.data || []).forEach((x) => reported.add(x.comic_id));
  }

  note.textContent = rows.length ? ''
    : sort === 'mine' ? '아직 올린 네컷이 없어요. 완성 화면에서 “🌏 공유하기”를 눌러 보세요.'
      : '아직 올라온 네컷이 없어요. 첫 번째 주인공이 되어 보세요!';
  grid.replaceChildren(...rows.map((c, i) => card(c, i, urls[c.image_path], liked.has(c.id), reported.has(c.id))));
}

function card(c, i, url, isLiked, isReported) {
  const mine = user && c.user_id === user.id;
  const medal = sort === 'popular' && c.like_count > 0 && i < 3 ? ['🥇', '🥈', '🥉'][i] : '';

  const img = h('img', { alt: c.title, loading: 'lazy' });
  if (url) img.src = url;
  const pic = h('button', { class: 'board-pic', title: '크게 보기', onclick: () => openBig(url, c.title) }, img,
    medal && h('span', { class: 'medal', text: medal }),
    c.is_hidden && h('span', { class: 'badge warn', text: `숨김 · 신고 ${c.report_count}` }),
    !c.is_public && h('span', { class: 'badge', text: '🔒 나만 보기' }));

  const like = h('button', {
    class: 'like' + (isLiked ? ' on' : ''), 'aria-pressed': String(isLiked),
    title: isLiked ? '하트 취소' : '하트 주기',
    text: `${isLiked ? '❤️' : '🤍'} ${c.like_count}`,
    onclick: () => toggleLike(c, isLiked, like),
  });

  const tools = h('div', { class: 'board-tools' }, like);
  if (!mine) {
    tools.append(h('button', {
      class: 'ghost small', disabled: isReported, title: '부적절한 작품 신고',
      text: isReported ? '신고함' : '🚩', onclick: () => report(c),
    }));
  }
  if (mine) {
    tools.append(h('button', {
      class: 'ghost small', title: '공개 여부 바꾸기',
      text: c.is_public ? '🔒 나만 보기로' : '🌏 공개로',
      onclick: () => rpc('set_comic_public', { p_id: c.id, p_public: !c.is_public }),
    }));
  }
  if (admin && !mine) {
    tools.append(h('button', {
      class: 'ghost small', text: c.is_hidden ? '숨김 풀기' : '숨기기',
      onclick: () => rpc('admin_set_hidden', { p_id: c.id, p_hidden: !c.is_hidden }),
    }));
  }
  if (mine || admin) {
    tools.append(h('button', { class: 'ghost small danger', title: '삭제', text: '🗑', onclick: () => remove(c, mine) }));
  }

  return h('article', { class: 'board-item' + (c.is_hidden ? ' is-hidden' : '') }, pic,
    h('div', { class: 'board-meta' },
      h('b', { text: c.title }),
      h('span', { text: `${c.nickname} · ${fmt(c.created_at)}` })),
    tools);
}

async function toggleLike(c, isLiked, btn) {
  if (!requireLogin()) return;
  btn.disabled = true;
  const res = isLiked
    ? await sb.from('likes').delete().eq('comic_id', c.id).eq('user_id', user.id)
    : await sb.from('likes').insert({ comic_id: c.id });
  if (res.error && !/duplicate/i.test(res.error.message)) alert(errText(res.error));
  renderBoard();
}

async function report(c) {
  if (!requireLogin()) return;
  const reason = prompt(`“${c.title}”을(를) 신고할까요?\n이유를 짧게 적어 주세요. (신고가 3번 쌓이면 자동으로 숨겨져요)`, '');
  if (reason === null) return;
  const { error } = await sb.from('reports').insert({ comic_id: c.id, reason: reason.trim().slice(0, 100) || null });
  if (error) alert(errText(error)); else alert('신고했어요. 고마워요.');
  renderBoard();
}

async function remove(c, mine) {
  const who = mine ? '내 작품' : '(관리자) 이 작품';
  if (!confirm(`${who} “${c.title}”을(를) 지울까요? 되돌릴 수 없어요.`)) return;
  const st = await sb.storage.from(BUCKET).remove([c.image_path]);
  if (st.error) console.warn(st.error);
  const { error } = await sb.from('comics').delete().eq('id', c.id);
  if (error) alert(errText(error));
  renderBoard();
}

async function rpc(name, args) {
  const { error } = await sb.rpc(name, args);
  if (error) alert(errText(error));
  renderBoard();
}

function openBig(url, title) {
  if (!url) return;
  const d = $('boardViewer');
  $('boardViewerImg').src = url;
  $('boardViewerImg').alt = title;
  d.showModal();
}

// ---------- 연결 ----------
function setSort(s) { sort = s; renderBoard(); }

document.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => setSort(b.dataset.sort)));
$('shareCancel')?.addEventListener('click', (e) => { e.preventDefault(); $('shareDialog').close(); });
$('boardViewerClose')?.addEventListener('click', () => $('boardViewer').close());
$('boardViewer')?.addEventListener('click', (e) => { if (e.target.id === 'boardViewer') e.target.close(); });

export const community = {
  enabled,
  init,
  requireLogin,
  takeDraft,
  openShare,
  renderBoard,
  onAuth: (fn) => listeners.push(fn),
  get user() { return user; },
};
