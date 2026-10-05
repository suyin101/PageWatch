// 注入到网页快照里的脚本：选元素模式下鼠标悬停高亮、点击选中、生成 CSS 选择器；浏览模式下和平常看网页一样
(function () {
  const ORIGIN = location.origin;
  const send = (msg) => parent.postMessage(msg, ORIGIN);

  const style = document.createElement('style');
  style.textContent = `
    html:not(.__pw-browse) .__pw-hover { outline: 2px dashed #f59e0b !important; outline-offset: 2px !important; }
    html:not(.__pw-browse) .__pw-picked { outline: 3px solid #2563eb !important; outline-offset: 2px !important; background: rgba(37,99,235,.12) !important; }
    html:not(.__pw-browse) * { cursor: crosshair !important; }
  `;
  document.head.appendChild(style);

  let hovered = null;
  let picked = null;
  // pick：点击是选元素；browse：点击是在后台真实网页上点一下（进入链接、切换标签页等）
  let mode = 'pick';
  // 浏览模式下能点的东西：链接、按钮等，点到里面的文字/图标算作点它本身。
  // 网页原来的脚本都去掉了，没法知道哪些普通元素能点，就看网站有没有给它设“小手”鼠标
  const clickable = (el) => {
    const c = el.closest('a[href], button, summary, label, select, [role="button"], [role="tab"], [role="link"], [role="menuitem"]');
    if (c) return c;
    for (let n = el; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).cursor === 'pointer') return n;
    return null;
  };

  const { cssPath, text } = window.PWSelector; // 来自 selector.js，和后台共用

  function describe(el) {
    const attrs = {};
    for (const a of ['href', 'src', 'title', 'alt', 'value', 'datetime', 'content']) {
      if (el.hasAttribute(a)) attrs[a] = a === 'href' || a === 'src' ? el[a] : el.getAttribute(a);
    }
    const a = el.closest('a[href]') || el.querySelector('a[href]');
    const link = a && !/^javascript:/i.test(a.getAttribute('href')) ? a.href : '';
    return { selector: cssPath(el), pwi: el.getAttribute('data-pw-i'), text: text(el).slice(0, 500), tag: el.tagName.toLowerCase(), attrs, link };
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
      hovered = mode === 'browse' ? null : e.target; // 浏览模式不画框，和平常看网页一样
      if (hovered && hovered !== picked) hovered.classList.add('__pw-hover');
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

  // 拦截所有点击，防止快照自己跳走；浏览模式下把点击交给后台的真实网页去点
  for (const type of ['click', 'mousedown', 'mouseup', 'submit', 'auxclick']) {
    document.addEventListener(
      type,
      (e) => {
        // 浏览模式：像平常一样，按下拖动能选中文字；点到普通文字什么也不发生
        if (mode === 'browse' && (type === 'mousedown' || type === 'mouseup')) return;
        const el = mode === 'browse' && type === 'click' ? clickable(e.target) : null;
        if (mode === 'browse' && type === 'click' && !el) return;
        e.preventDefault();
        e.stopPropagation();
        if (type !== 'click') return;
        if (mode === 'pick') return pick(e.target);
        const a = el.closest('a[href]');
        const href = a && !/^javascript:/i.test(a.getAttribute('href')) ? a.href : '';
        send({ type: 'pw-click', selector: cssPath(el), pwi: el.getAttribute('data-pw-i'), href, text: text(el).slice(0, 40) });
      },
      true
    );
  }

  // 面板发来的指令：选父级元素、根据选择器高亮
  window.addEventListener('message', (e) => {
    if (e.origin !== ORIGIN || !e.data) return;
    if (e.data.type === 'pw-mode') {
      mode = e.data.mode === 'browse' ? 'browse' : 'pick';
      document.documentElement.classList.toggle('__pw-browse', mode === 'browse');
      if (hovered) hovered.classList.remove('__pw-hover');
      hovered = null;
    } else if (e.data.type === 'pw-parent' && picked && picked.parentElement && picked.parentElement !== document.body) {
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

  // 图片加载失败（网站防盗链、你的网络访问不到等），改由服务器代为获取，并带上原网页地址作为来源
  const PAGE = document.baseURI;
  function proxyImage(img) {
    const src = img.currentSrc || img.src;
    if (img.dataset.pwProxied || !/^https?:/.test(src)) return;
    img.dataset.pwProxied = '1';
    const pic = img.closest('picture');
    if (pic) pic.querySelectorAll('source').forEach((s) => s.remove());
    img.removeAttribute('srcset');
    img.src = `${ORIGIN}/api/img?u=${encodeURIComponent(src)}&r=${encodeURIComponent(PAGE)}`;
  }
  document.addEventListener('error', (e) => e.target instanceof HTMLImageElement && proxyImage(e.target), true);
  // 这段脚本运行前就已经失败了的图片
  for (const img of document.images) if (img.complete && !img.naturalWidth && (img.currentSrc || img.src)) proxyImage(img);

  send({ type: 'pw-loaded', ok: true });
})();
