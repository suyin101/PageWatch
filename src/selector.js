// 给网页元素生成 CSS 选择器。网页快照里的点选脚本（picker.js）和后台真实网页（browser.js）共用这一份，
// 这样两边算出来的选择器规则一致
(function (root) {
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
      // 只有标签名（如 “a”）太容易变，至少再带上一层父元素
      if (unique(sel) && (parts.length > 1 || parts[0] !== el.tagName.toLowerCase())) return sel;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function text(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  root.PWSelector = { cssPath, text };
})(window);
