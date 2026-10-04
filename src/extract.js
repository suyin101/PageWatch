// 从读到的文字里只取出关键部分（比如版本号）再比较，旁边的日期、下载次数变了也不会误报。
// 这个文件服务器和网页都用（网页通过 /extract.js 加载），保证编辑时看到的和实际检查的一样。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PWExtract = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MODES = {
    '': '整段文字',
    version: '只看版本号',
    number: '只看第一个数字',
    regex: '自定义（正则表达式）',
  };

  // 版本号：至少带一个点的数字串，如 2.3.1、19.1.4.0；后面跟着的 beta / rc 等也一起保留
  const VERSION_RE = /\d+(?:\.\d+){1,3}(?:[-_ ]?(?:alpha|beta|rc|preview)(?![a-z])[-. ]?\d*|[ab]\d+)?/i;
  const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/;

  // 检查自定义正则写得对不对，不对时返回中文错误说明
  function checkPattern(pattern) {
    if (!pattern) return '请填写正则表达式';
    try {
      new RegExp(pattern);
      return '';
    } catch (e) {
      return '正则表达式写得不对：' + e.message;
    }
  }

  // 返回提取后的文字；没找到时抛出错误
  function extract(text, mode, pattern) {
    text = String(text == null ? '' : text);
    if (!mode) return text;
    let m;
    if (mode === 'version') {
      m = text.match(VERSION_RE);
      // 没有带点的版本号（如 “Version 20”），退而求其次取第一个数字
      if (!m) m = text.match(/\d+/);
      if (!m) throw new Error(`在内容里没找到版本号：“${short(text)}”`);
      return m[0].trim();
    }
    if (mode === 'number') {
      m = text.match(NUMBER_RE);
      if (!m) throw new Error(`在内容里没找到数字：“${short(text)}”`);
      return m[0];
    }
    if (mode === 'regex') {
      const err = checkPattern(pattern);
      if (err) throw new Error(err);
      m = text.match(new RegExp(pattern));
      if (!m) throw new Error(`自定义规则在内容里没匹配到：“${short(text)}”`);
      // 有括号分组就取第一个分组，否则取整个匹配
      return (m[1] !== undefined ? m[1] : m[0]).trim();
    }
    return text;
  }

  // 编辑时的小提示：内容里有版本号、但整段文字比版本号长很多时，建议只看版本号
  function suggestVersion(text) {
    const m = String(text || '').match(VERSION_RE);
    return m && String(text).trim().length > m[0].length + 3 ? m[0] : '';
  }

  function short(s) {
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  return { MODES, extract, checkPattern, suggestVersion };
});
