/* 네컷일기 공통 로직 — 앱(app.js)과 PoC 측정 스크립트(poc/measure.mjs)가 같은 코드를 쓴다.
 * 브라우저 전용 API(DOM, localStorage)는 쓰지 않는다. */

export const TEXT_API = 'https://text.pollinations.ai/';
export const IMAGE_API = 'https://image.pollinations.ai/prompt/';
export const IMG_SIZE = 768;
export const GAP_MS = 46_000; // 무료 제한: 텍스트·이미지 각각 IP당 45초에 1회

// 무료 이미지 모델은 프롬프트 앞부분(약 77토큰)만 읽는다 → 짧게, 중요한 것(장면)부터.
export const STYLE_PREFIX = 'webtoon comic panel';
export const STYLE_SUFFIX = 'korean webtoon style, cute cartoon, clean line art, flat pastel colors';

export const hasHangul = (s) => /[ㄱ-힝]/.test(s || '');
export const clipWords = (s, n) =>
  (s || '').split(/\s+/).filter(Boolean).slice(0, n).join(' ').replace(/[.,;]+$/, '');

/** AI 응답에서 JSON 객체를 최대한 꺼낸다. */
export function parseLooseJSON(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const tryParse = (str) => { try { return JSON.parse(str); } catch { return undefined; } };
  let obj = tryParse(s);
  if (obj === undefined) {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b > a) {
      const cut = s.slice(a, b + 1);
      obj = tryParse(cut) ?? tryParse(
        cut.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1')
      );
    }
  }
  // OpenAI 형식으로 감싸져 온 경우
  if (obj && obj.choices?.[0]?.message?.content) return parseLooseJSON(obj.choices[0].message.content);
  return obj ?? null;
}

/** 4컷 형식으로 정리한다. 4컷이 안 되거나 장면이 비면 null. */
export function normalizeComic(obj) {
  if (!obj) return null;
  const panels = Array.isArray(obj) ? obj : obj.panels || obj.cuts || obj.scenes;
  if (!Array.isArray(panels) || panels.length < 4) return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const out = panels.slice(0, 4).map((p) => ({
    scene: str(p.scene || p.prompt || p.image_prompt || p.description),
    caption: str(p.caption || p.narration),
    dialogue: str(p.dialogue || p.speech || p.line),
  }));
  if (out.some((p) => !p.scene)) return null;
  return { title: str(obj.title) || '오늘의 일기', character: str(obj.character), panels: out };
}

export const SPLIT_SYSTEM = `You turn a Korean diary entry into a 4-panel webtoon (기승전결: setup, development, twist, ending).
Respond with ONLY a JSON object, no markdown, in exactly this shape:
{"title":"짧은 한국어 제목 (15자 이내)",
 "character":"English visual description of the main character: age, gender, hair, outfit, distinctive features. Under 15 words, e.g. 'young woman with short bob hair, round glasses, yellow hoodie'.",
 "panels":[{"scene":"English image prompt for this panel: what the main character is doing, facial expression, setting, other characters, camera framing. Do not mention text or speech bubbles. Under 20 words.",
            "caption":"한국어 내레이션 (25자 이내)",
            "dialogue":"주인공의 짧은 한국어 대사 (20자 이내, 없으면 빈 문자열)"}]}
The panels array must have exactly 4 items in story order. Keep it funny and warm.
LANGUAGE RULE: "character" and "scene" are ENGLISH ONLY (they go to an English image model). "title", "caption", "dialogue" are KOREAN.
Example scene: "young woman running toward a bus stop in the morning, panicked face, bus leaving in the background, full body shot".`;

export function splitUserMessage(diary, hero) {
  return `Diary (Korean):\n${diary}` +
    (hero ? `\n\nMain character appearance (Korean, translate it to English for "character"): ${hero}` : '') +
    '\n\nRemember: "character" and every "scene" must be written in ENGLISH. Only title, caption and dialogue are Korean.';
}

export const TRANSLATE_SYSTEM = 'You are a translator for an image generator. Translate every item of the "items" array into a short ENGLISH image prompt (no Korean characters at all). Keep items that are already English unchanged. Respond with ONLY JSON: {"items":["...", ...]} with the same number of items in the same order.';

/** 번역 응답에서 n개의 영어 문장을 꺼낸다. 개수가 다르거나 한국어가 남으면 null. */
export function parseTranslation(raw, n) {
  const obj = parseLooseJSON(raw);
  const items = Array.isArray(obj?.items) ? obj.items.map(String) : null;
  return items && items.length === n && !items.some(hasHangul) ? items : null;
}

export function buildImagePrompt(scene, character) {
  return [`${STYLE_PREFIX}: ${clipWords(scene, 28)}`, clipWords(character, 16), STYLE_SUFFIX]
    .filter(Boolean).join(', ');
}

export function imageUrlFor(scene, character, seed) {
  return `${IMAGE_API}${encodeURIComponent(buildImagePrompt(scene, character))}?width=${IMG_SIZE}&height=${IMG_SIZE}&seed=${seed}`;
}
