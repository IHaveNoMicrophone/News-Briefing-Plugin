'use strict';

const DEFAULT_SETTINGS = {
  sources: [
    { id: 'xinhuanet', name: '新华网', url: 'http://www.xinhuanet.com' },
    { id: 'people', name: '人民网', url: 'http://www.people.com.cn' },
    { id: 'cctv', name: '央视新闻', url: 'https://news.cctv.com' },
    { id: 'gov', name: '中国政府网', url: 'https://www.gov.cn' },
    { id: 'gmw', name: '光明网', url: 'https://www.gmw.cn' },
    { id: 'thepaper', name: '澎湃新闻', url: 'https://www.thepaper.cn' },
    { id: 'huanqiu', name: '环球网', url: 'https://www.huanqiu.com' }
  ],
  summaryCount: 10,
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  floatPosition: { top: 45 },
  dateRange: { preset: 'all', start: '', end: '' }
};

let settings = null;
let countdownTimer = null;
let countdownRemaining = 0;
let forceRefresh = false;

const HEAT_API = 'https://top.baidu.com/api/board?platform=pc&tab=realtime';
const HEAT_TIMEOUT = 8000;
const CACHE_KEY = 'newsCache';
const CACHE_TTL = 10 * 60 * 1000;
const HEAT_MATCH_THRESHOLD = 0.45;
const DATE_PRESETS = {
  all: { label: '全部时间' },
  today: { label: '今天', days: 0 },
  week: { label: '近7天', days: 7 },
  month: { label: '近30天', days: 30 },
  year: { label: '近一年', days: 365 },
  custom: { label: '自定义' }
};

const $ = (id) => document.getElementById(id);

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch (_) { /* ignore */ }
  return '';
}

function originPattern(value) {
  try {
    return new URL(value).origin + '/*';
  } catch (_) {
    return '';
  }
}

/* ---------- Settings persistence ---------- */

async function loadSettings() {
  const res = await chrome.storage.local.get('settings');
  const stored = res.settings || {};
  settings = Object.assign({}, DEFAULT_SETTINGS, stored);
  settings.summaryCount = clampInt(settings.summaryCount, 1, 30, 10);
  settings.sources = Array.isArray(settings.sources) && settings.sources.length
    ? settings.sources
    : DEFAULT_SETTINGS.sources.slice();
  settings.floatPosition =
    settings.floatPosition && typeof settings.floatPosition.top === 'number'
      ? settings.floatPosition
      : { top: 45 };
  settings.dateRange = Object.assign(
    { preset: 'all', start: '', end: '' },
    settings.dateRange || {}
  );
  if (!DATE_PRESETS[settings.dateRange.preset]) {
    settings.dateRange = { preset: 'all', start: '', end: '' };
  }
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
}

/* ---------- Source buttons ---------- */

const BRAND_COLORS = {
  '人民网': '#E60012'
};
const NEUTRAL_DARK_BG = '#2f343b';

function analyzeLogo(name) {
  return new Promise((resolve) => {
    const url = 'icons/' + encodeURIComponent(name) + '.png';
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) {
          resolve({ exists: true, needsDarkBg: false });
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;

        const step = Math.max(1, Math.floor(Math.min(w, h) / 100));
        let total = 0;
        let opaque = 0;
        let lumSum = 0;
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            total++;
            const i = (y * w + x) * 4;
            if (data[i + 3] >= 10) {
              opaque++;
              lumSum +=
                0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            }
          }
        }

        const avgLum = opaque > 0 ? lumSum / opaque : 0;
        const opaqueRatio = total > 0 ? opaque / total : 0;
        const needsDarkBg = opaque > 0 && avgLum > 200 && opaqueRatio < 0.95;
        resolve({ exists: true, needsDarkBg });
      } catch (_) {
        resolve({ exists: true, needsDarkBg: false });
      }
    };
    img.onerror = () => resolve({ exists: false, needsDarkBg: false });
    img.src = url;
  });
}

async function renderSources() {
  const box = $('sourceButtons');
  box.textContent = '';
  const items = await Promise.all(
    settings.sources.map(async (src) => ({
      src,
      logo: await analyzeLogo(src.name)
    }))
  );
  items.forEach(({ src, logo }) => {
    const card = document.createElement('button');
    card.className = 'source-card' + (logo.exists ? '' : ' fallback');
    card.type = 'button';
    card.title = src.url;
    if (logo.exists) {
      card.style.backgroundImage =
        "url('icons/" + encodeURIComponent(src.name) + ".png')";
      if (logo.needsDarkBg) {
        card.style.backgroundColor = BRAND_COLORS[src.name] || NEUTRAL_DARK_BG;
      }
    }

    const glass = document.createElement('span');
    glass.className = 'glass';
    const name = document.createElement('span');
    name.textContent = src.name;
    const arrow = document.createElement('span');
    arrow.className = 'glass-arrow';
    arrow.textContent = '↗';
    glass.appendChild(name);
    glass.appendChild(arrow);
    card.appendChild(glass);

    card.addEventListener('click', () => {
      window.open(src.url, '_blank', 'noopener');
    });
    box.appendChild(card);
  });
}

/* ---------- Fetching & link extraction ---------- */

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function registrableDomain(hostname) {
  const parts = String(hostname).toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn'].includes(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

function toTimestamp(y, m, d) {
  const t = new Date(y, m - 1, d);
  if (
    t.getFullYear() !== y ||
    t.getMonth() !== m - 1 ||
    t.getDate() !== d
  ) {
    return null;
  }
  return t.getTime();
}

function parseDateFromUrl(url) {
  const p = String(url || '').split('#')[0];
  let m = p.match(/(20\d{2})\/(\d{2})(\d{2})\//);
  if (m) {
    const t = toTimestamp(+m[1], +m[2], +m[3]);
    if (t) return t;
  }
  m = p.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const t = toTimestamp(+m[1], +m[2], +m[3]);
    if (t) return t;
  }
  m = p.match(/(20\d{2})(\d{2})(\d{2})/);
  if (m) {
    const t = toTimestamp(+m[1], +m[2], +m[3]);
    if (t) return t;
  }
  return null;
}

function parseRelativeDate(text, now) {
  let m = text.match(/(\d+)\s*分钟前/);
  if (m) return now - (+m[1]) * 60000;
  m = text.match(/(\d+)\s*小时前/);
  if (m) return now - (+m[1]) * 3600000;
  m = text.match(/(\d+)\s*天前/);
  if (m) return now - (+m[1]) * 86400000;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (/今天/.test(text)) return today.getTime();
  if (/昨天/.test(text)) return today.getTime() - 86400000;
  if (/前天/.test(text)) return today.getTime() - 2 * 86400000;
  return null;
}

function parseDateFromAnchor(a, now) {
  const own = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ');
  let m = own.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) {
    const t = toTimestamp(+m[1], +m[2], +m[3]);
    if (t) return t;
  }
  let containerText = '';
  try {
    const box = a.closest('li, article, .item, .news-item, [class*="item"], [class*="news"]');
    if (box) containerText = (box.textContent || '').replace(/\s+/g, ' ').trim();
  } catch (_) {
    /* ignore selector errors */
  }
  const combined = (containerText ? containerText.slice(0, 300) + ' ' : '') + own;
  m = combined.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) {
    const t = toTimestamp(+m[1], +m[2], +m[3]);
    if (t) return t;
  }
  return parseRelativeDate(combined, now);
}

function extractLinks(html, sourceUrl, max) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base = new URL(sourceUrl);
  const baseReg = registrableDomain(base.hostname);
  const now = Date.now();
  const badSegments = new Set([
    'login', 'register', 'account', 'about', 'contact', 'privacy',
    'help', 'sitemap', 'rss', 'search', 'feedback', 'download',
    'client', 'app', 'advert', 'advertisement', 'jobs', 'legal'
  ]);
  const seen = new Set();
  const candidates = [];

  const anchors = doc.querySelectorAll('a[href]');
  anchors.forEach((a) => {
    const raw = a.getAttribute('href');
    if (!raw || !raw.trim()) return;
    let abs;
    try {
      abs = new URL(raw, base.href);
    } catch (_) {
      return;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    if (registrableDomain(abs.hostname) !== baseReg) return;

    const path = abs.pathname.toLowerCase();
    if (path.split('/').some((seg) => seg && badSegments.has(seg))) return;
    if (abs.hash && abs.pathname.replace(/^\//, '') === '') return;

    let title = (a.getAttribute('title') || '').trim();
    if (!title) {
      const img = a.querySelector('img');
      title = (img && (img.getAttribute('alt') || '').trim()) || '';
    }
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    const heading = a.closest('h1, h2, h3, h4, h5');
    const headingText = heading
      ? (heading.textContent || '').replace(/\s+/g, ' ').trim()
      : '';
    const finalTitle = title || text || headingText;
    if (!finalTitle || finalTitle.length < 6) return;

    const key = abs.href.split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);

    let score = 0;
    if (heading) score += 20;
    if (title) score += 10;
    score += Math.min(finalTitle.length, 40) * 0.3;
    if (/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(path)) score += 25;
    if (/\d{8}/.test(path)) score += 25;
    if (/\.html?$/i.test(path)) score += 5;
    if (/^(c-\d+|\d+\.html?|article|detail|content|news)/i.test(path)) score += 8;

    const date =
      parseDateFromUrl(abs.href) || parseDateFromAnchor(a, now);

    candidates.push({ url: key, title: finalTitle, score, date });
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates
    .slice(0, max)
    .map(({ url, title, score, date }) => ({ url, title, score, date }));
}

async function fetchSourceWithCache(src, cache, force) {
  const entry = cache && cache.html && cache.html[src.url];
  const now = Date.now();
  if (!force && entry && now - entry.ts < CACHE_TTL) {
    const links = extractLinks(entry.html, src.url, 30);
    return {
      name: src.name,
      url: src.url,
      state: 'ok',
      cached: true,
      html: null,
      links
    };
  }
  try {
    const html = await fetchWithTimeout(src.url, 12000);
    return {
      name: src.name,
      url: src.url,
      state: 'ok',
      cached: false,
      html,
      links: extractLinks(html, src.url, 30)
    };
  } catch (err) {
    return {
      name: src.name,
      url: src.url,
      state: err && err.name === 'AbortError' ? 'timeout' : 'error',
      cached: false,
      html: null,
      links: []
    };
  }
}

async function fetchAllSources(cache, force) {
  const results = await Promise.all(
    settings.sources.map((src) => fetchSourceWithCache(src, cache, force))
  );

  const candidates = [];
  const seenUrls = new Set();
  const freshHtml = {};
  for (const r of results) {
    if (r.state === 'ok' && !r.cached && r.html) {
      freshHtml[r.url] = r.html;
    }
    if (r.state !== 'ok') continue;
    for (const link of r.links) {
      if (seenUrls.has(link.url)) continue;
      seenUrls.add(link.url);
      candidates.push({
        url: link.url,
        title: link.title,
        source: r.name,
        score: link.score,
        date: link.date || null
      });
    }
  }

  const statuses = results.map((r) => ({
    name: r.name,
    state: r.state,
    count: r.links.length,
    cached: r.cached
  }));
  return { candidates, statuses, freshHtml };
}

/* ---------- Heat ranking (Baidu realtime hot list) ---------- */

function collectHeatItems(data) {
  const items = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.word === 'string' && typeof node.hotScore === 'number') {
      items.push({
        word: node.word,
        hotScore: node.hotScore,
        url: node.url || ''
      });
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) {
        v.forEach(visit);
      } else {
        visit(v);
      }
    }
  };
  visit(data && data.data ? data.data : data);
  items.sort((a, b) => b.hotScore - a.hotScore);
  return items.slice(0, 50);
}

async function fetchHeatWithCache(cache, force) {
  const entry = cache && cache.heat;
  const now = Date.now();
  if (!force && entry && now - entry.ts < CACHE_TTL) {
    return { state: 'ok', cached: true, items: entry.items, raw: null };
  }
  try {
    const text = await fetchWithTimeout(HEAT_API, HEAT_TIMEOUT);
    const items = collectHeatItems(JSON.parse(text));
    return { state: 'ok', cached: false, items, raw: { ts: now, items } };
  } catch (err) {
    return {
      state: err && err.name === 'AbortError' ? 'timeout' : 'error',
      cached: false,
      items: [],
      raw: null
    };
  }
}

async function readCache() {
  try {
    const res = await chrome.storage.session.get(CACHE_KEY);
    return res[CACHE_KEY] || null;
  } catch (_) {
    return null;
  }
}

async function writeCache(cache) {
  try {
    await chrome.storage.session.set({ [CACHE_KEY]: cache });
  } catch (_) {
    try {
      await chrome.storage.session.remove(CACHE_KEY);
      await chrome.storage.session.set({ [CACHE_KEY]: cache });
    } catch (_) {
      /* quota still exceeded: skip caching this round */
    }
  }
}

function normalizeTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u3000\uFF01-\uFF5E]/g, (ch) => {
      const code = ch.charCodeAt(0);
      return code === 0x3000 ? ' ' : String.fromCharCode(code - 0xfee0);
    })
    .replace(/[\s#@【】\[\]（）()、，。！？!?·—…：:；;'"“”‘’\-_/+|\\/]+/g, '');
}

function bigramSet(str) {
  const set = new Set();
  for (let i = 0; i < str.length - 1; i++) {
    set.add(str.slice(i, i + 2));
  }
  return set;
}

function bigramJaccard(a, b) {
  const sa = bigramSet(a);
  const sb = bigramSet(b);
  const union = sa.size + sb.size;
  if (!union) return 0;
  let inter = 0;
  for (const g of sa) {
    if (sb.has(g)) inter++;
  }
  return inter / (union - inter);
}

function matchHeat(title, heatItems) {
  const t = normalizeTitle(title);
  if (!t) return null;
  let best = null;
  for (const h of heatItems) {
    const w = normalizeTitle(h.word);
    if (!w) continue;
    let sim = bigramJaccard(t, w);
    const short = t.length <= w.length ? t : w;
    const long = t.length <= w.length ? w : t;
    if (short.length >= 6 && long.includes(short)) {
      sim = Math.max(sim, 0.8);
    }
    if (!best || sim > best.sim) {
      best = { word: h.word, hotScore: h.hotScore, sim };
    }
  }
  if (!best || best.sim < HEAT_MATCH_THRESHOLD) return null;
  return best;
}

function rankCandidates(candidates, heatItems) {
  const matched = [];
  const unmatched = [];
  for (const c of candidates) {
    const m = heatItems.length ? matchHeat(c.title, heatItems) : null;
    if (m) {
      matched.push(Object.assign({}, c, { hotWord: m.word, hotScore: m.hotScore }));
    } else {
      unmatched.push(c);
    }
  }
  matched.sort((a, b) => b.hotScore - a.hotScore);
  unmatched.sort((a, b) => b.score - a.score);
  return matched.concat(unmatched);
}

function formatHot(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(Math.round(n));
}

/* ---------- Date range filtering ---------- */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toISODate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function parseISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const [y, m, d] = String(s).split('-').map(Number);
  const t = new Date(y, m - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== m - 1 || t.getDate() !== d) {
    return null;
  }
  return t;
}

function computePresetRange(preset) {
  if (preset === 'all') return { startISO: '', endISO: '' };
  const p = DATE_PRESETS[preset];
  if (!p) return { startISO: '', endISO: '' };
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(end.getDate() - (p.days || 0));
  return { startISO: toISODate(start), endISO: toISODate(end) };
}

function dateRangeLabel(range) {
  if (!range || !DATE_PRESETS[range.preset] || range.preset === 'all') {
    return '';
  }
  if (range.preset === 'custom') {
    return (range.start || '') + ' 至 ' + (range.end || '');
  }
  return DATE_PRESETS[range.preset].label;
}

function resolveDateRange(range) {
  if (!range || !DATE_PRESETS[range.preset] || range.preset === 'all') {
    return null;
  }
  const endOfDay = (d) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  if (range.preset === 'custom') {
    const start = parseISODate(range.start);
    const end = parseISODate(range.end);
    if (!start || !end || start.getTime() > end.getTime()) return null;
    return { startTs: start.getTime(), endTs: endOfDay(end) };
  }
  const r = computePresetRange(range.preset);
  const start = parseISODate(r.startISO);
  const end = parseISODate(r.endISO);
  if (!start || !end) return null;
  return { startTs: start.getTime(), endTs: endOfDay(end) };
}

function applyDateFilter(candidates, range) {
  if (!range) {
    return { dated: candidates, unknown: [], filtered: 0 };
  }
  const dated = [];
  const unknown = [];
  let filtered = 0;
  for (const c of candidates) {
    if (!c.date) {
      unknown.push(c);
    } else if (c.date < range.startTs || c.date > range.endTs) {
      filtered++;
    } else {
      dated.push(c);
    }
  }
  return { dated, unknown, filtered };
}

/* ---------- AI summarization ---------- */

function parseJsonArray(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch (_) { /* fall through */ }
  }
  try {
    return JSON.parse(t);
  } catch (_) {
    return null;
  }
}

async function summarize(candidates) {
  const x = settings.summaryCount;
  const system = [
    '你是一位资深新闻编辑。用户会提供一份已按热度排序的新闻清单（JSON 数组，每项含 title、url、source）。',
    '请严格按清单顺序为每条生成 1-2 句中文精炼摘要（只依据标题合理推断，不编造事实细节），',
    '输出严格的 JSON 数组，不包含任何多余文字或 Markdown 代码块。数组每项格式：',
    '{"title":"原标题或更精炼的标题","summary":"1-2 句中文精炼概括","source":"来源名称","url":"清单中原样返回的网址"}。',
    '必须恰好 ' + x + ' 条且顺序与清单一致；禁止添加清单之外的条目，禁止改写或编造 url。'
  ].join('');

  const endpoint = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + settings.apiKey
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: JSON.stringify(
            candidates.map(({ url, title, source }) => ({ url, title, source }))
          )
        }
      ],
      temperature: 0.3
    })
  });

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j.error && (j.error.message || j.error.code)) || JSON.stringify(j);
    } catch (_) {
      detail = await res.text().catch(() => '');
    }
    throw new Error('AI 接口返回错误 ' + res.status + (detail ? '：' + detail : ''));
  }

  const data = await res.json();
  const content =
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  if (!content) throw new Error('AI 接口返回内容为空');

  const parsed = parseJsonArray(content);
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('AI 返回格式无法解析');
  }

  const byUrl = new Map(candidates.map((c) => [c.url, c]));
  const items = parsed
    .filter((it) => it && it.url && it.title && byUrl.has(it.url))
    .slice(0, x)
    .map((it) => {
      const known = byUrl.get(it.url) || {};
      return {
        title: String(it.title).trim(),
        summary: String(it.summary || '').trim(),
        source: String(it.source || known.source || '未知来源').trim(),
        url: String(it.url),
        hotScore: known.hotScore || 0,
        hotWord: known.hotWord || ''
      };
    });

  if (!items.length) throw new Error('AI 未返回有效结果');
  return items;
}

/* ---------- Rendering ---------- */

function renderStatuses(statuses, heat) {
  const area = $('statusArea');
  area.textContent = '';
  statuses.forEach((s) => {
    const chip = document.createElement('span');
    chip.className = 'chip ' + s.state;
    if (s.state === 'ok') {
      chip.textContent = s.name + ' ✓ ' + s.count + ' 条' + (s.cached ? '（缓存）' : '');
    } else if (s.state === 'timeout') {
      chip.textContent = s.name + ' ✗ 超时';
    } else {
      chip.textContent = s.name + ' ✗ 抓取失败';
    }
    area.appendChild(chip);
  });
  if (heat) {
    const chip = document.createElement('span');
    if (heat.state === 'ok') {
      chip.className = 'chip ok';
      chip.textContent =
        '百度热榜 ✓ ' + heat.items.length + ' 条' + (heat.cached ? '（缓存）' : '');
    } else {
      chip.className = 'chip ' + heat.state;
      chip.textContent =
        '百度热榜 ✗ ' +
        (heat.state === 'timeout' ? '超时' : '抓取失败') +
        '，已降级为本地排序';
    }
    area.appendChild(chip);
  }
}

function renderResults(items) {
  const box = $('results');
  box.textContent = '';
  items.forEach((item, i) => {
    const card = document.createElement('article');
    card.className = 'card';

    const rank = document.createElement('div');
    rank.className = 'rank';
    rank.textContent = String(i + 1);

    const main = document.createElement('div');
    main.className = 'card-main';

    const title = document.createElement('h3');
    title.className = 'card-title';
    const titleLink = document.createElement('a');
    titleLink.href = item.url;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener';
    titleLink.textContent = item.title;
    title.appendChild(titleLink);

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const tag = document.createElement('span');
    tag.className = 'source-tag';
    tag.textContent = item.source;
    meta.appendChild(tag);
    if (item.hotScore) {
      const heat = document.createElement('span');
      heat.className = 'heat-badge';
      heat.textContent = '🔥 ' + formatHot(item.hotScore);
      heat.title = item.hotWord
        ? '百度热搜：' + item.hotWord + '（热度值 ' + item.hotScore + '）'
        : '百度实时热搜';
      meta.appendChild(heat);
    }

    const summary = document.createElement('p');
    summary.className = 'card-summary';
    summary.textContent = item.summary || '（该条未生成摘要）';

    const link = document.createElement('a');
    link.className = 'card-link';
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '阅读原文 ↗';

    main.appendChild(title);
    main.appendChild(meta);
    main.appendChild(summary);
    main.appendChild(link);

    card.appendChild(rank);
    card.appendChild(main);
    box.appendChild(card);
  });
}

function showPlaceholder(text) {
  const box = $('results');
  box.textContent = '';
  const p = document.createElement('p');
  p.className = 'placeholder';
  p.textContent = text;
  box.appendChild(p);
}

function setButtonText(text, disabled) {
  const btn = $('summarizeBtn');
  btn.classList.toggle('loading', disabled);
  btn.querySelector('.btn-label').textContent = text;
  btn.disabled = disabled;
}

function startCountdown(seconds) {
  const el = $('summarizeCountdown');
  clearInterval(countdownTimer);
  countdownRemaining = Math.max(1, Math.round(seconds));
  const render = () => {
    el.textContent =
      countdownRemaining > 0
        ? '预计还需 ' + countdownRemaining + ' 秒'
        : '处理中…';
  };
  render();
  countdownTimer = setInterval(() => {
    if (countdownRemaining > 0) countdownRemaining -= 1;
    render();
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  countdownRemaining = 0;
  $('summarizeCountdown').textContent = '';
}

/* ---------- Main flow ---------- */

async function ensurePermissions() {
  const origins = new Set();
  settings.sources.forEach((src) => {
    const p = originPattern(src.url);
    if (p) origins.add(p);
  });
  const api = originPattern(settings.baseUrl);
  if (api) origins.add(api);
  if (origins.size) {
    await chrome.permissions.request({ origins: Array.from(origins) });
  }
}

async function runSummarize() {
  if ($('summarizeBtn').disabled) return;
  if (!settings.apiKey || !settings.baseUrl) {
    showPlaceholder('请先在“设置”中配置 API Key、Base URL 和模型。');
    openSettings();
    return;
  }

  $('forceRefreshBtn').disabled = true;
  setButtonText(forceRefresh ? '正在强制刷新…' : '正在抓取新闻源…', true);
  $('statusArea').textContent = '';
  startCountdown(8);

  try {
    await ensurePermissions();
    const cache = await readCache();
    const [{ candidates, statuses, freshHtml }, heatResult] = await Promise.all([
      fetchAllSources(cache, forceRefresh),
      fetchHeatWithCache(cache, forceRefresh)
    ]);
    renderStatuses(statuses, heatResult);

    if (!candidates.length) {
      throw new Error('未能从任何新闻源抓取到有效链接，请检查网络或稍后再试。');
    }

    const range = resolveDateRange(settings.dateRange);
    const { dated, unknown, filtered } = applyDateFilter(candidates, range);
    if (range) {
      const chip = document.createElement('span');
      chip.className = 'chip pending';
      let label = '时间范围：' + dateRangeLabel(settings.dateRange);
      if (filtered > 0) label += '（过滤 ' + filtered + ' 条）';
      if (unknown.length > 0) {
        label += '；' + unknown.length + ' 条未识别时间排后';
      }
      chip.textContent = label;
      $('statusArea').appendChild(chip);
    }
    if (!dated.length && !unknown.length) {
      throw new Error('所选时间范围内没有匹配的新闻，请调整时间范围后重试。');
    }

    const selected = rankCandidates(dated, heatResult.items)
      .concat(rankCandidates(unknown, heatResult.items))
      .slice(0, settings.summaryCount);

    const now = Date.now();
    const activeUrls = new Set(settings.sources.map((s) => s.url));
    const oldHtml = (cache && cache.html) || {};
    const html = {};
    for (const url of Object.keys(oldHtml)) {
      const e = oldHtml[url];
      if (activeUrls.has(url) && e && now - e.ts < CACHE_TTL && !(url in freshHtml)) {
        html[url] = e;
      }
    }
    for (const url of Object.keys(freshHtml)) {
      html[url] = { ts: now, html: freshHtml[url] };
    }
    const nextCache = { html };
    if (heatResult.raw) {
      nextCache.heat = heatResult.raw;
    } else if (cache && cache.heat && now - cache.heat.ts < CACHE_TTL) {
      nextCache.heat = cache.heat;
    }
    if (Object.keys(html).length || nextCache.heat) {
      await writeCache(nextCache);
    }

    setButtonText('AI 正在生成摘要（' + selected.length + ' 条）…', true);
    startCountdown(10 + selected.length * 0.08);
    const items = await summarize(selected);
    renderResults(items);
  } catch (err) {
    showPlaceholder('出错了：' + (err && err.message ? err.message : err));
  } finally {
    stopCountdown();
    setButtonText('一键总结热点新闻', false);
    $('forceRefreshBtn').disabled = false;
  }
}

/* ---------- Settings drawer ---------- */

function openSettings() {
  $('apiKeyInput').value = settings.apiKey;
  $('baseUrlInput').value = settings.baseUrl;
  $('modelInput').value = settings.model;
  $('countInput').value = settings.summaryCount;
  $('datePresetSelect').value = DATE_PRESETS[settings.dateRange.preset]
    ? settings.dateRange.preset
    : 'all';
  fillDateRangeUI();
  renderSourceRows();
  $('settingsDrawer').classList.remove('hidden');
}

function fillDateRangeUI() {
  const preset = $('datePresetSelect').value;
  let start = preset === 'custom' ? (settings.dateRange.start || '') : '';
  let end = preset === 'custom' ? (settings.dateRange.end || '') : '';
  if (preset !== 'custom') {
    const r = computePresetRange(preset);
    start = r.startISO;
    end = r.endISO;
  }
  $('dateStartInput').value = start;
  $('dateEndInput').value = end;
  const custom = preset === 'custom';
  $('dateStartInput').disabled = !custom;
  $('dateEndInput').disabled = !custom;
}

function closeSettings() {
  $('settingsDrawer').classList.add('hidden');
}

function renderSourceRows() {
  const box = $('sourceRows');
  box.textContent = '';
  settings.sources.forEach((src) => {
    box.appendChild(createSourceRow(src.name, src.url));
  });
}

function createSourceRow(name, url) {
  const row = document.createElement('div');
  row.className = 'source-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'source-name';
  nameInput.placeholder = '名称';
  nameInput.value = name || '';

  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.className = 'source-url';
  urlInput.placeholder = 'https://example.com';
  urlInput.value = url || '';

  const del = document.createElement('button');
  del.className = 'icon-btn';
  del.title = '删除';
  del.textContent = '×';
  del.addEventListener('click', () => row.remove());

  row.appendChild(nameInput);
  row.appendChild(urlInput);
  row.appendChild(del);
  return row;
}

function collectSourcesFromRows() {
  const rows = Array.from($('sourceRows').querySelectorAll('.source-row'));
  const sources = [];
  const seenUrls = new Set();
  for (const row of rows) {
    const name = row.querySelector('.source-name').value.trim();
    const url = normalizeUrl(row.querySelector('.source-url').value);
    if (!name || !url) continue;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    sources.push({
      id: 'custom_' + Math.random().toString(36).slice(2, 10),
      name,
      url
    });
  }
  return sources;
}

function showToast(text, isError) {
  const toast = $('settingsToast');
  toast.textContent = text;
  toast.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.textContent = '';
  }, 2600);
}

async function saveFromSettings() {
  const rows = Array.from($('sourceRows').querySelectorAll('.source-row'));
  const invalid = rows.some((row) => {
    const name = row.querySelector('.source-name').value.trim();
    const url = normalizeUrl(row.querySelector('.source-url').value);
    return (name || url) && (!name || !url);
  });
  if (invalid) {
    showToast('请补全每个新闻源的名称和网址，或删除空行。', true);
    return;
  }

  const sources = collectSourcesFromRows();
  if (!sources.length) {
    showToast('至少需要保留一个新闻源。', true);
    return;
  }

  settings.apiKey = $('apiKeyInput').value.trim();
  settings.baseUrl = normalizeUrl($('baseUrlInput').value) ||
    'https://api.openai.com/v1';
  settings.model = $('modelInput').value.trim() || DEFAULT_SETTINGS.model;
  settings.summaryCount = clampInt($('countInput').value, 1, 30, 10);
  settings.sources = sources;

  const preset = $('datePresetSelect').value;
  let start = $('dateStartInput').value;
  let end = $('dateEndInput').value;
  if (preset === 'custom') {
    if (!start || !end) {
      showToast('自定义时间范围需要填写开始和截止日期。', true);
      return;
    }
    if (start > end) {
      showToast('开始日期不能晚于截止日期。', true);
      return;
    }
  } else {
    const r = computePresetRange(preset);
    start = r.startISO;
    end = r.endISO;
  }
  settings.dateRange = { preset, start, end };

  await saveSettings();
  renderSources();
  closeSettings();
  showPlaceholder('设置已保存。点击“一键总结热点新闻”开始。');
}

/* ---------- Init ---------- */

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  renderSources();

  $('openSettingsBtn').addEventListener('click', openSettings);
  $('closeSettingsBtn').addEventListener('click', closeSettings);
  $('settingsDrawer').addEventListener('click', (e) => {
    if (e.target === $('settingsDrawer')) closeSettings();
  });
  $('summarizeBtn').addEventListener('click', runSummarize);
  $('datePresetSelect').addEventListener('change', fillDateRangeUI);
  $('forceRefreshBtn').addEventListener('click', async () => {
    if ($('summarizeBtn').disabled) return;
    forceRefresh = true;
    try {
      await runSummarize();
    } finally {
      forceRefresh = false;
    }
  });
  $('addSourceBtn').addEventListener('click', () => {
    $('sourceRows').appendChild(createSourceRow('', ''));
  });
  $('saveSettingsBtn').addEventListener('click', saveFromSettings);
  $('resetFloatBtn').addEventListener('click', async () => {
    settings.floatPosition = { top: 45 };
    await saveSettings();
    showToast('悬浮球位置已重置。');
  });

  if (!settings.apiKey) {
    showPlaceholder('请先在右上角“设置”中配置 API Key、Base URL 和模型。');
  } else {
    showPlaceholder('配置已完成，点击上方“一键总结热点新闻”开始。');
  }
});
