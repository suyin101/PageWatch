// 注入到网页快照里的“点选元素”脚本：鼠标悬停高亮，点击选中，生成 CSS 选择器
(function () {
  const ORIGIN = location.origin;
  const send = (msg) => parent.postMessage(msg, ORIGIN);

  const style = document.createElement('style');
  style.textContent = `
    .__pw-hover { outline: 2px dashed #f59e0b !important; outline-offset: 2px !important; cursor: crosshair !important; }
    .__pw-picked { outline: 3px solid #2563eb !important; outline-offset: 2px !important; background: rgba(37,99,235,.12) !important; }
    * { cursor: crosshair !important; }
  `;
  document.head.appendChild(style);

  let hovered = null;
  let picked = null;

  // 看起来像自动生成的随机 class/id（如 css-1x2y3z、sc-abc123），不稳定，不用
  const unstable = (s) =>
    /\d{3,}|^(css|sc|jsx|svelte|emotion|chakra)-|[A-Z0-9]{6,}|__pw-|^(is|has)-/.test(s) || /active|hover|focus|selected|current|open|show/i.test(s) || s.length > 40;

  const esc = (s) => CSS.escape(s);
  const unique = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };

  function segment(el) {
    const tag = el.tagName.toLowerCase();
    const classes = [...el.classList].filter((c) => !unstable(c)).slice(0, 2);
    let seg = tag + classes.map((c) => '.' + esc(c)).join('');
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) seg += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return seg;
  }

  function cssPath(el) {
    if (el.id && !unstable(el.id) && unique('#' + esc(el.id))) return '#' + esc(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node !== el && node.id && !unstable(node.id) && unique('#' + esc(node.id))) {
        parts.unshift('#' + esc(node.id));
        break;
      }
      parts.unshift(segment(node));
      const sel = parts.join(' > ');
      if (unique(sel)) return sel;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function text(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function describe(el) {
    const attrs = {};
    for (const a of ['href', 'src', 'title', 'alt', 'value', 'datetime', 'content']) {
      if (el.hasAttribute(a)) attrs[a] = a === 'href' || a === 'src' ? el[a] : el.getAttribute(a);
    }
    return { selector: cssPath(el), text: text(el).slice(0, 500), tag: el.tagName.toLowerCase(), attrs };
  }

  function pick(el) {
    if (picked) picked.classList.remove('__pw-picked');
    picked = el;
    if (!el) return;
    el.classList.remove('__pw-hover');
    el.classList.add('__pw-picked');
    send({ type: 'pw-pick', ...describe(el) });
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      if (hovered) hovered.classList.remove('__pw-hover');
      hovered = e.target;
      if (hovered !== picked) hovered.classList.add('__pw-hover');
    },
    true
  );

  document.addEventListener(
    'mouseout',
    () => {
      if (hovered) hovered.classList.remove('__pw-hover');
      hovered = null;
    },
    true
  );

  // 拦截所有点击，防止点到链接跳走
  for (const type of ['click', 'mousedown', 'mouseup', 'submit', 'auxclick']) {
    document.addEventListener(
      type,
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (type === 'click') pick(e.target);
      },
      true
    );
  }

  // 面板发来的指令：选父级元素、根据选择器高亮
  window.addEventListener('message', (e) => {
    if (e.origin !== ORIGIN || !e.data) return;
    if (e.data.type === 'pw-parent' && picked && picked.parentElement && picked.parentElement !== document.body) {
      pick(picked.parentElement);
    } else if (e.data.type === 'pw-highlight') {
      let el = null;
      try {
        el = document.querySelector(e.data.selector);
      } catch {}
      if (picked) picked.classList.remove('__pw-picked');
      picked = el;
      if (el) {
        el.classList.add('__pw-picked');
        el.scrollIntoView({ block: 'center' });
      }
      send({ type: 'pw-highlight-result', found: !!el, count: el ? document.querySelectorAll(e.data.selector).length : 0, text: el ? text(el).slice(0, 500) : '' });
    }
  });

  send({ type: 'pw-loaded', ok: true });
})();
