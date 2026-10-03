'use strict';
/* Интерфейс. Все расчёты выполняет сервер; здесь только ввод и отображение фактов. */

const S = {
  user: null, meta: null, company: null, fin: null, runs: [], run: null, preview: null,
  sel: null, basis: 'mean', versionId: null, checkResult: null,
  reportYear: null, open: new Set(),
  dash: { year: null, group: '', hidden: new Set(), industry: null, size: null },
  ref: { tab: 'bench', version: null, industry: null, size: null, rows: [], changes: {} },
};

const POS = { above: 'выше', below: 'ниже', in_range: 'в диапазоне' };
const DIR = { up: '↗ рост', down: '↘ падение', stable: '→ стабильность', unstable: '⇅ нестабильность' };
const BASIS = { mean: 'среднее', median: 'медиана' };
const KPI_IDS = ['revenue', 'net_profit', 'ros', 'cur_liq', 'debt_ebitda'];

/* ---------- утилиты ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter(k => k != null && k !== false));
  if (value !== undefined) el.value = value;
  return el;
}
const opt = (value, text) => h('option', { value }, text);
const field = (label, control) => h('label', { class: 'f' }, label, control);

const nfCache = {};
function nf(min, max) {
  return nfCache[min + '-' + max] ||= new Intl.NumberFormat('ru-RU', { minimumFractionDigits: min, maximumFractionDigits: max });
}
const num = (v, d = 2) => v == null ? '—' : nf(d, d).format(v).replace('-', '−');
function val(unit, v, axis) {
  if (v == null) return '—';
  if (axis) return nf(0, 2).format(v).replace('-', '−') + (unit === 'pct' ? ' %' : '');
  if (unit === 'money') return num(v, 0);
  if (unit === 'pct') return num(v, 1) + ' %';
  return num(v, 2);
}
const signed = (v, d = 1, suffix = '') => v == null ? '—' : (v > 0 ? '+' : '') + num(v, d) + suffix;
const absDev = (unit, v) => v == null ? '—' : unit === 'pct' ? signed(v, 1, ' п.п.') : signed(v, unit === 'money' ? 0 : 2);
function parseNum(text) {
  const s = String(text).replace(/[\s ]/g, '').replace('−', '-').replace(',', '.');
  if (s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}
const plain = v => v == null ? '' : String(v).replace('.', ',');

function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 3000);
}

async function api(method, url, body) {
  const init = { method, headers: {} };
  if (method !== 'GET') {
    init.headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
    init.body = JSON.stringify(body || {});
  }
  const r = await fetch(url, init);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') {
    S.user = null;
    render();
  }
  if (!r.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}
const act = fn => async (...a) => {
  try { await fn(...a); } catch (e) { toast(e.message, true); }
};
const canWrite = () => ['admin', 'analyst'].includes(S.user.role);
const canRef = () => ['admin', 'maintainer'].includes(S.user.role);
const seesLog = canRef;

function fileB64(file) {
  return new Promise((ok, fail) => {
    const fr = new FileReader();
    fr.onload = () => ok(fr.result.split(',')[1]);
    fr.onerror = fail;
    fr.readAsDataURL(file);
  });
}
function filePicker(accept, onFile) {
  const input = h('input', { type: 'file', accept, hidden: true, onchange: act(async () => {
    if (input.files[0]) await onFile(input.files[0]);
    input.value = '';
  }) });
  return input;
}
const indMeta = id => S.meta.indicators.find(i => i.id === id);
const nameOf = (list, code) => (list.find(x => x.code === code) || {}).name || code;
const moneyUnit = t => `${t.unit} ${t.currency}`;
const unitText = (ind, t) => ind.unit === 'money' ? moneyUnit(t) : S.meta.units[ind.unit];

/* ---------- маршрутизация ---------- */
const route = () => (location.hash.replace(/^#\/?/, '') || 'companies').split('/');
const go = hash => { location.hash = hash; };
window.addEventListener('hashchange', () => render());

async function boot() {
  try {
    S.user = await api('GET', '/api/me');
    S.meta = await api('GET', '/api/meta');
  } catch (e) { S.user = null; }
  render();
}

async function render() {
  const app = document.getElementById('app');
  if (!S.user) { app.replaceChildren(loginView()); return; }
  const r = route();
  const main = h('main', { class: 'main' });
  app.replaceChildren(h('div', { class: 'shell' }, sidebar(r[0]), main));
  try {
    const view = { companies: companiesView, company: companyView, refs: refsView,
      users: usersView, audit: auditView }[r[0]] || companiesView;
    main.replaceChildren(...[await view(r)].flat());
  } catch (e) {
    main.replaceChildren(h('div', { class: 'note' }, e.message));
  }
}

function sidebar(active) {
  const link = (key, text) => h('a', { class: 'nav' + (active === key || (key === 'companies' && active === 'company') ? ' on' : ''), href: '#/' + key }, text);
  return h('nav', { class: 'side' },
    h('div', { class: 'brand' }, 'Отраслевой аналитический конструктор'),
    link('companies', 'Предприятия'),
    link('refs', 'Справочники'),
    S.user.role === 'admin' && link('users', 'Пользователи'),
    seesLog() && link('audit', 'Журнал и копии'),
    h('div', { class: 'who' },
      h('div', {}, h('b', {}, S.user.name)),
      h('div', { class: 'muted' }, S.user.role_name),
      h('div', { style: 'margin-top:6px; display:flex; gap:10px' },
        h('button', { class: 'link', onclick: passwordDialog }, 'Пароль'),
        h('button', { class: 'link', onclick: act(async () => {
          await api('POST', '/api/logout');
          S.user = null; S.company = null; render();
        }) }, 'Выйти'))));
}

function loginView() {
  const login = h('input', { autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  return h('div', { class: 'login' },
    h('h1', {}, 'Отраслевой аналитический конструктор'),
    h('p', { class: 'muted' }, 'Показатели предприятия, сравнение с отраслью, динамика.'),
    h('form', { class: 'card', onsubmit: act(async e => {
      e.preventDefault();
      S.user = await api('POST', '/api/login', { login: login.value, password: pass.value });
      S.meta = await api('GET', '/api/meta');
      render();
    }) }, field('Логин', login), field('Пароль', pass), h('button', { class: 'primary' }, 'Войти')));
}

function passwordDialog() {
  const oldP = h('input', { type: 'password', autocomplete: 'current-password' });
  const newP = h('input', { type: 'password', autocomplete: 'new-password' });
  const dlg = h('dialog', {},
    h('h3', {}, 'Смена пароля'),
    h('div', { style: 'display:grid; gap:10px' }, field('Текущий пароль', oldP), field('Новый пароль (от 8 символов)', newP)),
    h('div', { class: 'bar' },
      h('button', { class: 'primary', onclick: act(async () => {
        await api('POST', '/api/me/password', { old: oldP.value, new: newP.value });
        dlg.close(); toast('Пароль изменён');
      }) }, 'Сохранить'),
      h('button', { onclick: () => dlg.close() }, 'Отмена')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/* ---------- список предприятий ---------- */
async function companiesView() {
  const list = await api('GET', '/api/companies');
  return [
    h('h1', {}, 'Предприятия'),
    h('div', { class: 'bar' },
      canWrite() && h('button', { class: 'primary', onclick: () => go('#/company/new/card') }, 'Новое предприятие')),
    h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Наименование', 'ИНН', 'ОКВЭД', 'Отрасль', 'Размер бизнеса', 'Период'].map(t => h('th', {}, t)))),
      h('tbody', {}, list.length ? list.map(c => h('tr', { class: 'click', onclick: () => go(`#/company/${c.id}/dashboard`) },
        h('td', {}, h('a', { href: `#/company/${c.id}/dashboard` }, c.name)),
        h('td', { class: 'num' }, c.inn), h('td', {}, c.okved),
        h('td', {}, nameOf(S.meta.industries, c.industry_code)),
        h('td', {}, nameOf(S.meta.sizes, c.size_code)),
        h('td', {}, `${c.year_from}–${c.year_to}`)))
        : h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'Предприятий пока нет'))))),
  ];
}

/* ---------- рабочее место предприятия ---------- */
const TABS = [['card', 'Карточка'], ['balance', 'Баланс'], ['pnl', 'Финансовые результаты'],
  ['extra', 'Доп. данные'], ['calc', 'Расчёт'], ['report', 'Отчёт'], ['dashboard', 'Дашборд'], ['history', 'История']];

async function loadCompany(id) {
  if (S.company && String(S.company.id) === String(id)) return;
  S.company = await api('GET', `/api/companies/${id}`);
  S.fin = await api('GET', `/api/companies/${id}/financials`);
  S.runs = await api('GET', `/api/companies/${id}/runs`);
  S.run = S.runs.length ? await api('GET', `/api/runs/${S.runs[0].id}`) : null;
  S.preview = null; S.checkResult = null; S.sel = null; S.open = new Set(); S.reportYear = null;
  S.dash = { year: null, group: '', hidden: new Set(), industry: null, size: null };
}

async function companyView(r) {
  const [, id, tab = 'card'] = r;
  if (id === 'new') {
    S.company = null;
    return [h('h1', {}, 'Новое предприятие'), cardTab(null)];
  }
  await loadCompany(id);
  const c = S.company;
  const body = { card: cardTab, balance: () => gridTab('balance'), pnl: () => gridTab('pnl'),
    extra: extraTab, calc: calcTab, report: reportTab, dashboard: dashboardTab, history: historyTab }[tab] || cardTab;
  return [
    h('div', { class: 'no-print' }, h('a', { href: '#/companies', class: 'small' }, '← Все предприятия')),
    h('h1', { class: 'no-print' }, c.name),
    h('div', { class: 'muted no-print' }, `ИНН ${c.inn} · ОКВЭД ${c.okved} · ${nameOf(S.meta.industries, c.industry_code)} · ${nameOf(S.meta.sizes, c.size_code)} · ${c.year_from}–${c.year_to}`),
    h('div', { class: 'tabs' }, TABS.map(([k, t]) => h('a', { href: `#/company/${c.id}/${k}`, class: k === tab ? 'on' : '' }, t))),
    body(c),
  ];
}

function cardTab(c) {
  const d = c || { name: '', inn: '', okved: '', industry_code: S.meta.industries[0]?.code, size_code: 'small',
    region: '', year_from: new Date().getFullYear() - 3, year_to: new Date().getFullYear() - 1, currency: 'RUB', unit: 'тыс.' };
  const ro = !canWrite();
  const f = {
    name: h('input', { value: d.name, disabled: ro, required: true }),
    inn: h('input', { value: d.inn, disabled: ro, inputmode: 'numeric', maxlength: 12 }),
    okved: h('input', { value: d.okved, disabled: ro, list: 'okved-list', placeholder: '46.73' }),
    industry_code: h('select', { value: d.industry_code, disabled: ro }, S.meta.industries.map(i => opt(i.code, i.name))),
    size_code: h('select', { value: d.size_code, disabled: ro }, S.meta.sizes.map(i => opt(i.code, i.name))),
    region: h('input', { value: d.region || '', disabled: ro }),
    year_from: h('input', { type: 'number', value: d.year_from, disabled: ro, min: 1990, max: 2100 }),
    year_to: h('input', { type: 'number', value: d.year_to, disabled: ro, min: 1990, max: 2100 }),
    currency: h('select', { value: d.currency, disabled: ro }, ['RUB', 'USD', 'EUR', 'CNY', 'KZT', 'BYN'].map(x => opt(x, x))),
    unit: h('select', { value: d.unit, disabled: ro }, ['руб.', 'тыс.', 'млн'].map(x => opt(x, x))),
  };
  f.okved.addEventListener('change', () => {
    const hit = S.meta.okved.filter(o => f.okved.value.startsWith(o.code)).sort((a, b) => b.code.length - a.code.length)[0];
    if (hit) f.industry_code.value = hit.industry_code;
  });
  const save = act(async e => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
    body.custom_bench = c ? c.custom_bench : {};
    const saved = c ? await api('PUT', `/api/companies/${c.id}`, body) : await api('POST', '/api/companies', body);
    S.company = null;
    toast('Карточка сохранена');
    if (c) render(); else go(`#/company/${saved.id}/balance`);
  });
  return h('form', { onsubmit: save },
    h('datalist', { id: 'okved-list' }, S.meta.okved.map(o => opt(o.code, o.name))),
    h('div', { class: 'form', style: 'margin-top:16px' },
      field('Наименование', f.name), field('ИНН (10 или 12 цифр)', f.inn),
      field('Основной ОКВЭД', f.okved), field('Отрасль', f.industry_code),
      field('Размер бизнеса', f.size_code), field('Регион', f.region),
      field('Период анализа: с года', f.year_from), field('по год', f.year_to),
      field('Валюта', f.currency), field('Единицы измерения', f.unit)),
    h('div', { class: 'bar' },
      !ro && h('button', { class: 'primary' }, 'Сохранить'),
      c && S.user.role === 'admin' && h('button', { type: 'button', class: 'danger', onclick: act(async () => {
        if (!confirm(`Удалить предприятие «${c.name}» со всеми данными и расчётами? Перед удалением будет создана резервная копия базы.`)) return;
        await api('DELETE', `/api/companies/${c.id}`);
        S.company = null; go('#/companies');
      }) }, 'Удалить предприятие')));
}

/* ---- ввод отчётности ---- */
function derive(data) {
  const out = { ...data };
  for (const key of ['balance', 'pnl']) {
    const lines = S.meta.forms[key].flatMap(s => s.lines);
    if (!lines.some(l => out[l.code] != null)) continue;
    for (const l of lines) if (!l.total && out[l.code] == null) out[l.code] = 0;
    for (const l of lines) if (l.total && out[l.code] == null) {
      out[l.code] = l.formula.reduce((a, [sg, code]) => a + sg * (out[code] ?? NaN), 0);
      if (Number.isNaN(out[l.code])) out[l.code] = null;
    }
  }
  return out;
}

function gridTab(formKey) {
  const c = S.company, years = c.years, ro = !canWrite();
  const sections = S.meta.forms[formKey];
  const inputs = [];
  const status = h('div', {});
  let row = 0;

  function refresh() {
    const msgs = [];
    for (const y of years) {
      const raw = S.fin[y] || {}, calc = derive(Object.fromEntries(Object.entries(raw).filter(([k]) => {
        const l = sections.flatMap(s => s.lines).find(x => x.code === k);
        return !(l && l.total);
      })));
      for (const inp of inputs.filter(i => i.dataset.year == y && i.dataset.total)) {
        const d = calc[inp.dataset.code];
        inp.placeholder = d == null ? '' : num(d, 0);
        const own = raw[inp.dataset.code];
        const bad = own != null && d != null && Math.abs(own - d) > 0.5;
        inp.classList.toggle('bad', bad);
        inp.title = bad ? `Сумма составляющих строк: ${num(d, 0)}` : 'Оставьте пустым — итог рассчитается автоматически';
      }
      if (formKey === 'balance') {
        const full = derive(raw);
        if (full['1600'] != null && full['1700'] != null && Math.abs(full['1600'] - full['1700']) > 0.5) {
          msgs.push(`${y}: актив (${num(full['1600'], 0)}) не равен пассиву (${num(full['1700'], 0)}), разница ${num(full['1600'] - full['1700'], 0)}`);
        }
      }
    }
    status.replaceChildren(msgs.length ? h('div', { class: 'note' }, 'Баланс не сходится:', h('ul', {}, msgs.map(m => h('li', {}, m)))) : '');
  }

  function cell(line, y, r, col) {
    const v = (S.fin[y] || {})[line.code];
    const inp = h('input', { value: v == null ? '' : num(v, Number.isInteger(v) ? 0 : 2), disabled: ro, inputmode: 'decimal',
      'data-year': y, 'data-code': line.code, 'data-total': line.total ? 1 : null, 'data-r': r, 'data-c': col,
      'aria-label': `${line.name}, ${y}` });
    inp.addEventListener('focus', () => { const cur = (S.fin[y] || {})[line.code]; inp.value = plain(cur); inp.select(); });
    inp.addEventListener('input', () => {
      const p = parseNum(inp.value);
      inp.classList.toggle('bad', Number.isNaN(p));
      if (Number.isNaN(p)) return;
      (S.fin[y] ||= {})[line.code] = p;
      if (p == null) delete S.fin[y][line.code];
      refresh();
    });
    inp.addEventListener('blur', () => {
      const cur = (S.fin[y] || {})[line.code];
      if (!Number.isNaN(parseNum(inp.value))) inp.value = cur == null ? '' : num(cur, Number.isInteger(cur) ? 0 : 2);
    });
    inputs.push(inp);
    return h('td', { class: 'num' }, inp);
  }

  const at = (r, col) => inputs.find(i => i.dataset.r == r && i.dataset.c == col);
  const tbody = h('tbody', {
    onkeydown: e => {
      const t = e.target;
      if (t.tagName !== 'INPUT') return;
      const step = e.key === 'ArrowDown' || e.key === 'Enter' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      at(+t.dataset.r + step, t.dataset.c)?.focus();
    },
    onpaste: e => {
      const t = e.target, text = e.clipboardData.getData('text');
      if (t.tagName !== 'INPUT' || !/[\t\n]/.test(text.trim())) return;
      e.preventDefault();
      text.replace(/\r/g, '').split('\n').forEach((ln, i) => ln.split('\t').forEach((cellText, j) => {
        const target = at(+t.dataset.r + i, +t.dataset.c + j), p = parseNum(cellText.replace(/[()]/g, ''));
        if (!target || p == null || Number.isNaN(p)) return;
        (S.fin[target.dataset.year] ||= {})[target.dataset.code] = p;
        target.value = num(p, Number.isInteger(p) ? 0 : 2);
      }));
      refresh();
    },
  });
  for (const sec of sections) {
    tbody.append(h('tr', { class: 'grp' }, h('td', { colspan: 2 + years.length }, sec.section)));
    for (const line of sec.lines) {
      const r = row++;
      tbody.append(h('tr', { class: line.total ? 'tot' : '' },
        h('td', { class: 'code' }, /^\d+$/.test(line.code) ? line.code : ''), h('td', {}, line.name),
        years.map((y, col) => cell(line, y, r, col))));
    }
  }
  refresh();

  const importer = filePicker('.xlsx,.csv', async file => {
    const res = await api('POST', `/api/companies/${c.id}/import`, { filename: file.name, file_b64: await fileB64(file) });
    S.fin = res.financials;
    toast(`Импортировано строк: ${res.recognized}` + (res.skipped_years.length ? `. Годы вне периода пропущены: ${res.skipped_years.join(', ')}` : ''));
    render();
  });
  return h('div', {},
    h('div', { class: 'bar' },
      !ro && h('button', { class: 'primary', onclick: act(async () => {
        if (inputs.some(i => Number.isNaN(parseNum(i.value)))) throw new Error('В выделенных ячейках не число');
        S.fin = await api('PUT', `/api/companies/${c.id}/financials`, S.fin);
        toast('Данные сохранены');
      }) }, 'Сохранить'),
      !ro && h('button', { onclick: () => importer.click() }, 'Импорт из Excel / CSV'), importer,
      h('a', { class: 'btn', href: `/api/companies/${c.id}/source.xlsx` }, 'Шаблон / выгрузка Excel'),
      h('a', { class: 'btn', href: `/api/companies/${c.id}/source.csv` }, 'Исходные данные CSV'),
      h('span', { class: 'sp' }),
      h('span', { class: 'muted small' }, formKey === 'extra' ? '' : `Единицы: ${c.unit} ${c.currency}. Расходы вводятся положительными числами.`)),
    status,
    h('div', { class: 'tw' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Код'), h('th', {}, 'Статья'), years.map(y => h('th', { class: 'num' }, y)))),
      tbody)),
    h('p', { class: 'muted small', style: 'margin-top:8px' },
      'Можно вставлять диапазон ячеек из Excel (Ctrl/Cmd+V) — значения заполнятся вправо и вниз от выбранной ячейки. Enter и стрелки ↑↓ перемещают по столбцу. Пустые итоги рассчитываются автоматически.'));
}

function extraTab(c) {
  const ro = !canWrite();
  const cb = structuredClone(c.custom_bench || {});
  const rows = S.meta.indicators.filter(i => i.group !== 'abs').map(ind => h('tr', {},
    h('td', {}, ind.name), h('td', { class: 'muted' }, S.meta.units[ind.unit]),
    ['mean', 'median', 'low', 'high'].map(k => h('td', { class: 'num' }, h('input', {
      value: plain((cb[ind.id] || {})[k]), disabled: ro, inputmode: 'decimal', 'aria-label': `${ind.name}: ${k}`,
      oninput: e => { (cb[ind.id] ||= {})[k] = e.target.value; } })))));
  return h('div', {},
    gridTab('extra'),
    h('h2', {}, 'Собственные отраслевые значения'),
    h('p', { class: 'muted' }, 'Используются только для тех показателей, по которым в справочнике нет значений для отрасли и размера бизнеса предприятия. В отчёте такие значения помечаются «введено пользователем».'),
    h('div', { class: 'tw' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Показатель', 'Ед.', 'Среднее', 'Медиана', 'Норма: от', 'Норма: до'].map((t, i) => h('th', { class: i > 1 ? 'num' : '' }, t)))),
      h('tbody', {}, rows))),
    !ro && h('div', { class: 'bar' }, h('button', { class: 'primary', onclick: act(async () => {
      S.company = await api('PUT', `/api/companies/${c.id}`, { ...c, custom_bench: cb });
      toast('Отраслевые значения сохранены');
    }) }, 'Сохранить отраслевые значения')));
}

/* ---- расчёт ---- */
function calcTab(c) {
  const all = S.meta.indicators.filter(i => i.group !== 'abs');
  S.sel ||= new Set(S.run ? S.run.indicators.map(i => i.id) : all.map(i => i.id));
  S.versionId ||= S.meta.versions[0].id;
  const boxes = {};
  const setSel = ids => { S.sel = new Set(ids); for (const [id, b] of Object.entries(boxes)) b.checked = S.sel.has(id); };
  const params = () => ({ indicators: [...S.sel], basis: S.basis, version_id: S.versionId });
  const out = h('div', {});
  const showCheck = res => {
    const ok = !res.missing.length && !res.warnings.length;
    out.replaceChildren(h('div', { class: 'note' },
      ok ? 'Данные заполнены полностью, итоги сходятся.' : [
        res.missing.length ? ['Не хватает данных:', h('ul', {}, res.missing.map(m => h('li', {}, m)))] : null,
        res.warnings.length ? ['Замечания (расчёту не препятствуют):', h('ul', {}, res.warnings.map(m => h('li', {}, m)))] : null,
      ]));
  };
  return h('div', {},
    h('div', { class: 'bar' },
      field('База сравнения', h('select', { value: S.basis, onchange: e => { S.basis = e.target.value; } }, opt('mean', 'Среднее по отрасли'), opt('median', 'Медиана по отрасли'))),
      field('Версия справочника', h('select', { value: S.versionId, onchange: e => { S.versionId = +e.target.value; } }, S.meta.versions.map(v => opt(v.id, v.label)))),
      h('button', { onclick: () => setSel(all.filter(i => i.mvp).map(i => i.id)) }, 'Базовый набор'),
      h('button', { onclick: () => setSel(all.map(i => i.id)) }, 'Все показатели')),
    h('div', { class: 'checks card' }, S.meta.groups.filter(g => g[0] !== 'abs').map(([g, title]) => h('div', {},
      h('h3', {}, title),
      all.filter(i => i.group === g).map(i => h('label', {},
        boxes[i.id] = h('input', { type: 'checkbox', checked: S.sel.has(i.id), onchange: e => { e.target.checked ? S.sel.add(i.id) : S.sel.delete(i.id); } }),
        ' ' + i.name, h('div', { class: 'muted small formula', style: 'margin-left:22px' }, i.formula)))))),
    h('p', { class: 'muted small', style: 'margin-top:8px' }, 'Выручка и чистая прибыль включаются в отчёт всегда.'),
    h('div', { class: 'bar' },
      h('button', { onclick: act(async () => showCheck(await api('POST', `/api/companies/${c.id}/preview`, params()))) }, 'Проверить полноту данных'),
      canWrite() && h('button', { class: 'primary', onclick: act(async () => {
        S.run = await api('POST', `/api/companies/${c.id}/runs`, params());
        S.runs = await api('GET', `/api/companies/${c.id}/runs`);
        S.preview = null; S.dash.industry = S.dash.size = null;
        toast('Расчёт выполнен и сохранён в истории');
        go(`#/company/${c.id}/report`);
      }) }, 'Рассчитать и сформировать отчёт')),
    out,
    factsNote());
}

const factsNote = () => h('p', { class: 'facts' },
  'Система показывает факты, отклонения и динамику. Она не даёт рекомендаций и прогнозов и не оценивает, «хорошо» это или «плохо» — вывод делает человек.');

/* ---- отчёт ---- */
function noRun(c) {
  return h('div', { class: 'note' }, 'Расчётов по предприятию ещё нет. ',
    canWrite() ? h('a', { href: `#/company/${c.id}/calc` }, 'Перейти к расчёту') : 'Расчёт выполняет аналитик.');
}
const posCell = cm => h('td', {}, cm ? h('span', { class: 'pos ' + cm.position }, POS[cm.position]) : h('span', { class: 'muted' }, 'нет данных'));
const grouped = (run, fn, cols) => S.meta.groups.flatMap(([g, title]) => {
  const items = run.indicators.filter(i => i.group === g);
  return items.length ? [h('tr', { class: 'grp' }, h('td', { colspan: cols }, title)), ...items.flatMap(fn)] : [];
});

function drill(ind, run, cols) {
  const ys = run.years.map(String), t = run.title, tr = ind.trend;
  const yearRow = (label, fn, cls = 'num') => h('tr', {}, h('td', {}, label), ys.map(y => h('td', { class: cls }, fn(ind.years[y], y))));
  const notes = [...new Set(ys.flatMap(y => ind.years[y].notes.map(n => `${y}: ${n}`)))];
  return h('tr', { class: 'drill' }, h('td', { colspan: cols }, h('div', { class: 'inner' },
    h('div', {},
      h('h3', {}, 'Формула'), h('p', { class: 'formula' }, `${ind.name} = ${ind.formula}`),
      h('h3', {}, 'Исходные строки отчётности' + (ind.unit !== 'money' ? `, ${moneyUnit(t)}` : '')),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Строка'), ys.map(y => h('th', { class: 'num' }, y)))),
        h('tbody', {}, ind.lines.map(l => h('tr', {}, h('td', {}, (/^\d+$/.test(l.code) ? l.code + ' ' : '') + l.name),
          ys.map(y => h('td', { class: 'num' }, num(l.values[y], 0)))))))),
    h('div', {},
      h('h3', {}, 'Расчёт и сравнение по годам'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, ''), ys.map(y => h('th', { class: 'num' }, y)))),
        h('tbody', {},
          yearRow(`Числитель: ${ind.num_label}`, r => num(r.num, 0)),
          ind.den_label && yearRow(`Знаменатель: ${ind.den_label}`, r => num(r.den, 0)),
          yearRow(`Значение, ${unitText(ind, t) || '—'}`, r => val(ind.unit, r.value)),
          ind.group !== 'abs' && [
            yearRow(`Отрасль (${BASIS[run.basis]})`, r => r.compare ? val(ind.unit, r.compare.base) : '—'),
            yearRow('Отклонение', r => r.compare ? absDev(ind.unit, r.compare.abs_dev) : '—'),
            yearRow('Отклонение, %', r => r.compare ? signed(r.compare.pct_dev, 1, ' %') : '—'),
            h('tr', {}, h('td', {}, 'Положение'), ys.map(y => posCell(ind.years[y].compare))),
          ])),
      h('p', { style: 'margin-top:10px' }, h('b', {}, 'Тренд: '), DIR[tr.direction] || 'нет данных',
        tr.cagr != null ? ` · среднегодовой темп ${signed(tr.cagr, 1, ' %')}` : '',
        tr.avg_abs != null ? ` · среднегодовое изменение ${absDev(ind.unit, tr.avg_abs)}` : ''),
      tr.steps.length ? h('p', { class: 'muted small' }, tr.steps.map(s => `${s.from}→${s.to}: ${absDev(ind.unit, s.abs)}${s.pct != null ? ` (${signed(s.pct, 1, ' %')})` : ''}`).join('; ')) : null,
      notes.length ? h('p', { class: 'muted small' }, notes.join('. ')) : null,
      ind.bench && h('p', { class: 'muted small' }, `Источник отраслевых значений: ${ind.bench.source}.`)))));
}

function reportTab(c) {
  const run = S.run;
  if (!run) return noRun(c);
  const t = run.title, years = run.years, ys = years.map(String);
  S.reportYear ||= ys[ys.length - 1];
  const Y = S.reportYear;
  const cols1 = 4 + years.length;
  const toggle = id => { S.open.has(id) ? S.open.delete(id) : S.open.add(id); render(); };
  const row1 = ind => [
    h('tr', { class: 'click', onclick: () => toggle(ind.id), title: 'Показать формулу и расчёт' },
      h('td', {}, (S.open.has(ind.id) ? '▾ ' : '▸ ') + ind.name), h('td', { class: 'muted' }, unitText(ind, t)),
      ys.map(y => h('td', { class: 'num' }, val(ind.unit, ind.years[y].value))),
      h('td', { class: 'num' }, absDev(ind.unit, ind.trend.change_abs)),
      h('td', { class: 'num' }, signed(ind.trend.change_pct, 1, ' %'))),
    S.open.has(ind.id) ? drill(ind, run, cols1) : null];
  const cmp = run.indicators.filter(i => i.group !== 'abs');
  const row2 = ind => {
    const r = ind.years[Y], cm = r.compare, b = ind.bench || {};
    return h('tr', {}, h('td', {}, ind.name),
      h('td', { class: 'num' }, val(ind.unit, r.value)),
      h('td', { class: 'num' }, val(ind.unit, b.mean)), h('td', { class: 'num' }, val(ind.unit, b.median)),
      h('td', { class: 'num' }, b.low != null && b.high != null ? `${val(ind.unit, b.low)} – ${val(ind.unit, b.high)}` : '—'),
      h('td', { class: 'num' }, cm ? absDev(ind.unit, cm.abs_dev) : '—'),
      h('td', { class: 'num' }, cm ? signed(cm.pct_dev, 1, ' %') : '—'), posCell(cm));
  };
  const row3 = ind => h('tr', {}, h('td', {}, ind.name), h('td', { class: 'muted' }, unitText(ind, t)),
    ys.map(y => h('td', { class: 'num' }, val(ind.unit, ind.years[y].value))),
    h('td', {}, DIR[ind.trend.direction] || h('span', { class: 'muted' }, 'нет данных')),
    h('td', { class: 'num' }, ind.trend.cagr != null ? signed(ind.trend.cagr, 1, ' %') : '—'),
    h('td', { class: 'num' }, absDev(ind.unit, ind.trend.avg_abs)));

  return h('div', { class: 'report' },
    h('div', { class: 'bar' },
      field('Расчёт', h('select', { value: run.run_id, onchange: act(async e => { S.run = await api('GET', `/api/runs/${e.target.value}`); S.reportYear = null; S.preview = null; render(); }) },
        S.runs.map(r => opt(r.id, `№ ${r.id} от ${r.created_at.replace('T', ' ')}`)))),
      h('span', { class: 'sp' }),
      h('button', { onclick: () => { const old = document.title; document.title = `Отчёт — ${t.company}`; window.print(); document.title = old; } }, 'PDF (печать)'),
      h('a', { class: 'btn', href: `/api/runs/${run.run_id}/export.xlsx` }, 'Excel'),
      h('a', { class: 'btn', href: `/api/companies/${c.id}/source.csv` }, 'CSV (исходные данные)')),
    h('div', { class: 'card' },
      h('h1', {}, 'Сводный аналитический отчёт'),
      h('dl', { class: 'title', style: 'margin-top:10px' }, [
        ['Предприятие', t.company], ['ИНН', t.inn], ['ОКВЭД', t.okved], ['Отрасль', t.industry],
        ['Размер бизнеса', t.size], ['Период анализа', t.period], ['Единицы измерения', moneyUnit(t)],
        ['База сравнения', `${t.bench_industry} / ${t.bench_size} (${BASIS[t.basis]})`],
        ['Дата формирования', t.generated_at.replace('T', ' ')], ['Версия справочников', t.ref_version],
        ['Версия расчётного модуля', t.engine_version],
      ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
    run.warnings.length ? h('div', { class: 'note' }, 'Замечания к исходным данным:', h('ul', {}, run.warnings.map(w => h('li', {}, w)))) : null,

    h('h2', {}, '1. Показатели предприятия'),
    h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Показатель'), h('th', {}, 'Ед.'), ys.map(y => h('th', { class: 'num' }, y)),
        h('th', { class: 'num' }, `Изменение ${ys[0]}→${ys[ys.length - 1]}`), h('th', { class: 'num' }, 'Изменение, %'))),
      h('tbody', {}, grouped(run, row1, cols1)))),
    h('p', { class: 'muted small no-print', style: 'margin-top:6px' }, 'Нажмите на строку, чтобы раскрыть формулу, исходные строки и промежуточные расчёты.'),

    h('h2', {}, '2. Сравнение с отраслью, ',
      h('select', { class: 'no-print', value: Y, 'aria-label': 'Год сравнения', onchange: e => { S.reportYear = e.target.value; render(); } }, ys.map(y => opt(y, y))),
      h('span', { class: 'print-only' }, ' ' + Y + ' г.')),
    h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Показатель', 'Предприятие', 'Среднее по отрасли', 'Медиана', 'Нормальный диапазон', 'Отклонение', 'Отклонение, %', 'Положение']
        .map((x, i) => h('th', { class: i && i < 7 ? 'num' : '' }, x)))),
      h('tbody', {}, grouped({ indicators: cmp }, row2, 8)))),
    h('p', { class: 'muted small', style: 'margin-top:6px' }, `Отклонение считается от базы сравнения (${BASIS[run.basis]}). Положение: «ниже» — меньше нижней границы диапазона, «выше» — больше верхней.`),

    h('h2', {}, '3. Динамика и тренды'),
    h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Показатель'), h('th', {}, 'Ед.'), ys.map(y => h('th', { class: 'num' }, y)),
        h('th', {}, 'Тренд'), h('th', { class: 'num' }, 'Среднегодовой темп'), h('th', { class: 'num' }, 'Среднегодовое изменение'))),
      h('tbody', {}, grouped(run, row3, cols1 + 1)))),
    h('p', { class: 'muted small', style: 'margin-top:6px' }, `Тренд: изменение год к году менее ${S.meta.stable_threshold * 100} % считается стабильностью; разнонаправленные изменения — нестабильностью. Среднегодовой темп (CAGR) рассчитывается, если первое и последнее значения положительны.`),

    h('h2', {}, '4. Графики динамики'),
    lineLegend(run), h('div', { class: 'charts' }, run.indicators.map(ind => lineCard(ind, run))),
    factsNote());
}

/* ---- графики ---- */
const lineLegend = run => h('div', { class: 'legend' },
  h('span', { class: 'pt' }, h('i', { style: 'background:var(--series-1)' }), 'Предприятие'),
  h('span', { class: 'pt' }, h('i', { style: 'background:var(--series-2)' }), `Отрасль (${BASIS[run.basis]})`));

function pngButton(card, name) {
  return h('button', { class: 'png no-print', title: 'Сохранить график в PNG', onclick: act(() => Charts.png(card, name + '.png')) }, 'PNG');
}
function chartCard(title, svg, file, cls = '') {
  const card = h('div', { class: 'chart ' + cls }, h('div', { class: 'ct pt' }, title), svg);
  card.append(pngButton(card, file));
  return card;
}
function benchBase(ind, run) {
  const b = ind.bench;
  if (!b) return null;
  return b[run.basis] ?? b.mean ?? b.median ?? null;
}
function lineCard(ind, run) {
  const ys = run.years.map(String), unit = unitText(ind, run.title);
  return chartCard(ind.name + (unit ? `, ${unit}` : ''), Charts.line({
    years: run.years, values: ys.map(y => ind.years[y].value), bench: benchBase(ind, run),
    name: ind.name, fmt: (v, axis) => val(ind.unit, v, axis) }), ind.id);
}

/* ---- дашборд ---- */
function dashboardTab(c) {
  if (!S.run) return noRun(c);
  const run = S.preview || S.run, t = run.title, ys = run.years.map(String);
  const D = S.dash;
  D.year ||= ys[ys.length - 1];
  D.industry ||= t.bench_industry_code; D.size ||= t.bench_size_code;
  const Y = D.year, prevY = ys[ys.indexOf(Y) - 1];
  const visible = run.indicators.filter(i => (!D.group || i.group === D.group) && !D.hidden.has(i.id));
  const cmp = visible.filter(i => i.group !== 'abs');

  const rebase = act(async () => {
    const same = D.industry === S.run.title.bench_industry_code && D.size === S.run.title.bench_size_code;
    S.preview = same ? null : await api('POST', `/api/companies/${c.id}/preview`, {
      indicators: S.run.indicators.map(i => i.id), basis: S.run.basis,
      version_id: S.run.title.ref_version_id, industry: D.industry, size: D.size });
    render();
  });

  const kpi = id => {
    const ind = run.indicators.find(i => i.id === id) || (id === 'debt_ebitda' && run.indicators.find(i => i.id === 'leverage'));
    if (!ind) return null;
    const cur = ind.years[Y], prev = prevY && ind.years[prevY];
    let delta = null;
    if (prev && cur.value != null && prev.value != null) {
      delta = ind.unit === 'money'
        ? (prev.value ? `к ${prevY}: ${signed((cur.value - prev.value) / Math.abs(prev.value) * 100, 1, ' %')}` : null)
        : `к ${prevY}: ${absDev(ind.unit, cur.value - prev.value)}`;
    }
    const cm = cur.compare;
    return h('div', { class: 'kpi' },
      h('div', { class: 'lbl pt' }, ind.name + (ind.unit === 'money' ? `, ${moneyUnit(t)}` : '')),
      h('div', { class: 'row' }, h('div', { class: 'val pt' }, val(ind.unit, cur.value)), Charts.spark(ys.map(y => ind.years[y].value))),
      h('div', { class: 'sub pt' }, delta || (prevY ? 'нет данных за предыдущий год' : 'первый год периода')),
      cm ? h('div', { class: 'sub pt' }, `отрасль: ${val(ind.unit, cm.base)} · ${POS[cm.position]}`) : null);
  };

  const barCards = S.meta.groups.filter(g => g[0] !== 'abs').map(([g, title]) => {
    const items = cmp.filter(i => i.group === g);
    if (!items.length) return null;
    const unit = items[0].unit;
    return chartCard(`${title}${S.meta.units[unit] ? ', ' + S.meta.units[unit] : ''}`, Charts.bars({
      label: `${title}: сравнение с отраслью, ${Y}`, fmt: v => val(unit, v),
      items: items.map(i => ({ name: i.name, value: i.years[Y].value, bench: benchBase(i, run),
        tip: `${i.name}, ${Y}\nПредприятие: ${val(i.unit, i.years[Y].value)}\nОтрасль (${BASIS[run.basis]}): ${val(i.unit, benchBase(i, run))}` +
          (i.years[Y].compare ? `\nОтклонение: ${absDev(i.unit, i.years[Y].compare.abs_dev)} (${signed(i.years[Y].compare.pct_dev, 1, ' %')})` : '') })) }), 'sravnenie-' + g);
  });

  const heat = cmp.length ? chartCard('Отклонение от отрасли, % от отраслевого значения', Charts.heat({
    years: run.years, fmtPct: p => signed(p, 0, ' %'),
    rows: cmp.map(i => ({ name: i.name, cells: ys.map(y => {
      const cm = i.years[y].compare;
      return { pct: cm ? cm.pct_dev : null, tip: cm
        ? `${i.name}, ${y}\nПредприятие: ${val(i.unit, i.years[y].value)}\nОтрасль: ${val(i.unit, cm.base)}\nОтклонение: ${absDev(i.unit, cm.abs_dev)} (${signed(cm.pct_dev, 1, ' %')})\nПоложение: ${POS[cm.position]}`
        : `${i.name}, ${y}: нет данных` };
    }) })) }), 'teplovaya-karta', 'wide') : null;

  const area = h('div', { id: 'dash-area' },
    h('div', { class: 'pt', style: 'font-weight:650; font-size:15px; margin-bottom:2px' }, `${t.company} — ${Y} год`),
    h('div', { class: 'pt muted small', style: 'margin-bottom:12px' }, `Сравнение: ${t.bench_industry} / ${t.bench_size} · ${t.ref_version}`),
    h('div', { class: 'kpis' }, KPI_IDS.map(kpi)),
    h('h2', { class: 'pt' }, 'Динамика показателей'),
    lineLegend(run),
    h('div', { class: 'charts' }, visible.map(i => lineCard(i, run))),
    cmp.length ? [h('h2', { class: 'pt' }, `Сравнение с отраслью, ${Y}`), lineLegend(run),
      h('div', { class: 'charts', style: 'grid-template-columns:repeat(auto-fill,minmax(400px,1fr))' }, barCards),
      h('h2', { class: 'pt' }, 'Тепловая карта отклонений'), h('div', { class: 'charts' }, heat)] : null);

  return h('div', {},
    h('div', { class: 'bar' },
      field('Год', h('select', { value: Y, onchange: e => { D.year = e.target.value; render(); } }, ys.map(y => opt(y, y)))),
      field('Группа показателей', h('select', { value: D.group, onchange: e => { D.group = e.target.value; render(); } },
        opt('', 'Все группы'), S.meta.groups.map(([g, n]) => opt(g, n)))),
      field('Отрасль для сравнения', h('select', { value: D.industry, onchange: e => { D.industry = e.target.value; rebase(); } }, S.meta.industries.map(i => opt(i.code, i.name)))),
      field('Размер бизнеса', h('select', { value: D.size, onchange: e => { D.size = e.target.value; rebase(); } }, S.meta.sizes.map(i => opt(i.code, i.name)))),
      h('span', { class: 'sp' }),
      h('button', { onclick: act(() => Charts.png(area, `dashboard-${t.inn}-${Y}.png`)) }, 'Экспорт PNG'),
      h('a', { class: 'btn', href: `/api/runs/${S.run.run_id}/export.xlsx` }, 'Excel'),
      h('a', { class: 'btn', href: `#/company/${c.id}/report` }, 'Отчёт / PDF')),
    h('details', { class: 'no-print', style: 'margin-bottom:12px' },
      h('summary', { class: 'small' }, `Показатели на дашборде (${visible.length} из ${run.indicators.length})`),
      h('div', { class: 'checks card', style: 'margin-top:8px' }, run.indicators.map(i => h('label', {},
        h('input', { type: 'checkbox', checked: !D.hidden.has(i.id), onchange: e => { e.target.checked ? D.hidden.delete(i.id) : D.hidden.add(i.id); render(); } }),
        ' ' + i.name)))),
    S.preview ? h('div', { class: 'note' }, 'База сравнения изменена фильтром: значения пересчитаны по текущим данным и в историю не сохраняются. Excel выгружает сохранённый расчёт.') : null,
    area, factsNote());
}

function historyTab(c) {
  return h('div', {},
    h('p', { class: 'muted', style: 'margin-top:12px' }, 'Каждый расчёт сохраняется вместе со снимком исходных данных, версией справочника и версией расчётного модуля.'),
    h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, ['№', 'Дата', 'Пользователь', 'Версия справочника', 'Расчётный модуль', 'База', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, S.runs.length ? S.runs.map(r => {
        const p = JSON.parse(r.params);
        return h('tr', {}, h('td', {}, r.id), h('td', {}, r.created_at.replace('T', ' ')), h('td', {}, r.user_login),
          h('td', {}, r.ref_version), h('td', {}, r.engine_version), h('td', {}, BASIS[p.basis]),
          h('td', {}, h('button', { class: 'link', onclick: act(async () => { S.run = await api('GET', `/api/runs/${r.id}`); S.preview = null; S.reportYear = null; go(`#/company/${c.id}/report`); }) }, 'Открыть отчёт')));
      }) : h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'Расчётов пока нет'))))));
}

/* ---------- справочники ---------- */
async function reloadMeta() { S.meta = await api('GET', '/api/meta'); }

async function refsView() {
  const R = S.ref, ro = !canRef();
  const tabs = [['bench', 'Отраслевые значения'], ['industries', 'Отрасли'], ['okved', 'ОКВЭД'], ['sizes', 'Размеры бизнеса']];
  const head = [h('h1', {}, 'Справочники'),
    h('div', { class: 'tabs' }, tabs.map(([k, t]) => h('a', { href: '#/refs', class: R.tab === k ? 'on' : '', onclick: e => { e.preventDefault(); R.tab = k; render(); } }, t)))];
  if (R.tab !== 'bench') return [...head, dictTab(R.tab, ro)];

  R.version ||= S.meta.versions[0].id; R.industry ||= S.meta.industries[0].code; R.size ||= S.meta.sizes[0].code;
  R.rows = await api('GET', `/api/ref/benchmarks?version=${R.version}&industry=${encodeURIComponent(R.industry)}&size=${encodeURIComponent(R.size)}`);
  const ver = S.meta.versions.find(v => v.id === R.version);
  const key = iid => `${R.industry}|${R.size}|${iid}`;
  const comment = h('input', { placeholder: 'Комментарий к версии (источник данных)', style: 'min-width:280px' });
  const counter = h('span', { class: 'muted small' }, `Изменено строк: ${Object.keys(R.changes).length}`);
  const importer = filePicker('.csv,.xlsx', async file => {
    await api('POST', '/api/ref/versions', { base_id: R.version, comment: comment.value || `Импорт ${file.name}`, filename: file.name, file_b64: await fileB64(file) });
    await reloadMeta(); R.version = S.meta.versions[0].id; R.changes = {};
    toast('Создана новая версия справочника'); render();
  });
  return [...head,
    h('div', { class: 'bar' },
      field('Версия', h('select', { value: R.version, onchange: e => { R.version = +e.target.value; R.changes = {}; render(); } }, S.meta.versions.map(v => opt(v.id, v.label)))),
      field('Отрасль', h('select', { value: R.industry, onchange: e => { R.industry = e.target.value; render(); } }, S.meta.industries.map(i => opt(i.code, i.name)))),
      field('Размер бизнеса', h('select', { value: R.size, onchange: e => { R.size = e.target.value; render(); } }, S.meta.sizes.map(i => opt(i.code, i.name)))),
      h('span', { class: 'sp' }),
      h('a', { class: 'btn', href: `/api/ref/benchmarks.csv?version=${R.version}` }, 'Выгрузить версию в CSV'),
      !ro && h('button', { onclick: () => importer.click() }, 'Загрузить CSV / Excel как новую версию'), importer),
    h('p', { class: 'muted small' }, `${ver.label} · создана ${ver.created_at.replace('T', ' ')} (${ver.created_by})${ver.comment ? ' · ' + ver.comment : ''}`),
    h('div', { class: 'tw' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Показатель', 'Ед.', 'Среднее', 'Медиана', 'Норма: от', 'Норма: до'].map((t, i) => h('th', { class: i > 1 ? 'num' : '' }, t)))),
      h('tbody', {}, S.meta.indicators.filter(i => i.group !== 'abs').map(ind => {
        const base = R.rows.find(r => r.indicator === ind.id) || {};
        const cur = R.changes[key(ind.id)] || base;
        return h('tr', {}, h('td', {}, ind.name), h('td', { class: 'muted' }, S.meta.units[ind.unit]),
          ['mean', 'median', 'low', 'high'].map(k => h('td', { class: 'num' }, h('input', {
            value: plain(cur[k]), disabled: ro, inputmode: 'decimal', 'aria-label': `${ind.name}: ${k}`,
            oninput: e => {
              const ch = R.changes[key(ind.id)] ||= { industry: R.industry, size: R.size, indicator: ind.id,
                mean: base.mean, median: base.median, low: base.low, high: base.high };
              ch[k] = e.target.value;
              counter.textContent = `Изменено строк: ${Object.keys(R.changes).length}`;
            } }))));
      })))),
    !ro && h('div', { class: 'bar' }, comment,
      h('button', { class: 'primary', onclick: act(async () => {
        await api('POST', '/api/ref/versions', { base_id: R.version, comment: comment.value, rows: Object.values(R.changes) });
        await reloadMeta(); R.version = S.meta.versions[0].id; R.changes = {};
        toast('Создана новая версия справочника'); render();
      }) }, 'Сохранить как новую версию'), counter),
    h('p', { class: 'facts' }, 'Версии справочника не изменяются задним числом: любое изменение создаёт новую версию, а ранее выполненные расчёты остаются привязаны к своей версии. Версия v1 содержит демонстрационные значения — перед рабочим использованием загрузите фактические отраслевые данные.')];
}

function dictTab(kind, ro) {
  const cols = { industries: [['code', 'Код'], ['name', 'Наименование']],
    sizes: [['code', 'Код'], ['name', 'Наименование'], ['sort', 'Порядок']],
    okved: [['code', 'Код ОКВЭД'], ['name', 'Наименование'], ['industry_code', 'Отрасль']] }[kind];
  const inputs = Object.fromEntries(cols.map(([k]) => [k, k === 'industry_code'
    ? h('select', {}, S.meta.industries.map(i => opt(i.code, i.name)))
    : h('input', { type: k === 'sort' ? 'number' : 'text', style: k === 'name' ? 'min-width:320px' : 'width:120px' })]));
  const save = act(async () => {
    await api('POST', `/api/ref/${kind}`, Object.fromEntries(cols.map(([k]) => [k, inputs[k].value])));
    await reloadMeta(); toast('Сохранено'); render();
  });
  return h('div', {},
    !ro && h('div', { class: 'bar' }, cols.map(([k, t]) => field(t, inputs[k])), h('button', { class: 'primary', onclick: save }, 'Добавить / обновить')),
    h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, cols.map(([, t]) => h('th', {}, t)), h('th', {}, ''))),
      h('tbody', {}, S.meta[kind].map(row => h('tr', {},
        cols.map(([k]) => h('td', {}, k === 'industry_code' ? nameOf(S.meta.industries, row[k]) : row[k])),
        h('td', {}, !ro && [
          h('button', { class: 'link', onclick: () => { for (const [k] of cols) inputs[k].value = row[k]; inputs.name.focus(); } }, 'Изменить'), ' · ',
          h('button', { class: 'link danger', onclick: act(async () => {
            if (!confirm(`Удалить «${row.name}»?`)) return;
            await api('DELETE', `/api/ref/${kind}/${encodeURIComponent(row.code)}`);
            await reloadMeta(); render();
          }) }, 'Удалить')])))))));
}

/* ---------- пользователи, журнал ---------- */
async function usersView() {
  const list = await api('GET', '/api/users');
  const f = { login: h('input', {}), name: h('input', {}), role: h('select', {}, Object.entries(S.meta.roles).map(([k, v]) => opt(k, v))),
    password: h('input', { type: 'password', autocomplete: 'new-password' }) };
  const update = (u, patch) => act(async () => { await api('PUT', `/api/users/${u.id}`, patch); toast('Сохранено'); render(); })();
  return [h('h1', {}, 'Пользователи и роли'),
    h('div', { class: 'bar' }, field('Логин', f.login), field('Имя', f.name), field('Роль', f.role), field('Пароль (от 8 символов)', f.password),
      h('button', { class: 'primary', onclick: act(async () => {
        await api('POST', '/api/users', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])));
        toast('Пользователь создан'); render();
      }) }, 'Добавить')),
    h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Логин', 'Имя', 'Роль', 'Доступ', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, list.map(u => h('tr', {}, h('td', {}, u.login), h('td', {}, u.name),
        h('td', {}, h('select', { value: u.role, 'aria-label': 'Роль', onchange: e => update(u, { role: e.target.value }) }, Object.entries(S.meta.roles).map(([k, v]) => opt(k, v)))),
        h('td', {}, u.active ? 'активен' : 'отключён'),
        h('td', {},
          h('button', { class: 'link', onclick: () => update(u, { active: !u.active }) }, u.active ? 'Отключить' : 'Включить'), ' · ',
          h('button', { class: 'link', onclick: () => { const p = prompt(`Новый пароль для ${u.login} (от 8 символов)`); if (p) update(u, { password: p }); } }, 'Сбросить пароль'))))))),
    h('h2', {}, 'Права ролей'),
    h('ul', {},
      h('li', {}, h('b', {}, 'Аналитик'), ' — вносит данные, выполняет расчёты, формирует отчёты.'),
      h('li', {}, h('b', {}, 'Руководитель'), ' — просматривает отчёты, дашборды и историю, экспортирует; данные не изменяет.'),
      h('li', {}, h('b', {}, 'Администратор'), ' — всё перечисленное, справочники, пользователи, журнал, резервные копии.'),
      h('li', {}, h('b', {}, 'Сопровождающий разработчик'), ' — справочники, журнал и резервные копии; данные предприятий только на просмотр.'))];
}

async function auditView() {
  const [log, backups] = await Promise.all([api('GET', '/api/audit?limit=500'), api('GET', '/api/backups')]);
  return [h('h1', {}, 'Журнал действий и резервные копии'),
    h('h2', {}, 'Резервные копии базы данных'),
    h('div', { class: 'bar' }, h('button', { onclick: act(async () => { await api('POST', '/api/backups'); toast('Резервная копия создана'); render(); }) }, 'Создать копию сейчас'),
      h('span', { class: 'muted small' }, 'Автоматически — раз в сутки, хранятся последние 30. Файлы лежат в каталоге data/backups на сервере.')),
    h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Файл', 'Создан', 'Размер'].map(t => h('th', {}, t)))),
      h('tbody', {}, backups.slice(0, 10).map(b => h('tr', {}, h('td', {}, b.name), h('td', {}, b.created_at.replace('T', ' ')), h('td', {}, `${num(b.size / 1024, 0)} КБ`)))))),
    h('h2', {}, 'Журнал (последние 500 записей)'),
    h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Время', 'Пользователь', 'Роль', 'Действие', 'Объект', 'Детали'].map(t => h('th', {}, t)))),
      h('tbody', {}, log.map(a => h('tr', {}, h('td', { class: 'num' }, a.ts.replace('T', ' ')), h('td', {}, a.login || '—'),
        h('td', {}, S.meta.roles[a.role] || '—'), h('td', {}, a.action),
        h('td', {}, [a.entity, a.entity_id].filter(Boolean).join(' ')), h('td', { class: 'muted small' }, a.details || ''))))))];
}

boot();
