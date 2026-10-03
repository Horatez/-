'use strict';
/* Режим без сервера (GitHub Pages): тот же API, что у server.py, но расчёты
   выполняются в браузере, а данные хранятся в localStorage этого браузера.
   Формулы перенесены из calc.py один к одному — при изменении формул правьте оба файла. */
const LocalAPI = (() => {
  const ENGINE_VERSION = '1.0.0-web';
  const STABLE_THRESHOLD = 0.05, TOL = 0.5, KEY = 'oak-db-v1';

  /* ---------------- формы отчётности ---------------- */
  const L = (code, name) => ({ code, name, total: false });
  const T = (code, name, codes) => ({ code, name, total: true,
    formula: codes.map(c => c.startsWith('-') ? [-1, c.slice(1)] : [1, c]) });
  const BALANCE = [
    { section: 'I. Внеоборотные активы', lines: [L('1150', 'Основные средства'), L('1160', 'Доходные вложения в материальные ценности'),
      L('1170', 'Финансовые вложения'), L('1180', 'Отложенные налоговые активы'), L('1190', 'Прочие внеоборотные активы'),
      T('1100', 'Итого по разделу I', ['1150', '1160', '1170', '1180', '1190'])] },
    { section: 'II. Оборотные активы', lines: [L('1210', 'Запасы'), L('1230', 'Дебиторская задолженность'),
      L('1240', 'Финансовые вложения (краткосрочные)'), L('1250', 'Денежные средства и денежные эквиваленты'),
      L('1260', 'Прочие оборотные активы'), T('1200', 'Итого по разделу II', ['1210', '1230', '1240', '1250', '1260']),
      T('1600', 'БАЛАНС (актив)', ['1100', '1200'])] },
    { section: 'III. Капитал и резервы', lines: [L('1310', 'Уставный капитал'), L('1340', 'Переоценка внеоборотных активов'),
      L('1350', 'Добавочный капитал'), L('1360', 'Резервный капитал'), L('1370', 'Нераспределённая прибыль (непокрытый убыток)'),
      T('1300', 'Итого по разделу III', ['1310', '1340', '1350', '1360', '1370'])] },
    { section: 'IV. Долгосрочные обязательства', lines: [L('1410', 'Заёмные средства'), L('1420', 'Отложенные налоговые обязательства'),
      L('1430', 'Оценочные обязательства'), L('1450', 'Прочие долгосрочные обязательства'),
      T('1400', 'Итого по разделу IV', ['1410', '1420', '1430', '1450'])] },
    { section: 'V. Краткосрочные обязательства', lines: [L('1510', 'Заёмные средства'), L('1520', 'Кредиторская задолженность'),
      L('1530', 'Доходы будущих периодов'), L('1540', 'Оценочные обязательства'), L('1550', 'Прочие краткосрочные обязательства'),
      T('1500', 'Итого по разделу V', ['1510', '1520', '1530', '1540', '1550']),
      T('1700', 'БАЛАНС (пассив)', ['1300', '1400', '1500'])] },
  ];
  const PNL = [{ section: 'Отчёт о финансовых результатах', lines: [
    L('2110', 'Выручка'), L('2120', 'Себестоимость продаж'), T('2100', 'Валовая прибыль (убыток)', ['2110', '-2120']),
    L('2210', 'Коммерческие расходы'), L('2220', 'Управленческие расходы'),
    T('2200', 'Прибыль (убыток) от продаж', ['2100', '-2210', '-2220']),
    L('2310', 'Доходы от участия в других организациях'), L('2320', 'Проценты к получению'), L('2330', 'Проценты к уплате'),
    L('2340', 'Прочие доходы'), L('2350', 'Прочие расходы'),
    T('2300', 'Прибыль (убыток) до налогообложения', ['2200', '2310', '2320', '-2330', '2340', '-2350']),
    L('2410', 'Налог на прибыль'), T('2400', 'Чистая прибыль (убыток)', ['2300', '-2410'])] }];
  const EXTRA = [{ section: 'Дополнительные данные (необязательно)', lines: [
    L('headcount', 'Среднесписочная численность, чел.'), L('amort', 'Амортизация'),
    L('ebitda', 'EBITDA (если не указана — считается: стр. 2300 + стр. 2330 + амортизация)'),
    L('taxes', 'Сумма уплаченных налогов')] }];
  const FORMS = { balance: BALANCE, pnl: PNL, extra: EXTRA };
  const EXPENSE = new Set(['2120', '2210', '2220', '2330', '2350']);
  const all = form => form.flatMap(s => s.lines);
  const LINES = Object.fromEntries(Object.values(FORMS).flatMap(all).map(l => [l.code, l]));
  const BAL_CODES = all(BALANCE).map(l => l.code), PNL_CODES = all(PNL).map(l => l.code);

  const toNum = x => (x == null || x === '' || !Number.isFinite(+x)) ? null : +x;

  function normalize(raw, year) {
    raw = raw || {};
    const d = {}, warnings = [];
    for (const c in LINES) d[c] = toNum(raw[c]);
    for (const codes of [BAL_CODES, PNL_CODES]) {
      if (codes.some(c => d[c] != null)) for (const c of codes) if (d[c] == null && !LINES[c].total) d[c] = 0;
    }
    for (const form of [BALANCE, PNL]) for (const ln of all(form)) {
      if (!ln.total || ln.formula.some(([, c]) => d[c] == null)) continue;
      const calc = ln.formula.reduce((a, [s, c]) => a + s * d[c], 0);
      if (d[ln.code] == null) d[ln.code] = calc;
      else if (Math.abs(d[ln.code] - calc) > TOL)
        warnings.push(`${year}: строка ${ln.code} «${ln.name}» = ${g(d[ln.code])}, сумма составляющих строк = ${g(calc)}`);
    }
    if (d['1600'] != null && d['1700'] != null && Math.abs(d['1600'] - d['1700']) > TOL)
      warnings.push(`${year}: актив баланса (${g(d['1600'])}) не равен пассиву (${g(d['1700'])})`);
    return [d, warnings];
  }
  const g = x => String(+x.toPrecision(6));

  class Ctx {
    constructor(cur, prev) { this.cur = cur; this.prev = prev; this.notes = []; }
    v(c) { return this.cur[c] ?? null; }
    s(...terms) {
      let t = 0;
      for (const term of terms) {
        const [sg, c] = term.startsWith('-') ? [-1, term.slice(1)] : [1, term];
        const v = this.cur[c];
        if (v == null) return null;
        t += sg * v;
      }
      return t;
    }
    avg(c) {
      const cur = this.cur[c];
      if (cur == null) return null;
      const prev = this.prev ? this.prev[c] : null;
      if (prev == null) {
        this.notes.push(`Нет данных за предыдущий год: вместо среднегодового значения строки ${c} взято значение на конец года`);
        return cur;
      }
      return (prev + cur) / 2;
    }
    ebitda() {
      if (this.cur.ebitda != null) { this.notes.push('EBITDA взята из дополнительных данных'); return this.cur.ebitda; }
      const base = this.s('2300', '2330'), am = this.cur.amort;
      if (am == null || base == null) { this.notes.push('Не указаны ни EBITDA, ни амортизация'); return null; }
      this.notes.push('EBITDA = стр. 2300 + стр. 2330 + амортизация');
      return base + am;
    }
  }

  const GROUPS = [['abs', 'Абсолютные показатели'], ['profit', 'Рентабельность'], ['liquidity', 'Ликвидность'],
    ['stability', 'Финансовая устойчивость'], ['activity', 'Деловая активность']];
  const UNITS = { money: '', pct: '%', ratio: 'коэф.', turns: 'об.' };
  const CL = c => c.s('1500', '-1530'), CLL = 'стр. 1500 − стр. 1530';
  const I = (id, group, name, unit, numL, num, denL, den, lines, mvp) => ({ id, group, name, unit,
    num_label: numL, den_label: denL || null, num, den: den || null, lines, mvp: !!mvp,
    formula: denL ? `(${numL}) / (${denL})` + (unit === 'pct' ? ' × 100 %' : '') : numL });
  const IND = [
    I('revenue', 'abs', 'Выручка', 'money', 'стр. 2110', c => c.v('2110'), null, null, ['2110'], 1),
    I('net_profit', 'abs', 'Чистая прибыль (убыток)', 'money', 'стр. 2400', c => c.v('2400'), null, null, ['2400'], 1),
    I('ros', 'profit', 'Рентабельность продаж', 'pct', 'стр. 2200', c => c.v('2200'), 'стр. 2110', c => c.v('2110'), ['2200', '2110'], 1),
    I('npm', 'profit', 'Рентабельность по чистой прибыли', 'pct', 'стр. 2400', c => c.v('2400'), 'стр. 2110', c => c.v('2110'), ['2400', '2110'], 1),
    I('roa', 'profit', 'Рентабельность активов (ROA)', 'pct', 'стр. 2400', c => c.v('2400'), 'среднегодовая стр. 1600', c => c.avg('1600'), ['2400', '1600'], 1),
    I('roe', 'profit', 'Рентабельность собственного капитала (ROE)', 'pct', 'стр. 2400', c => c.v('2400'), 'среднегодовая стр. 1300', c => c.avg('1300'), ['2400', '1300'], 1),
    I('ebitda_margin', 'profit', 'Рентабельность по EBITDA', 'pct', 'EBITDA', c => c.ebitda(), 'стр. 2110', c => c.v('2110'), ['2300', '2330', 'amort', 'ebitda', '2110']),
    I('abs_liq', 'liquidity', 'Коэффициент абсолютной ликвидности', 'ratio', 'стр. 1250 + стр. 1240', c => c.s('1250', '1240'), CLL, CL, ['1250', '1240', '1500', '1530'], 1),
    I('quick_liq', 'liquidity', 'Коэффициент быстрой ликвидности', 'ratio', 'стр. 1250 + стр. 1240 + стр. 1230', c => c.s('1250', '1240', '1230'), CLL, CL, ['1250', '1240', '1230', '1500', '1530'], 1),
    I('cur_liq', 'liquidity', 'Коэффициент текущей ликвидности', 'ratio', 'стр. 1200', c => c.v('1200'), CLL, CL, ['1200', '1500', '1530'], 1),
    I('autonomy', 'stability', 'Коэффициент автономии', 'ratio', 'стр. 1300', c => c.v('1300'), 'стр. 1700', c => c.v('1700'), ['1300', '1700'], 1),
    I('sos', 'stability', 'Обеспеченность собственными оборотными средствами', 'ratio', 'стр. 1300 − стр. 1100', c => c.s('1300', '-1100'), 'стр. 1200', c => c.v('1200'), ['1300', '1100', '1200']),
    I('leverage', 'stability', 'Плечо финансового рычага', 'ratio', 'стр. 1400 + стр. 1500', c => c.s('1400', '1500'), 'стр. 1300', c => c.v('1300'), ['1400', '1500', '1300']),
    I('debt_ebitda', 'stability', 'Долг / EBITDA', 'ratio', 'стр. 1410 + стр. 1510', c => c.s('1410', '1510'), 'EBITDA', c => c.ebitda(), ['1410', '1510', '2300', '2330', 'amort', 'ebitda']),
    I('asset_turn', 'activity', 'Оборачиваемость активов', 'turns', 'стр. 2110', c => c.v('2110'), 'среднегодовая стр. 1600', c => c.avg('1600'), ['2110', '1600']),
    I('inv_turn', 'activity', 'Оборачиваемость запасов', 'turns', 'стр. 2120', c => c.v('2120'), 'среднегодовая стр. 1210', c => c.avg('1210'), ['2120', '1210']),
    I('rec_turn', 'activity', 'Оборачиваемость дебиторской задолженности', 'turns', 'стр. 2110', c => c.v('2110'), 'среднегодовая стр. 1230', c => c.avg('1230'), ['2110', '1230']),
    I('pay_turn', 'activity', 'Оборачиваемость кредиторской задолженности', 'turns', 'стр. 2120', c => c.v('2120'), 'среднегодовая стр. 1520', c => c.avg('1520'), ['2120', '1520']),
  ];
  const IND_BY_ID = Object.fromEntries(IND.map(i => [i.id, i]));
  const BENCH_IDS = IND.filter(i => i.group !== 'abs').map(i => i.id);
  const ALWAYS = ['revenue', 'net_profit'];

  function computeYear(ind, cur, prev) {
    const ctx = new Ctx(cur, prev);
    const num = ind.num(ctx), den = ind.den ? ind.den(ctx) : null;
    let value = null;
    if (!ind.den) value = num;
    else if (num == null || den == null) ctx.notes.push('Недостаточно исходных данных');
    else if (den === 0) ctx.notes.push('Знаменатель равен нулю — показатель не рассчитывается');
    else value = num / den * (ind.unit === 'pct' ? 100 : 1);
    if (!ind.den && num == null) ctx.notes.push('Недостаточно исходных данных');
    return { value, num, den, notes: [...new Set(ctx.notes)] };
  }

  function compare(value, bench, unit, basis) {
    if (value == null || !bench) return null;
    let used = basis, base = bench[basis];
    if (base == null) { used = basis === 'mean' ? 'median' : 'mean'; base = bench[used]; }
    if (base == null) return null;
    const dev = value - base, { low, high } = bench;
    const position = low != null && high != null
      ? (value < low ? 'below' : value > high ? 'above' : 'in_range')
      : (dev < 0 ? 'below' : dev > 0 ? 'above' : 'in_range');
    return { base, basis: used, abs_dev: dev, pct_dev: base ? dev / Math.abs(base) * 100 : null,
      pp_dev: unit === 'pct' ? dev : null, position };
  }

  function trend(years, values) {
    const pts = years.map((y, i) => [y, values[i]]).filter(p => p[1] != null);
    const out = { direction: null, steps: [], cagr: null, avg_abs: null, change_abs: null, change_pct: null };
    if (pts.length < 2) return out;
    const signs = [];
    for (let i = 1; i < pts.length; i++) {
      const [y0, a] = pts[i - 1], [y1, b] = pts[i], d = b - a, rel = a ? d / Math.abs(a) : null;
      signs.push(rel == null ? Math.sign(d) : Math.abs(rel) < STABLE_THRESHOLD ? 0 : Math.sign(d));
      out.steps.push({ from: y0, to: y1, abs: d, pct: rel == null ? null : rel * 100 });
    }
    out.direction = signs.every(s => s === 0) ? 'stable'
      : signs.includes(1) && signs.includes(-1) ? 'unstable' : signs.includes(1) ? 'up' : 'down';
    const [y0, v0] = pts[0], [y1, v1] = pts[pts.length - 1], span = y1 - y0;
    out.change_abs = v1 - v0;
    out.change_pct = v0 ? (v1 - v0) / Math.abs(v0) * 100 : null;
    out.avg_abs = (v1 - v0) / span;
    if (v0 > 0 && v1 > 0) out.cagr = ((v1 / v0) ** (1 / span) - 1) * 100;
    return out;
  }

  function runCalc(years, fin, benchmarks, selected, basis) {
    years = years.map(Number).sort((a, b) => a - b);
    const norm = {}, missing = [];
    let warnings = [];
    for (const y of years) {
      const [d, w] = normalize(fin[y], y);
      norm[y] = d; warnings = warnings.concat(w);
      if (d['1600'] == null || d['1700'] == null) missing.push(`${y}: бухгалтерский баланс не заполнен или заполнен не полностью`);
      if (d['2110'] == null) missing.push(`${y}: отчёт о финансовых результатах не заполнен`);
    }
    const ids = IND.map(i => i.id).filter(i => ALWAYS.includes(i) || !selected || selected.includes(i));
    const indicators = ids.map(id => {
      const ind = IND_BY_ID[id], bench = benchmarks[id] || null, perYear = {}, values = [];
      years.forEach((y, k) => {
        const prev = k && years[k - 1] === y - 1 ? norm[years[k - 1]] : null;
        const r = computeYear(ind, norm[y], prev);
        r.compare = compare(r.value, bench, ind.unit, basis);
        perYear[y] = r; values.push(r.value);
      });
      return { id, name: ind.name, group: ind.group, unit: ind.unit, formula: ind.formula,
        num_label: ind.num_label, den_label: ind.den_label,
        lines: ind.lines.map(c => ({ code: c, name: LINES[c].name, values: Object.fromEntries(years.map(y => [y, norm[y][c] ?? null])) })),
        years: perYear, bench, trend: trend(years, values) };
    });
    return { engine_version: ENGINE_VERSION, years, basis, missing, warnings, indicators };
  }

  /* ---------------- начальные справочники (как refseed.py) ---------------- */
  const SIZES = [['micro', 'Микропредприятие'], ['small', 'Малое предприятие'], ['medium', 'Среднее предприятие'], ['large', 'Крупное предприятие']];
  const INDUSTRIES = [['agri', 'Сельское, лесное хозяйство, рыболовство'], ['mining', 'Добыча полезных ископаемых'],
    ['manuf', 'Обрабатывающие производства'], ['energy', 'Электроэнергия, газ, пар, водоснабжение'], ['constr', 'Строительство'],
    ['wholesale', 'Оптовая торговля'], ['retail', 'Розничная торговля'], ['transport', 'Транспортировка и хранение'],
    ['horeca', 'Гостиницы и общественное питание'], ['it', 'Информация и связь'], ['realty', 'Операции с недвижимым имуществом'],
    ['services', 'Профессиональные, научные и технические услуги']];
  const OKVED = [['01', 'Растениеводство и животноводство', 'agri'], ['02', 'Лесоводство и лесозаготовки', 'agri'],
    ['03', 'Рыболовство и рыбоводство', 'agri'], ['05', 'Добыча угля', 'mining'], ['06', 'Добыча нефти и природного газа', 'mining'],
    ['07', 'Добыча металлических руд', 'mining'], ['08', 'Добыча прочих полезных ископаемых', 'mining'],
    ['09', 'Услуги в области добычи полезных ископаемых', 'mining'], ['10', 'Производство пищевых продуктов', 'manuf'],
    ['11', 'Производство напитков', 'manuf'], ['13', 'Производство текстильных изделий', 'manuf'], ['14', 'Производство одежды', 'manuf'],
    ['16', 'Обработка древесины', 'manuf'], ['17', 'Производство бумаги и бумажных изделий', 'manuf'],
    ['20', 'Производство химических веществ', 'manuf'], ['22', 'Производство резиновых и пластмассовых изделий', 'manuf'],
    ['23', 'Производство прочей неметаллической минеральной продукции', 'manuf'], ['24', 'Производство металлургическое', 'manuf'],
    ['25', 'Производство готовых металлических изделий', 'manuf'], ['26', 'Производство компьютеров, электронных и оптических изделий', 'manuf'],
    ['27', 'Производство электрического оборудования', 'manuf'], ['28', 'Производство машин и оборудования', 'manuf'],
    ['29', 'Производство автотранспортных средств', 'manuf'], ['31', 'Производство мебели', 'manuf'],
    ['35', 'Обеспечение электрической энергией, газом и паром', 'energy'], ['36', 'Забор, очистка и распределение воды', 'energy'],
    ['41', 'Строительство зданий', 'constr'], ['42', 'Строительство инженерных сооружений', 'constr'],
    ['43', 'Работы строительные специализированные', 'constr'], ['45', 'Торговля автотранспортными средствами и их ремонт', 'wholesale'],
    ['46', 'Торговля оптовая', 'wholesale'], ['47', 'Торговля розничная', 'retail'],
    ['49', 'Деятельность сухопутного и трубопроводного транспорта', 'transport'], ['50', 'Деятельность водного транспорта', 'transport'],
    ['51', 'Деятельность воздушного транспорта', 'transport'], ['52', 'Складское хозяйство и вспомогательная транспортная деятельность', 'transport'],
    ['53', 'Деятельность почтовой связи и курьерская', 'transport'], ['55', 'Деятельность по предоставлению мест для временного проживания', 'horeca'],
    ['56', 'Деятельность по предоставлению продуктов питания и напитков', 'horeca'], ['58', 'Деятельность издательская', 'it'],
    ['61', 'Деятельность в сфере телекоммуникаций', 'it'], ['62', 'Разработка компьютерного программного обеспечения', 'it'],
    ['63', 'Деятельность в области информационных технологий', 'it'], ['68', 'Операции с недвижимым имуществом', 'realty'],
    ['69', 'Деятельность в области права и бухгалтерского учёта', 'services'], ['70', 'Деятельность головных офисов; консультирование по управлению', 'services'],
    ['71', 'Деятельность в области архитектуры и инженерно-технического проектирования', 'services'],
    ['72', 'Научные исследования и разработки', 'services'], ['73', 'Деятельность рекламная и исследование конъюнктуры рынка', 'services']];
  const ORDER = ['ros', 'npm', 'roa', 'roe', 'ebitda_margin', 'abs_liq', 'quick_liq', 'cur_liq', 'autonomy', 'sos', 'leverage',
    'debt_ebitda', 'asset_turn', 'inv_turn', 'rec_turn', 'pay_turn'];
  const MEANS = {
    agri: [14, 11, 6, 12, 22, 0.15, 0.7, 1.9, 0.50, 0.25, 1.0, 3.0, 0.6, 2.5, 7, 6],
    mining: [25, 18, 10, 18, 35, 0.20, 0.9, 1.6, 0.55, 0.15, 0.8, 1.8, 0.7, 8, 6, 5],
    manuf: [11, 7, 6, 14, 15, 0.12, 0.8, 1.5, 0.45, 0.12, 1.2, 2.8, 1.1, 5, 6.5, 5.5],
    energy: [9, 6, 4, 8, 20, 0.15, 0.9, 1.3, 0.50, 0.05, 1.0, 3.2, 0.6, 15, 6, 5],
    constr: [7, 4, 3.5, 12, 9, 0.10, 0.8, 1.3, 0.25, 0.08, 3.0, 3.5, 1.0, 4, 4.5, 3.5],
    wholesale: [5, 3, 6, 18, 6, 0.08, 0.8, 1.4, 0.30, 0.15, 2.3, 3.0, 2.2, 8, 7, 6],
    retail: [4, 2.5, 5.5, 16, 6.5, 0.10, 0.4, 1.2, 0.30, 0.10, 2.3, 2.9, 2.4, 7, 25, 6.5],
    transport: [8, 5, 5, 11, 16, 0.15, 0.9, 1.3, 0.40, 0.05, 1.5, 3.0, 1.1, 20, 7, 7],
    horeca: [8, 5, 5, 13, 14, 0.15, 0.6, 1.0, 0.30, 0.03, 2.3, 3.3, 1.3, 18, 20, 8],
    it: [16, 12, 12, 25, 20, 0.35, 1.3, 1.8, 0.50, 0.30, 1.0, 1.2, 1.2, 25, 6, 8],
    realty: [20, 12, 3.5, 7, 35, 0.20, 0.9, 1.4, 0.45, 0.05, 1.2, 5.0, 0.25, 3, 6, 5],
    services: [12, 8, 9, 20, 15, 0.25, 1.1, 1.6, 0.45, 0.25, 1.2, 1.8, 1.4, 20, 6, 7],
  };
  const SIZE_P = { micro: 0.80, small: 0.92, medium: 1.0, large: 1.12 }, SIZE_L = { micro: 1.10, small: 1.05, medium: 1.0, large: 0.95 };
  const r3 = x => +x.toFixed(Math.abs(x) < 1 ? 3 : 2);
  function seedBenchmarks(vid) {
    const rows = [];
    for (const [ind, means] of Object.entries(MEANS)) for (const [size] of SIZES) ORDER.forEach((iid, k) => {
      const prof = k < 5, liq = k >= 5 && k < 8;
      const mean = means[k] * (prof ? SIZE_P[size] : liq ? SIZE_L[size] : 1), median = mean * (prof ? 0.8 : 0.92);
      rows.push({ version_id: vid, industry_code: ind, size_code: size, indicator: iid,
        mean: r3(mean), median: r3(median), low: r3(median * 0.7), high: r3(mean * 1.3) });
    });
    return rows;
  }
  const DEMO_FIN = {
    2022: { 1150: 12000, 1190: 500, 1210: 30000, 1230: 25000, 1240: 1000, 1250: 3500, 1260: 500, 1310: 100, 1370: 21900, 1410: 8000,
      1510: 10000, 1520: 31500, 1550: 1000, 2110: 180000, 2120: 150000, 2210: 15000, 2220: 6000, 2320: 100, 2330: 2200, 2340: 800,
      2350: 1500, 2410: 1240, headcount: 42, amort: 1500 },
    2023: { 1150: 14000, 1190: 500, 1210: 36000, 1230: 31000, 1240: 1500, 1250: 4200, 1260: 600, 1310: 100, 1370: 27600, 1410: 9000,
      1510: 13000, 1520: 37000, 1550: 1100, 2110: 215000, 2120: 180500, 2210: 17500, 2220: 6800, 2320: 150, 2330: 2900, 2340: 900,
      2350: 1225, 2410: 1425, headcount: 47, amort: 1800 },
    2024: { 1150: 15500, 1190: 600, 1210: 44000, 1230: 38000, 1240: 800, 1250: 3100, 1260: 700, 1310: 100, 1370: 32000, 1410: 11000,
      1510: 17000, 1520: 41300, 1550: 1300, 2110: 240000, 2120: 204000, 2210: 19800, 2220: 7600, 2320: 120, 2330: 3900, 2340: 1000,
      2350: 320, 2410: 1100, headcount: 51, amort: 2100 },
  };

  /* ---------------- хранилище ---------------- */
  const now = () => { const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const USER = { id: 1, login: 'local', name: 'Пользователь браузера', role: 'admin', role_name: 'Локальный режим', active: 1 };

  function fresh() {
    const t = now();
    return {
      seq: { company: 1, run: 0, version: 1 },
      industries: INDUSTRIES.map(([code, name]) => ({ code, name })),
      sizes: SIZES.map(([code, name], sort) => ({ code, name, sort })),
      okved: OKVED.map(([code, name, industry_code]) => ({ code, name, industry_code })),
      versions: [{ id: 1, label: 'v1 (демонстрационная)', comment: 'Демонстрационные значения. Замените фактическими отраслевыми данными.', created_at: t, created_by: 'system' }],
      benchmarks: seedBenchmarks(1),
      companies: [{ id: 1, name: 'ООО «Демо-Торг» (учебный пример)', inn: '0000000000', okved: '46.73', industry_code: 'wholesale',
        size_code: 'small', region: 'г. Москва', year_from: 2022, year_to: 2024, currency: 'RUB', unit: 'тыс.', custom_bench: {},
        created_at: t, updated_at: t, created_by: 'system' }],
      financials: { 1: JSON.parse(JSON.stringify(DEMO_FIN)) },
      runs: [], audit: [],
    };
  }
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { db = null; }
  if (!db || !db.seq) db = fresh();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {
      throw new Error('Хранилище браузера переполнено или недоступно. Выгрузите копию данных и удалите старые расчёты.');
    }
  }
  save();

  class ApiError extends Error {}
  const fail = msg => { throw new ApiError(msg); };
  function audit(action, entity, entity_id, details) {
    db.audit.unshift({ id: (db.audit[0]?.id || 0) + 1, ts: now(), login: USER.login, role: USER.role, action, entity,
      entity_id: entity_id == null ? null : String(entity_id), details: details == null ? null : JSON.stringify(details) });
    db.audit.length = Math.min(db.audit.length, 2000);
  }

  /* ---------------- разбор чисел и таблиц ---------------- */
  function parseNumber(x, code) {
    if (x == null) return null;
    let v;
    if (typeof x === 'number') v = x;
    else {
      let s = String(x).replace(/[\s ]/g, '').replace('−', '-').trim();
      if (['', '-', '—', '–'].includes(s)) return null;
      const neg = s.startsWith('(') && s.endsWith(')');
      s = s.replace(/[()]/g, '').replace(',', '.');
      v = Number(s);
      if (s === '' || !Number.isFinite(v)) return null;
      if (neg) v = -Math.abs(v);
    }
    if (EXPENSE.has(code) || (code === '2410' && typeof x === 'string' && x.includes('('))) v = Math.abs(v);
    return v;
  }

  function parseCsv(text) {
    const head = text.slice(0, 4000);
    const delim = [';', '\t', ','].reduce((a, b) => head.split(b).length > head.split(a).length ? b : a);
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  async function readTable(filename, bytes) {
    if (/\.xls[xm]$/i.test(filename)) {
      try { return await Xlsx.read(bytes); } catch (e) { fail('Не удалось прочитать файл Excel (.xlsx)'); }
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) { text = new TextDecoder('windows-1251').decode(bytes); }
    return parseCsv(text.replace(/^﻿/, ''));
  }
  const b64bytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

  function parseStatement(table, years) {
    let cols = null, head = -1;
    for (let i = 0; i < Math.min(30, table.length) && !cols; i++) {
      const found = {};
      table[i].forEach((cell, j) => {
        const m = /^\s*((?:19|20)\d{2})(?:\.0)?\s*(?:г\.?|год)?\s*$/.exec(cell == null ? '' : String(cell));
        if (m) found[j] = +m[1];
      });
      if (Object.keys(found).length) { cols = found; head = i; }
    }
    if (!cols) fail('В файле не найдена строка заголовка с годами (например: Код; Наименование; 2022; 2023; 2024)');
    const data = Object.fromEntries(years.map(y => [y, {}]));
    let recognized = 0;
    const skipped = [...new Set(Object.values(cols).filter(y => !years.includes(y)))].sort();
    for (const row of table.slice(head + 1)) {
      let code = null;
      for (const cell of row.slice(0, 3)) {
        const s = String(cell ?? '').trim().replace(/\.0$/, '');
        if (LINES[s]) { code = s; break; }
      }
      if (!code) continue;
      let hit = false;
      for (const [j, y] of Object.entries(cols)) {
        if (!years.includes(y) || j >= row.length) continue;
        const v = parseNumber(row[j], code);
        if (v != null) { data[y][code] = v; hit = true; }
      }
      recognized += hit;
    }
    return [data, recognized, skipped];
  }

  /* ---------------- предприятия и расчёты ---------------- */
  const yearsOf = c => Array.from({ length: c.year_to - c.year_from + 1 }, (_, i) => c.year_from + i);
  const companyOut = c => ({ ...c, custom_bench: c.custom_bench || {}, years: yearsOf(c) });
  function getCompany(id) {
    const c = db.companies.find(x => x.id === +id);
    if (!c) fail('Предприятие не найдено');
    return c;
  }
  const nameOf = (list, code) => (list.find(x => x.code === code) || {}).name || code;

  function validateCompany(b) {
    const d = {};
    for (const k of ['name', 'inn', 'okved', 'region', 'currency', 'unit']) d[k] = String(b[k] ?? '').trim();
    if (!d.name) fail('Укажите наименование предприятия');
    if (!/^(\d{10}|\d{12})$/.test(d.inn)) fail('ИНН должен состоять из 10 или 12 цифр');
    if (!/^\d{2}(\.\d{1,2}){0,2}$/.test(d.okved)) fail('ОКВЭД указывается в формате 46, 46.7, 46.73 или 46.73.1');
    if (!db.industries.some(i => i.code === b.industry_code)) fail('Выберите отрасль из справочника');
    if (!db.sizes.some(i => i.code === b.size_code)) fail('Выберите размер бизнеса из справочника');
    d.industry_code = b.industry_code; d.size_code = b.size_code;
    d.year_from = parseInt(b.year_from, 10); d.year_to = parseInt(b.year_to, 10);
    if (!(d.year_from >= 1990 && d.year_from <= d.year_to && d.year_to <= 2100) || d.year_to - d.year_from > 9)
      fail('Период анализа: от 1 до 10 лет, начало не позже окончания');
    d.currency ||= 'RUB'; d.unit ||= 'тыс.';
    d.custom_bench = {};
    for (const [iid, v] of Object.entries(b.custom_bench || {})) {
      if (!BENCH_IDS.includes(iid) || typeof v !== 'object') continue;
      const row = Object.fromEntries(['mean', 'median', 'low', 'high'].map(k => [k, parseNumber(v[k])]));
      if (Object.values(row).some(x => x != null)) d.custom_bench[iid] = row;
    }
    return d;
  }

  function saveFinancials(c, incoming) {
    for (const y of yearsOf(c)) {
      const src = incoming[y];
      if (!src || typeof src !== 'object') continue;
      const out = {};
      for (const code in LINES) { const v = parseNumber(src[code]); if (v != null) out[code] = v; }
      (db.financials[c.id] ||= {})[y] = out;
    }
  }

  function benchFor(vid, industry, size, custom) {
    const out = {};
    for (const r of db.benchmarks) if (r.version_id === vid && r.industry_code === industry && r.size_code === size)
      out[r.indicator] = { mean: r.mean, median: r.median, low: r.low, high: r.high, source: 'справочник' };
    for (const [iid, v] of Object.entries(custom || {})) if (!out[iid]) out[iid] = { ...v, source: 'введено пользователем' };
    return out;
  }

  function buildRun(id, b) {
    const c = getCompany(id);
    const version = db.versions.find(v => v.id === +(b.version_id || db.versions[db.versions.length - 1].id));
    if (!version) fail('Версия справочника не найдена');
    const industry = b.industry || c.industry_code, size = b.size || c.size_code;
    const basis = ['mean', 'median'].includes(b.basis) ? b.basis : 'mean';
    const selected = Array.isArray(b.indicators) ? b.indicators.filter(i => IND_BY_ID[i]) : null;
    const fin = db.financials[c.id] || {};
    const result = runCalc(yearsOf(c), fin, benchFor(version.id, industry, size, c.custom_bench), selected, basis);
    result.title = { company: c.name, inn: c.inn, okved: c.okved, industry: nameOf(db.industries, c.industry_code),
      size: nameOf(db.sizes, c.size_code), bench_industry_code: industry, bench_size_code: size,
      bench_industry: nameOf(db.industries, industry), bench_size: nameOf(db.sizes, size), region: c.region,
      period: `${c.year_from}–${c.year_to}`, currency: c.currency, unit: c.unit, generated_at: now(),
      ref_version: version.label, ref_version_id: version.id, engine_version: ENGINE_VERSION, basis, author: USER.login };
    return [c, fin, { indicators: selected, basis, industry, size, version_id: version.id }, result];
  }

  /* ---------------- выгрузки ---------------- */
  const POS = { above: 'выше', below: 'ниже', in_range: 'в диапазоне' };
  const DIR = { up: 'рост', down: 'падение', stable: 'стабильность', unstable: 'нестабильность' };
  const BASIS = { mean: 'среднее', median: 'медиана' };
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const csvNum = x => x == null ? '' : String(+x.toPrecision(10)).replace('.', ',');

  function statementRows(years, fin) {
    const out = [['Код', 'Наименование', ...years]];
    for (const key of ['balance', 'pnl', 'extra']) for (const sec of FORMS[key]) {
      out.push([null, sec.section]);
      for (const ln of sec.lines) out.push([ln.code, ln.name, ...years.map(y => (fin[y] || {})[ln.code] ?? null)]);
    }
    return out;
  }
  function csvBlob(rows) {
    const esc = v => { const s = typeof v === 'number' ? csvNum(v) : v == null ? '' : String(v);
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return new Blob(['﻿' + rows.map(r => r.map(esc).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  }

  function runExport(run) {
    const res = run.result, t = res.title, years = res.years;
    const title = [['Сводный аналитический отчёт'], ['Предприятие', t.company], ['ИНН', t.inn], ['ОКВЭД', t.okved],
      ['Отрасль', t.industry], ['Размер бизнеса', t.size],
      ['База сравнения', `${t.bench_industry} / ${t.bench_size} (${BASIS[t.basis]})`], ['Период анализа', t.period],
      ['Единицы измерения', `${t.unit} ${t.currency}`], ['Дата формирования', t.generated_at], ['Версия справочников', t.ref_version],
      ['Версия расчётного модуля', t.engine_version], ['Сформировал', t.author], [],
      ['Отчёт содержит только факты, отклонения и динамику. Рекомендаций и прогнозов не содержит.'],
      ...res.warnings.map(w => ['Замечание к данным', w])];
    const unit = i => i.unit === 'money' ? `${t.unit} ${t.currency}` : UNITS[i.unit];
    const ind = [['Показатель', 'Ед.', ...years, 'Изменение, абс.', 'Изменение, %']];
    const cmp = [['Показатель', 'Ед.', 'Год', 'Предприятие', 'Среднее по отрасли', 'Медиана по отрасли', 'Норма: от', 'Норма: до',
      'База сравнения', 'Отклонение, абс.', 'Отклонение, %', 'Отклонение, п.п.', 'Положение', 'Источник отраслевых данных']];
    const tr = [['Показатель', 'Ед.', ...years, 'Тренд', 'Среднегодовой темп (CAGR), %', 'Среднегодовое изменение, абс.']];
    const calc = [['Показатель', 'Формула', 'Год', 'Числитель', 'Значение числителя', 'Знаменатель', 'Значение знаменателя', 'Результат', 'Примечания']];
    for (const i of res.indicators) {
      const vals = years.map(y => i.years[y].value), b = i.bench || {};
      ind.push([i.name, unit(i), ...vals, i.trend.change_abs, i.trend.change_pct]);
      tr.push([i.name, unit(i), ...vals, DIR[i.trend.direction] || 'нет данных', i.trend.cagr, i.trend.avg_abs]);
      for (const y of years) {
        const r = i.years[y], cm = r.compare;
        calc.push([i.name, i.formula, y, i.num_label, r.num, i.den_label, r.den, r.value, r.notes.join('; ')]);
        if (i.group !== 'abs') cmp.push([i.name, unit(i), y, r.value, b.mean, b.median, b.low, b.high,
          ...(cm ? [cm.base, cm.abs_dev, cm.pct_dev, cm.pp_dev, POS[cm.position]] : [null, null, null, null, 'нет данных']), b.source]);
      }
    }
    return Xlsx.write([['Титул', title], ['Показатели', ind], ['Сравнение с отраслью', cmp], ['Тренды', tr],
      ['Расчёты', calc], ['Исходные данные', statementRows(years, run.snapshot.financials)]]);
  }

  /* ---------------- маршруты ---------------- */
  const routes = [];
  const on = (method, pattern, fn) => routes.push([method, new RegExp('^' + pattern + '$'), fn]);

  on('GET', '/api/me', () => USER);
  on('GET', '/api/meta', () => ({
    forms: FORMS, indicators: IND.map(({ num, den, ...rest }) => rest), groups: GROUPS, units: UNITS,
    roles: { admin: USER.role_name }, engine_version: ENGINE_VERSION, stable_threshold: STABLE_THRESHOLD,
    industries: [...db.industries].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    sizes: [...db.sizes].sort((a, b) => a.sort - b.sort), okved: [...db.okved].sort((a, b) => a.code.localeCompare(b.code)),
    versions: [...db.versions].reverse(),
  }));

  on('POST', '/api/ref/(industries|sizes|okved)', (q, b, kind) => {
    const code = String(b.code ?? '').trim(), name = String(b.name ?? '').trim();
    if (!code || !name || !/^[\w.\-]{1,20}$/.test(code)) fail('Укажите код (буквы, цифры, точка) и наименование');
    const row = { code, name };
    if (kind === 'sizes') row.sort = parseInt(b.sort, 10) || 0;
    if (kind === 'okved') {
      if (!db.industries.some(i => i.code === b.industry_code)) fail('Неизвестная отрасль');
      row.industry_code = b.industry_code;
    }
    db[kind] = db[kind].filter(x => x.code !== code).concat(row);
    audit(`ref.${kind}.save`, kind, code, row);
    return { ok: true };
  });
  on('DELETE', '/api/ref/(industries|sizes|okved)/([^/]+)', (q, b, kind, code) => {
    code = decodeURIComponent(code);
    const col = { industries: 'industry_code', sizes: 'size_code' }[kind];
    if (col && db.companies.some(c => c[col] === code)) fail('Значение используется в карточках предприятий');
    if (kind === 'industries' && db.okved.some(o => o.industry_code === code)) fail('К отрасли привязаны коды ОКВЭД');
    db[kind] = db[kind].filter(x => x.code !== code);
    audit(`ref.${kind}.delete`, kind, code);
    return { ok: true };
  });
  on('GET', '/api/ref/benchmarks', q => {
    const v = +(q.get('version') || db.versions[db.versions.length - 1].id);
    return db.benchmarks.filter(r => r.version_id === v && (!q.get('industry') || r.industry_code === q.get('industry')) &&
      (!q.get('size') || r.size_code === q.get('size')));
  });
  on('POST', '/api/ref/versions', async (q, b) => {
    const base = +(b.base_id || db.versions[db.versions.length - 1].id);
    const changes = [...(b.rows || [])];
    if (b.file_b64) {
      const table = await readTable(String(b.filename || 'x.csv'), b64bytes(b.file_b64));
      for (const r of table.slice(1)) if (r.length >= 4 && r[0]) {
        const [industry, size, indicator, mean, median, low, high] = [...r, null, null, null];
        changes.push({ industry, size, indicator, mean, median, low, high });
      }
    }
    if (!changes.length) fail('Нет изменений для новой версии');
    const id = ++db.seq.version, d = new Date();
    const rows = db.benchmarks.filter(r => r.version_id === base).map(r => ({ ...r, version_id: id }));
    for (const ch of changes) {
      const ind = String(ch.industry).trim(), size = String(ch.size).trim(), iid = String(ch.indicator).trim();
      if (!db.industries.some(i => i.code === ind) || !db.sizes.some(s => s.code === size) || !BENCH_IDS.includes(iid))
        fail(`Неизвестная комбинация: ${ind} / ${size} / ${iid}`);
      const vals = ['mean', 'median', 'low', 'high'].map(k => parseNumber(ch[k]));
      const k = rows.findIndex(r => r.industry_code === ind && r.size_code === size && r.indicator === iid);
      if (k >= 0) rows.splice(k, 1);
      if (vals.some(v => v != null)) rows.push({ version_id: id, industry_code: ind, size_code: size, indicator: iid,
        mean: vals[0], median: vals[1], low: vals[2], high: vals[3] });
    }
    db.benchmarks.push(...rows);
    const v = { id, label: `v${id} от ${d.toLocaleDateString('ru-RU')}`, comment: String(b.comment || '').slice(0, 500),
      created_at: now(), created_by: USER.login };
    db.versions.push(v);
    audit('ref.version.create', 'ref_version', id, { base, changed_rows: changes.length, comment: b.comment });
    return v;
  });

  on('GET', '/api/companies', () => db.companies.map(companyOut).sort((a, b) => a.name.localeCompare(b.name, 'ru')));
  on('POST', '/api/companies', (q, b) => {
    const d = validateCompany(b), c = { id: ++db.seq.company, ...d, created_at: now(), updated_at: now(), created_by: USER.login };
    db.companies.push(c);
    audit('company.create', 'company', c.id, { name: c.name });
    return companyOut(c);
  });
  on('GET', '/api/companies/(\\d+)', (q, b, id) => companyOut(getCompany(id)));
  on('PUT', '/api/companies/(\\d+)', (q, b, id) => {
    const c = getCompany(id);
    Object.assign(c, validateCompany(b), { updated_at: now() });
    audit('company.update', 'company', id, { name: c.name });
    return companyOut(c);
  });
  on('DELETE', '/api/companies/(\\d+)', (q, b, id) => {
    const c = getCompany(id);
    db.companies = db.companies.filter(x => x !== c);
    delete db.financials[c.id];
    db.runs = db.runs.filter(r => r.company_id !== c.id);
    audit('company.delete', 'company', id, { name: c.name });
    return { ok: true };
  });
  on('GET', '/api/companies/(\\d+)/financials', (q, b, id) => db.financials[getCompany(id).id] || {});
  on('PUT', '/api/companies/(\\d+)/financials', (q, b, id) => {
    const c = getCompany(id);
    saveFinancials(c, b);
    audit('financials.update', 'company', id);
    return db.financials[c.id] || {};
  });
  on('POST', '/api/companies/(\\d+)/import', async (q, b, id) => {
    const c = getCompany(id), years = yearsOf(c);
    const [parsed, recognized, skipped] = parseStatement(await readTable(String(b.filename || ''), b64bytes(b.file_b64 || '')), years);
    if (!recognized) fail('В файле не найдено ни одной строки с известным кодом (1150, 2110 …)');
    const merged = JSON.parse(JSON.stringify(db.financials[c.id] || {}));
    for (const [y, vals] of Object.entries(parsed)) Object.assign(merged[y] ||= {}, vals);
    saveFinancials(c, merged);
    audit('financials.import', 'company', id, { file: b.filename, rows: recognized });
    return { financials: db.financials[c.id], recognized, skipped_years: skipped };
  });
  on('POST', '/api/companies/(\\d+)/preview', (q, b, id) => buildRun(id, b)[3]);
  on('POST', '/api/companies/(\\d+)/runs', (q, b, id) => {
    const [c, fin, params, result] = buildRun(id, b);
    if (result.missing.length) fail('Данные неполные: ' + result.missing.join('; '));
    const run = { id: ++db.seq.run, company_id: c.id, created_at: result.title.generated_at, user_login: USER.login,
      ref_version_id: params.version_id, engine_version: ENGINE_VERSION, params,
      snapshot: { company: companyOut(c), financials: JSON.parse(JSON.stringify(fin)) }, result };
    db.runs.push(run);
    audit('run.create', 'run', run.id, { company: c.id, ...params });
    return { ...result, run_id: run.id };
  });
  on('GET', '/api/companies/(\\d+)/runs', (q, b, id) => db.runs.filter(r => r.company_id === +id).reverse().map(r => ({
    id: r.id, created_at: r.created_at, user_login: r.user_login, engine_version: r.engine_version,
    params: JSON.stringify(r.params), ref_version: (db.versions.find(v => v.id === r.ref_version_id) || {}).label })));
  const getRun = id => db.runs.find(r => r.id === +id) || fail('Расчёт не найден');
  on('GET', '/api/runs/(\\d+)', (q, b, id) => ({ ...getRun(id).result, run_id: +id }));
  on('DELETE', '/api/runs/(\\d+)', (q, b, id) => {
    db.runs = db.runs.filter(r => r.id !== +id);
    audit('run.delete', 'run', id);
    return { ok: true };
  });
  on('GET', '/api/audit', q => db.audit.slice(0, +(q.get('limit') || 300)));

  /* файлы: возвращают { blob, filename } */
  const files = [];
  const file = (pattern, fn) => files.push([new RegExp('^' + pattern + '$'), fn]);
  file('/api/companies/(\\d+)/source\\.(csv|xlsx)', (q, id, ext) => {
    const c = getCompany(id), rows = statementRows(yearsOf(c), db.financials[c.id] || {});
    audit('export.source', 'company', id, { format: ext });
    return { blob: ext === 'csv' ? csvBlob(rows) : new Blob([Xlsx.write([['Исходные данные', rows]])], { type: XLSX_TYPE }),
      filename: `ishodnye-dannye-${c.inn}.${ext}` };
  });
  file('/api/runs/(\\d+)/export\\.xlsx', (q, id) => {
    const run = getRun(id);
    audit('export.report', 'run', id, { format: 'xlsx' });
    return { blob: new Blob([runExport(run)], { type: XLSX_TYPE }), filename: `otchet-${run.result.title.inn}-${id}.xlsx` };
  });
  file('/api/ref/benchmarks\\.csv', q => {
    const v = +(q.get('version') || db.versions[db.versions.length - 1].id);
    const rows = [['industry', 'size', 'indicator', 'mean', 'median', 'low', 'high'],
      ...db.benchmarks.filter(r => r.version_id === v).map(r => [r.industry_code, r.size_code, r.indicator, r.mean, r.median, r.low, r.high])];
    return { blob: csvBlob(rows), filename: `benchmarks-v${v}.csv` };
  });
  file('/api/backup\\.json', () => ({
    blob: new Blob([JSON.stringify({ format: 'oak-backup', version: 1, created_at: now(), db })], { type: 'application/json' }),
    filename: `konstruktor-backup-${now().slice(0, 10)}.json` }));

  async function request(method, url, body) {
    const u = new URL(url, location.origin);
    for (const [m, rx, fn] of routes) {
      const match = m === method && rx.exec(u.pathname);
      if (!match) continue;
      const snapshot = JSON.stringify(db);
      try {
        const out = await fn(u.searchParams, body || {}, ...match.slice(1));
        if (method !== 'GET') save();
        return JSON.parse(JSON.stringify(out));
      } catch (e) {
        db = JSON.parse(snapshot);  // откат, как транзакция на сервере
        throw e;
      }
    }
    fail('Не найдено');
  }
  async function download(url) {
    const u = new URL(url, location.origin);
    for (const [rx, fn] of files) {
      const match = rx.exec(u.pathname);
      if (match) { const out = fn(u.searchParams, ...match.slice(1)); save(); return out; }
    }
    fail('Не найдено');
  }
  function restore(json) {
    const data = JSON.parse(json);
    if (data.format !== 'oak-backup' || !data.db || !data.db.seq) fail('Это не файл резервной копии конструктора');
    db = data.db;
    audit('backup.restore', 'backup', data.created_at);
    save();
  }
  function reset() { db = fresh(); save(); }
  function usage() { try { return (localStorage.getItem(KEY) || '').length * 2; } catch (e) { return 0; } }

  return { request, download, restore, reset, usage, _calc: { runCalc, normalize, trend, compare } };
})();

/* ---------------- минимальные чтение/запись .xlsx (ZIP) ---------------- */
const Xlsx = (() => {
  const enc = new TextEncoder();
  const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

  function zip(entries) {
    const parts = [], central = [];
    let offset = 0;
    for (const [name, text] of entries) {
      const data = enc.encode(text), fn = enc.encode(name), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, fn.length, true);
      parts.push(new Uint8Array(h.buffer), fn, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, fn.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), fn);
      offset += 30 + fn.length + data.length;
    }
    const size = central.reduce((a, p) => a + p.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
    e.setUint32(12, size, true); e.setUint32(16, offset, true);
    const out = new Uint8Array(offset + size + 22);
    let p = 0;
    for (const part of [...parts, ...central, new Uint8Array(e.buffer)]) { out.set(part, p); p += part.length; }
    return out;
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const col = n => { let s = ''; n++; while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs></styleSheet>';

  function write(sheets) {
    const files = [], wb = [], rels = [];
    const types = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'];
    sheets.forEach(([name, rows], i) => {
      const n = i + 1, ncols = Math.max(1, ...rows.map(r => r.length));
      const widths = Array.from({ length: ncols }, (_, c) => Math.min(Math.max(2 + Math.max(8, ...rows.map(r => r[c] == null ? 0 : String(r[c]).length)), 10), 70));
      const body = rows.map((row, r) => `<row r="${r + 1}">` + row.map((v, c) => {
        const ref = col(c) + (r + 1), bold = r === 0;
        if (v == null || v === '') return '';
        if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}" s="${bold ? 3 : 2}"><v>${v}</v></c>` : '';
        return `<c r="${ref}" t="inlineStr" s="${bold ? 1 : 0}"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }).join('') + '</row>').join('');
      files.push([`xl/worksheets/sheet${n}.xml`, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${body}</sheetData></worksheet>`]);
      types.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
      wb.push(`<sheet name="${esc(name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31))}" sheetId="${n}" r:id="rId${n}"/>`);
      rels.push(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`);
    });
    rels.push(`<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
    return zip([
      ['[Content_Types].xml', types.join('') + '</Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${wb.join('')}</sheets></workbook>`],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join('') + '</Relationships>'],
      ['xl/styles.xml', STYLES], ...files]);
  }

  async function unzip(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), dec = new TextDecoder();
    let e = bytes.length - 22;
    while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('not a zip');
    const count = v.getUint16(e + 10, true), out = {};
    let p = v.getUint32(e + 16, true);
    for (let i = 0; i < count; i++) {
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
      const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
      const local = v.getUint32(p + 42, true), name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const raw = bytes.subarray(start, start + csize);
      out[name] = method === 0 ? raw : method === 8
        ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
        : null;
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  async function read(bytes) {
    const z = await unzip(bytes), dec = new TextDecoder(), parse = n => new DOMParser().parseFromString(dec.decode(z[n]), 'application/xml');
    const shared = z['xl/sharedStrings.xml'] ? [...parse('xl/sharedStrings.xml').getElementsByTagName('si')]
      .map(si => [...si.getElementsByTagName('t')].map(t => t.textContent).join('')) : [];
    const sheets = Object.keys(z).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
    const rows = [];
    for (const s of sheets) for (const row of parse(s).getElementsByTagName('row')) {
      const cells = [];
      for (const c of row.getElementsByTagName('c')) {
        const ref = c.getAttribute('r') || 'A1', t = c.getAttribute('t'), vEl = c.getElementsByTagName('v')[0];
        let idx = 0;
        for (const ch of ref.replace(/\d+/g, '')) idx = idx * 26 + ch.charCodeAt(0) - 64;
        let val;
        if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
        else if (!vEl) continue;
        else if (t === 's') val = shared[+vEl.textContent];
        else if (['str', 'b', 'e'].includes(t)) val = vEl.textContent;
        else val = Number.isFinite(+vEl.textContent) ? +vEl.textContent : vEl.textContent;
        cells[idx - 1] = val;
      }
      if (cells.length) rows.push(Array.from(cells, x => x ?? null));
    }
    return rows;
  }

  return { write, read };
})();
