/* 주인공 검사 — YOLO(yolov8n, 브라우저 안에서 실행)로 컷마다 사람을 찾고,
 * 사람 부분의 색 분포(머리·옷 색)를 컷끼리 비교해서 "다른 사람 같은 컷"을 알려 준다.
 *
 * - 모델: models/yolov8n.onnx (Ultralytics YOLOv8n, COCO 80종, 입력 640×640, 용량을 줄이려고 가중치만 fp16으로 저장)
 * - 실행: onnxruntime-web (CDN, 처음 검사할 때만 불러옴 → 앱 첫 화면은 느려지지 않음)
 * - 일기 내용이나 그림은 밖으로 나가지 않음 (모두 이 브라우저 안에서 계산)
 * - 색 비교는 "참고용" 신호다. 얼굴까지 알아보지는 못한다.
 */

const ORT_VER = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
const MODEL_URL = new URL('./models/yolov8n.onnx', import.meta.url).href;
const SIZE = 640;
const PERSON = 0;          // COCO 0번 = person
const MIN_SCORE = 0.30;    // 사람으로 볼 최소 확신도
const SAME_MIN = 0.70;     // 색 분포가 이 값보다 낮으면 "다른 사람 같음" (실제 그림으로 맞춰 볼 값)

let sessionPromise = null;

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import(`${ORT_BASE}ort.min.mjs`);
      ort.env.wasm.wasmPaths = ORT_BASE;
      const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
      return { ort, session };
    })();
    sessionPromise.catch(() => { sessionPromise = null; }); // 실패하면 다음에 다시 시도
  }
  return sessionPromise;
}

/** 이미지를 640×640에 비율 유지로 넣는다(남는 곳은 회색). */
function letterbox(img) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = 'rgb(114,114,114)';
  g.fillRect(0, 0, SIZE, SIZE);
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const r = Math.min(SIZE / w, SIZE / h);
  const nw = Math.round(w * r), nh = Math.round(h * r);
  const dx = Math.floor((SIZE - nw) / 2), dy = Math.floor((SIZE - nh) / 2);
  g.drawImage(img, dx, dy, nw, nh);
  return { canvas: c, ctx: g, r, dx, dy };
}

function toTensor(ort, ctx) {
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  const n = SIZE * SIZE;
  const f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    f[i] = data[i * 4] / 255;
    f[n + i] = data[i * 4 + 1] / 255;
    f[2 * n + i] = data[i * 4 + 2] / 255;
  }
  return new ort.Tensor('float32', f, [1, 3, SIZE, SIZE]);
}

/** YOLOv8 출력 [1, 84, 8400]에서 사람 상자만 골라 가장 큰 것(=주인공 후보)을 돌려준다. */
function pickPerson(out) {
  const d = out.data;
  const N = out.dims[2];
  const boxes = [];
  for (let i = 0; i < N; i++) {
    const s = d[(4 + PERSON) * N + i];
    if (s < MIN_SCORE) continue;
    const cx = d[i], cy = d[N + i], w = d[2 * N + i], h = d[3 * N + i];
    boxes.push({ x: cx - w / 2, y: cy - h / 2, w, h, s });
  }
  if (!boxes.length) return { count: 0, box: null, all: [] };
  // 겹치는 상자 정리(NMS)
  boxes.sort((a, b) => b.s - a.s);
  const keep = [];
  for (const b of boxes) {
    if (keep.every((k) => iou(k, b) < 0.45)) keep.push(b);
  }
  // 크기 × 확신도가 가장 큰 사람 = 주인공으로 본다
  const main = keep.reduce((a, b) => (b.w * b.h * b.s > a.w * a.h * a.s ? b : a));
  return { count: keep.length, box: main, all: keep };
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/** 사람 상자 위쪽 65%(머리·윗옷)의 색 분포 — HSV 색상 12칸 + 어두움/밝음/회색 3칸. */
function colorSignature(ctx, box) {
  const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
  const w = Math.min(SIZE - x, Math.ceil(box.w)), h = Math.min(SIZE - y, Math.ceil(box.h * 0.65));
  if (w < 4 || h < 4) return null;
  const { data } = ctx.getImageData(x, y, w, h);
  const hist = new Float32Array(15);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), v = max, s = max ? (max - min) / max : 0;
    if (v < 0.2) { hist[12]++; continue; }          // 아주 어두움(검은 머리 등)
    if (s < 0.15) { hist[v > 0.8 ? 13 : 14]++; continue; } // 흰색 / 회색
    let hue;
    if (max === r) hue = ((g - b) / (max - min)) % 6;
    else if (max === g) hue = (b - r) / (max - min) + 2;
    else hue = (r - g) / (max - min) + 4;
    hue = (hue * 60 + 360) % 360;
    hist[Math.floor(hue / 30) % 12]++;
  }
  const sum = hist.reduce((a, c) => a + c, 0) || 1;
  return hist.map((c) => c / sum);
}

/** 두 색 분포가 얼마나 겹치는지 (0~1, 1이면 똑같음) */
const overlap = (a, b) => a.reduce((acc, v, i) => acc + Math.min(v, b[i]), 0);

/**
 * 4컷 이미지를 검사한다.
 * @param {HTMLImageElement[]} images
 * @param {(msg:string)=>void} [onProgress]
 * @returns {Promise<{ok:boolean, panels:{found:boolean, people:number, score:number, same:number|null, verdict:'ok'|'none'|'diff', boxes:{x:number,y:number,w:number,h:number}[]}[], summary:string}>}
 *   boxes: 사람 상자(원본 그림 기준 0~1), 첫 번째가 주인공
 */
export async function checkHero(images, onProgress) {
  onProgress?.('주인공 검사 모델 불러오는 중… (처음 한 번만, 약 6MB)');
  const { ort, session } = await getSession();
  const panels = [];
  const sigs = [];
  for (let i = 0; i < images.length; i++) {
    onProgress?.(`${i + 1}번 컷에서 주인공 찾는 중…`);
    const lb = letterbox(images[i]);
    const res = await session.run({ [session.inputNames[0]]: toTensor(ort, lb.ctx) });
    const { count, box, all } = pickPerson(res[session.outputNames[0]]);
    sigs.push(box ? colorSignature(lb.ctx, box) : null);
    // 말풍선 자리 잡기용: 사람 상자를 원본 그림 기준 0~1 비율로 바꿔 둔다 (주인공이 맨 앞)
    const nw = (images[i].naturalWidth || images[i].width) * lb.r, nh = (images[i].naturalHeight || images[i].height) * lb.r;
    const norm = (b) => ({ x: (b.x - lb.dx) / nw, y: (b.y - lb.dy) / nh, w: b.w / nw, h: b.h / nh });
    const boxes = box ? [box, ...all.filter((b) => b !== box)].map(norm) : [];
    panels.push({ found: !!box, people: count, score: box ? box.s : 0, same: null, verdict: box ? 'ok' : 'none', boxes });
  }

  // 각 컷의 색 분포를 나머지 컷들과 비교 → 가장 비슷한 두 컷과의 평균
  sigs.forEach((s, i) => {
    if (!s) return;
    const others = sigs.filter((o, j) => j !== i && o).map((o) => overlap(s, o)).sort((a, b) => b - a);
    if (!others.length) return;
    const top = others.slice(0, 2);
    panels[i].same = top.reduce((a, c) => a + c, 0) / top.length;
    if (panels[i].same < SAME_MIN) panels[i].verdict = 'diff';
  });

  const none = panels.filter((p) => p.verdict === 'none').length;
  const diff = panels.filter((p) => p.verdict === 'diff').length;
  const ok = !none && !diff;
  const summary = ok
    ? '주인공 검사 통과: 4컷 모두 사람이 보이고, 머리·옷 색도 비슷해요.'
    : [
      none ? `${none}컷에서 주인공을 못 찾았어요` : '',
      diff ? `${diff}컷은 다른 사람 같아요(머리·옷 색이 달라요)` : '',
    ].filter(Boolean).join(', ') + '. ⚠️ 표시된 컷을 다시 그려 보세요.';
  return { ok, panels, summary };
}
