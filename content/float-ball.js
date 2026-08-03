(function () {
  'use strict';

  if (window.__newsDigestBall) return;
  window.__newsDigestBall = true;

  const host = document.createElement('div');
  host.id = 'news-digest-float-ball';
  host.style.cssText =
    'position:fixed;right:12px;top:45%;z-index:2147483647;margin:0;padding:0;';

  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .ball {
        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 12px 18px;
        border-radius: 999px;
        background: linear-gradient(135deg, #ff5f5f, #d92b2b);
        color: #fff;
        font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 1px;
        white-space: nowrap;
        box-shadow: 0 4px 14px rgba(217, 43, 43, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.25);
        transform: translateY(-50%);
        transition: box-shadow 0.15s ease;
      }
      .ball:hover { box-shadow: 0 6px 20px rgba(217, 43, 43, 0.6); }
      .ball.dragging { cursor: grabbing; opacity: 0.85; }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
      }
    </style>
    <div class="ball" title="新闻速览"><span class="dot"></span><span>新闻速览</span></div>
  `;

  const ball = root.querySelector('.ball');
  (document.body || document.documentElement).appendChild(host);

  let dragging = false;
  let moved = false;
  let startY = 0;
  let startTop = 0;
  let top = 45;

  function applyPos() {
    host.style.top = top + '%';
  }

  function savePos() {
    chrome.storage.local.get('settings', (res) => {
      const s = Object.assign({}, res.settings || {});
      s.floatPosition = { top: Math.round(top * 10) / 10 };
      chrome.storage.local.set({ settings: s });
    });
  }

  function loadPos() {
    chrome.storage.local.get('settings', (res) => {
      const s = res && res.settings;
      if (s && s.floatPosition && typeof s.floatPosition.top === 'number') {
        top = Math.min(95, Math.max(3, s.floatPosition.top));
        applyPos();
      }
    });
  }

  ball.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    startY = e.clientY;
    startTop = top;
    ball.setPointerCapture(e.pointerId);
    ball.classList.add('dragging');
    e.preventDefault();
  });

  ball.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 3) moved = true;
    top = Math.min(95, Math.max(3, startTop + (dy / window.innerHeight) * 100));
    applyPos();
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    ball.classList.remove('dragging');
    if (moved) savePos();
  }

  ball.addEventListener('pointerup', endDrag);
  ball.addEventListener('pointercancel', endDrag);

  ball.addEventListener('click', (e) => {
    if (moved) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    chrome.runtime.sendMessage({ type: 'openDigest' });
  });

  loadPos();
})();
