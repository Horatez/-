/* Графики на чистом SVG. Цвета берутся из CSS-переменных и записываются
   атрибутами, чтобы SVG можно было выгрузить в PNG без таблицы стилей. */
const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }

  function root(w, h, label) {
    return s('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img',
      'aria-label': label, 'font-family': FONT, 'font-size': 11 });
  }

  function ticks(lo, hi, n = 4) {
    if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
    const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].find(m => m * mag >= raw) * mag;
    const out = [];
    for (let v = Math.floor(lo / step) * step; ; v += step) {
      out.push(+v.toFixed(10));
      if (v >= hi - step * 1e-9 || out.length > 20) break;
    }
    return out;
  }

  function empty(svg, w, h) {
    svg.append(s('text', { x: w / 2, y: h / 2, 'text-anchor': 'middle', fill: css('--muted') }, 'нет данных'));
    return svg;
  }

  /* Динамика показателя: линия предприятия + уровень отрасли. */
  function line({ years, values, bench, fmt, name }) {
    const W = 320, H = 160, m = { l: 56, r: 54, t: 12, b: 22 };
    const svg = root(W, H, `${name}: динамика по годам`);
    const real = values.filter(v => v != null);
    if (!real.length) return empty(svg, W, H);
    const all = bench != null ? real.concat(bench) : real;
    const tk = ticks(Math.min(...all), Math.max(...all), 3);
    const lo = tk[0], hi = tk[tk.length - 1];
    const pw = W - m.l - m.r, ph = H - m.t - m.b, inset = 12;
    const x = i => m.l + inset + (years.length === 1 ? (pw - 2 * inset) / 2 : (pw - 2 * inset) * i / (years.length - 1));
    const y = v => m.t + ph - (v - lo) / (hi - lo) * ph;
    const surface = css('--surface'), c1 = css('--series-1'), c2 = css('--series-2');

    for (const t of tk) {
      svg.append(s('line', { x1: m.l, x2: m.l + pw, y1: y(t), y2: y(t), stroke: css('--grid'), 'stroke-width': 1 }),
        s('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end', fill: css('--muted') }, fmt(t, true)));
    }
    years.forEach((yr, i) => svg.append(
      s('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', fill: css('--muted') }, yr)));
    if (bench != null) {
      svg.append(s('line', { x1: m.l, x2: m.l + pw, y1: y(bench), y2: y(bench),
        stroke: c2, 'stroke-width': 2, 'stroke-linecap': 'round' }));
    }
    let d = '', pen = false;
    values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    svg.append(s('path', { d, fill: 'none', stroke: c1, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    let last = -1;
    values.forEach((v, i) => {
      if (v == null) return;
      last = i;
      svg.append(s('circle', { cx: x(i), cy: y(v), r: 4, fill: c1, stroke: surface, 'stroke-width': 2 }));
    });
    // подпись последней точки не должна ложиться на линию отрасли
    let ly = y(values[last]) + 4;
    if (bench != null && Math.abs(y(values[last]) - y(bench)) < 9) ly += values[last] >= bench ? -8 : 10;
    svg.append(s('text', { x: x(last) + 9, y: ly, fill: css('--ink'), 'font-weight': 600 },
      fmt(values[last])));
    const band = years.length > 1 ? (pw - 2 * inset) / (years.length - 1) : pw;
    years.forEach((yr, i) => svg.append(s('rect', {
      x: x(i) - band / 2, y: m.t, width: band, height: ph, fill: 'transparent',
      'data-tip': `${name}, ${yr}\nПредприятие: ${fmt(values[i])}` +
        (bench != null ? `\nОтрасль: ${fmt(bench)}` : '') })));
    return svg;
  }

  function barPath(x0, x1, y, h) {
    const r = Math.min(4, Math.abs(x1 - x0)), sg = x1 >= x0 ? 1 : -1;
    return `M${x0} ${y}H${x1 - sg * r}Q${x1} ${y} ${x1} ${y + r}V${y + h - r}Q${x1} ${y + h} ${x1 - sg * r} ${y + h}H${x0}Z`;
  }

  /* Сравнение с отраслью: пары горизонтальных столбцов от общей нулевой линии. */
  function bars({ items, fmt, label }) {
    const W = 520, rowH = 52, bh = 11, padR = 74, padL = 8;
    const H = items.length * rowH + 6;
    const svg = root(W, H, label);
    const nums = items.flatMap(it => [it.value, it.bench]).filter(v => v != null);
    if (!nums.length) return empty(svg, W, 60);
    const lo = Math.min(0, ...nums), hi = Math.max(0, ...nums);
    const negPad = lo < 0 ? 60 : 0;
    const x = v => padL + negPad + (v - lo) / ((hi - lo) || 1) * (W - padL - padR - negPad);
    const c = [css('--series-1'), css('--series-2')];
    svg.append(s('line', { x1: x(0), x2: x(0), y1: 0, y2: H, stroke: css('--axis'), 'stroke-width': 1 }));
    items.forEach((it, i) => {
      const top = i * rowH;
      svg.append(s('text', { x: padL, y: top + 14, fill: css('--ink-2'), 'font-size': 12 }, it.name));
      [it.value, it.bench].forEach((v, k) => {
        const yb = top + 21 + k * (bh + 2);
        if (v == null) {
          svg.append(s('text', { x: x(0) + 6, y: yb + 9, fill: css('--muted') }, 'нет данных'));
          return;
        }
        svg.append(s('path', { d: barPath(x(0), x(v), yb, bh), fill: c[k] }),
          s('text', { x: x(v) + (v < 0 ? -5 : 5), y: yb + 9, 'text-anchor': v < 0 ? 'end' : 'start',
            fill: css('--ink'), 'font-weight': k ? 400 : 600 }, fmt(v)));
      });
      svg.append(s('rect', { x: 0, y: top, width: W, height: rowH, fill: 'transparent', 'data-tip': it.tip }));
    });
    return svg;
  }

  function luminance(color) {
    const m = /^#?([0-9a-f]{6})$/i.exec(color);
    if (!m) return 1;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const BINS = ['--div-neg-3', '--div-neg-2', '--div-neg-1', '--div-mid', '--div-pos-1', '--div-pos-2', '--div-pos-3'];
  function bin(pct) {
    const a = Math.abs(pct), step = a < 5 ? 0 : a < 20 ? 1 : a < 50 ? 2 : 3;
    return 3 + Math.sign(pct) * step;
  }

  /* Тепловая карта: отклонение от отрасли в %, расходящаяся шкала с серой серединой. */
  function heat({ years, rows, fmtPct }) {
    const W = 760, labelW = 370, head = 22, rowH = 26, gap = 2, legendH = 46;
    const cw = (W - labelW) / years.length;
    const H = head + rows.length * rowH + legendH;
    const svg = root(W, H, 'Тепловая карта отклонений от отрасли');
    const colors = BINS.map(css);
    years.forEach((yr, j) => svg.append(s('text', { x: labelW + cw * j + cw / 2, y: 14,
      'text-anchor': 'middle', fill: css('--muted') }, yr)));
    rows.forEach((row, i) => {
      const y = head + i * rowH;
      svg.append(s('text', { x: 0, y: y + 16, fill: css('--ink-2'), 'font-size': 12 }, row.name));
      row.cells.forEach((cell, j) => {
        const xx = labelW + cw * j;
        if (cell.pct == null) {
          svg.append(s('text', { x: xx + cw / 2, y: y + 16, 'text-anchor': 'middle', fill: css('--muted') }, '—'));
        } else {
          const fill = colors[bin(cell.pct)];
          svg.append(s('rect', { x: xx + gap / 2, y: y + gap / 2, width: cw - gap, height: rowH - gap, rx: 3, fill }),
            s('text', { x: xx + cw / 2, y: y + 17, 'text-anchor': 'middle',
              fill: luminance(fill) > 0.35 ? '#0b0b0b' : '#ffffff' }, fmtPct(cell.pct)));
        }
        svg.append(s('rect', { x: xx, y, width: cw, height: rowH, fill: 'transparent', 'data-tip': cell.tip }));
      });
    });
    const ly = head + rows.length * rowH + 14, sw = 34;
    const lx = W - 7 * (sw + 2) - 96;
    colors.forEach((cl, k) => svg.append(s('rect', { x: lx + k * (sw + 2), y: ly, width: sw, height: 10, rx: 2, fill: cl })));
    const ink = css('--ink-2');
    svg.append(
      s('text', { x: lx - 8, y: ly + 9, 'text-anchor': 'end', fill: ink }, 'ниже отрасли'),
      s('text', { x: lx + 7 * (sw + 2) + 6, y: ly + 9, fill: ink }, 'выше отрасли'),
      s('text', { x: lx, y: ly + 24, fill: css('--muted') }, '≥50 %'),
      s('text', { x: lx + 3.5 * (sw + 2) - 1, y: ly + 24, 'text-anchor': 'middle', fill: css('--muted') }, '±5 %'),
      s('text', { x: lx + 7 * (sw + 2) - 2, y: ly + 24, 'text-anchor': 'end', fill: css('--muted') }, '≥50 %'));
    return svg;
  }

  function spark(values) {
    const W = 84, H = 28, pts = values.map((v, i) => [i, v]).filter(p => p[1] != null);
    const svg = root(W, H, 'Динамика');
    svg.setAttribute('class', 'spark');
    if (pts.length < 2) return svg;
    const lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1]));
    const x = i => 5 + i / (values.length - 1) * (W - 10);
    const y = v => H - 5 - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * (H - 10);
    svg.append(s('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(''),
      fill: 'none', stroke: css('--muted'), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const e = pts[pts.length - 1];
    svg.append(s('circle', { cx: x(e[0]), cy: y(e[1]), r: 4, fill: css('--series-1'), stroke: css('--surface'), 'stroke-width': 2 }));
    return svg;
  }

  /* ---- PNG: SVG и подписи (.pt) области переносятся на canvas ---- */
  async function svgImage(svg) {
    const r = svg.getBoundingClientRect(), copy = svg.cloneNode(true);
    copy.setAttribute('xmlns', NS);
    copy.setAttribute('width', r.width);
    copy.setAttribute('height', r.height);
    const img = new Image();
    await new Promise((ok, fail) => {
      img.onload = ok; img.onerror = fail;
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
    });
    return [img, r];
  }

  function wrapText(ctx, el, ox, oy) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const size = parseFloat(cs.fontSize), lh = parseFloat(cs.lineHeight) || size * 1.45;
    ctx.font = `${cs.fontWeight} ${size}px ${FONT}`;
    ctx.fillStyle = cs.color;
    ctx.textBaseline = 'middle';
    const padL = parseFloat(cs.paddingLeft) || 0;
    const maxW = r.width - padL - (parseFloat(cs.paddingRight) || 0) + 1;
    let lineText = '', yy = r.top - oy + (parseFloat(cs.paddingTop) || 0) + lh / 2;
    for (const word of el.textContent.trim().split(/\s+/)) {
      const probe = lineText ? lineText + ' ' + word : word;
      if (lineText && ctx.measureText(probe).width > maxW) {
        ctx.fillText(lineText, r.left - ox + padL, yy);
        lineText = word; yy += lh;
      } else lineText = probe;
    }
    ctx.fillText(lineText, r.left - ox + padL, yy);
  }

  async function png(container, filename) {
    const box = container.getBoundingClientRect(), pad = 16, k = 2;
    const canvas = document.createElement('canvas');
    canvas.width = (box.width + pad * 2) * k;
    canvas.height = (box.height + pad * 2) * k;
    const ctx = canvas.getContext('2d');
    ctx.scale(k, k);
    ctx.fillStyle = css('--page');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const ox = box.left - pad, oy = box.top - pad;
    const cards = [container, ...container.querySelectorAll('.chart, .kpi')]
      .filter(el => el.matches('.chart, .kpi'));
    for (const el of cards) {
      const r = el.getBoundingClientRect();
      ctx.beginPath();
      ctx.roundRect(r.left - ox, r.top - oy, r.width, r.height, 10);
      ctx.fillStyle = css('--surface'); ctx.fill();
      ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1; ctx.stroke();
    }
    for (const svg of container.querySelectorAll('svg')) {
      const [img, r] = await svgImage(svg);
      ctx.drawImage(img, r.left - ox, r.top - oy, r.width, r.height);
    }
    for (const el of container.querySelectorAll('.pt')) wrapText(ctx, el, ox, oy);
    const blob = await new Promise(ok => canvas.toBlob(ok, 'image/png'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---- общая подсказка ---- */
  document.addEventListener('mousemove', e => {
    const tip = document.getElementById('tip');
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.getAttribute('data-tip');
    tip.hidden = false;
    const w = tip.offsetWidth, hgt = tip.offsetHeight;
    tip.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + 'px';
    tip.style.top = (e.clientY + 16 + hgt > innerHeight ? e.clientY - hgt - 10 : e.clientY + 16) + 'px';
  });

  return { line, bars, heat, spark, png };
})();
