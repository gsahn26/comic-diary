/* 사이트 안에서 뜨는 창 — 브라우저 기본 alert / confirm / prompt 대신 쓴다.
 *  - toast(글, 종류)          : 잠깐 떴다 사라지는 알림 (확인 버튼 필요 없음)
 *  - ask({...})              : 확인/취소 창 → true / false
 *  - askText({...})          : 글 입력 창 → 적은 글 / null(취소)
 *  - openSheet({...})        : 내용과 버튼을 마음대로 넣는 창 (로그인 안내 등)
 * 사용자 글은 전부 textContent로 넣는다(XSS 방지).
 */

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

// ---------- 토스트 ----------
let toastBox = null;
export function toast(text, kind = '') {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('div', { class: 'toast' + (kind ? ' ' + kind : ''), text });
  toastBox.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 4500 : 2800);
}

// ---------- 공통 창 ----------
/**
 * @param {object} o
 * @param {string} [o.icon]  큰 그림 글자 (예: '🔐')
 * @param {string} o.title
 * @param {string} [o.message]
 * @param {HTMLElement} [o.body]  추가로 넣을 내용
 * @param {{label:string, value:any, kind?:string, onclick?:Function}[]} o.buttons
 * @param {any} [o.cancelValue]  바깥/ESC로 닫을 때 돌려줄 값
 * @returns {Promise<any>}
 */
export function openSheet({ icon, title, message, body, buttons = [], cancelValue = null }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'sheet', 'aria-labelledby': 'sheetTitle' });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    const btns = buttons.map((b) => h('button', {
      class: b.kind || 'ghost', type: 'button', text: b.label,
      onclick: () => (b.onclick ? b.onclick(finish) : finish(typeof b.value === 'function' ? b.value() : b.value)),
    }));
    dlg.append(h('div', { class: 'sheet-body' },
      icon && h('div', { class: 'sheet-icon', 'aria-hidden': 'true', text: icon }),
      h('h2', { id: 'sheetTitle', text: title }),
      message && h('p', { class: 'sheet-msg', text: message }),
      body,
      h('div', { class: 'sheet-actions' }, ...btns)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(cancelValue); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(cancelValue); });
    document.body.append(dlg);
    dlg.showModal();
    (body?.querySelector('input,textarea') || btns[0])?.focus();
  });
}

export function ask({ icon, title, message, ok = '확인', cancel = '취소', danger = false }) {
  return openSheet({
    icon, title, message, cancelValue: false,
    buttons: [
      { label: ok, value: true, kind: danger ? 'primary danger-fill' : 'primary' },
      { label: cancel, value: false },
    ],
  });
}

export function askText({ icon, title, message, placeholder = '', maxlength = 100, ok = '확인', cancel = '취소' }) {
  const input = h('input', { type: 'text', placeholder, maxlength: String(maxlength), class: 'sheet-input' });
  const p = openSheet({
    icon, title, message, body: input, cancelValue: null,
    buttons: [
      { label: ok, value: () => input.value.trim(), kind: 'primary' },
      { label: cancel, value: null },
    ],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); input.closest('dialog').querySelector('.primary').click(); }
  });
  return p;
}
