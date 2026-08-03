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
  floatPosition: { top: 45 }
};

let settings = null;

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
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
}

/* ---------- Source buttons ---------- */

function renderSources() {
  const box = $('sourceButtons');
  box.textContent = '';
  settings.sources.forEach((src) => {
    const btn = document.createElement('button');
    btn.className = 'source-btn';
    btn.textContent = src.name;
    btn.title = src.url;
    btn.addEventListener('click', () => {
      window.open(src.url, '_blank', 'noopener');
    });
    box.appendChild(btn);
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

function extractLinks(html, sourceUrl, max) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base = new URL(sourceUrl);
  const baseReg = registrableDomain(base.hostname);
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

    candidates.push({ url: key, title: finalTitle, score });
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates
    .slice(0, max)
    .map(({ url, title }) => ({ url, title }));
}

async function fetchAllSources() {
  const results = await Promise.all(
    settings.sources.map(async (src) => {
      let links = [];
      let state = 'error';
      try {
        const html = await fetchWithTimeout(src.url, 12000);
        links = extractLinks(html, src.url, 30);
        state = 'ok';
      } catch (err) {
        state = err && err.name === 'AbortError' ? 'timeout' : 'error';
      }
      return { name: src.name, url: src.url, state, links };
    })
  );

  const candidates = [];
  const seenUrls = new Set();
  for (const r of results) {
    if (r.state !== 'ok') continue;
    for (const link of r.links) {
      if (seenUrls.has(link.url)) continue;
      seenUrls.add(link.url);
      candidates.push({
        url: link.url,
        title: link.title,
        source: r.name
      });
    }
  }

  const statuses = results.map((r) => ({
    name: r.name,
    state: r.state,
    count: r.links.length
  }));
  return { candidates, statuses };
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
    '你是一位资深新闻编辑。用户会提供一份候选新闻清单（JSON 数组，每项含 title、url、source）。',
    '请从中挑选最热门的 ' + x + ' 条新闻（尽量覆盖不同来源），输出严格的 JSON 数组，',
    '不包含任何多余文字或 Markdown 代码块。数组每项格式：',
    '{"title":"原标题或更精炼的标题","summary":"1-2 句中文精炼概括，只依据标题合理推断，不编造事实细节","source":"来源名称","url":"清单中原样返回的网址"}。',
    '必须恰好 ' + x + ' 条；只能从清单中挑选，禁止添加清单之外的条目，禁止改写或编造 url。'
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
        { role: 'user', content: JSON.stringify(candidates) }
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
    .filter((it) => it && it.url && it.title)
    .slice(0, x)
    .map((it) => {
      const known = byUrl.get(it.url) || {};
      return {
        title: String(it.title).trim(),
        summary: String(it.summary || '').trim(),
        source: String(it.source || known.source || '未知来源').trim(),
        url: String(it.url)
      };
    });

  if (!items.length) throw new Error('AI 未返回有效结果');
  return items;
}

/* ---------- Rendering ---------- */

function renderStatuses(statuses) {
  const area = $('statusArea');
  area.textContent = '';
  statuses.forEach((s) => {
    const chip = document.createElement('span');
    chip.className = 'chip ' + s.state;
    if (s.state === 'ok') {
      chip.textContent = s.name + ' ✓ ' + s.count + ' 条';
    } else if (s.state === 'timeout') {
      chip.textContent = s.name + ' ✗ 超时';
    } else {
      chip.textContent = s.name + ' ✗ 抓取失败';
    }
    area.appendChild(chip);
  });
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
  btn.textContent = text;
  btn.disabled = disabled;
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

  setButtonText('正在抓取新闻源…', true);
  $('statusArea').textContent = '';

  try {
    await ensurePermissions();
    const { candidates, statuses } = await fetchAllSources();
    renderStatuses(statuses);

    if (!candidates.length) {
      throw new Error('未能从任何新闻源抓取到有效链接，请检查网络或稍后再试。');
    }

    setButtonText('AI 正在总结热点（' + candidates.length + ' 条候选）…', true);
    const items = await summarize(candidates);
    renderResults(items);
  } catch (err) {
    showPlaceholder('出错了：' + (err && err.message ? err.message : err));
  } finally {
    setButtonText('一键总结热点新闻', false);
  }
}

/* ---------- Settings drawer ---------- */

function openSettings() {
  $('apiKeyInput').value = settings.apiKey;
  $('baseUrlInput').value = settings.baseUrl;
  $('modelInput').value = settings.model;
  $('countInput').value = settings.summaryCount;
  renderSourceRows();
  $('settingsDrawer').classList.remove('hidden');
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
