"""Расчётное ядро: формы отчётности, показатели, сравнение с отраслью, тренды.

Модуль не зависит от веб-сервера и БД. Любое изменение формул должно
сопровождаться повышением ENGINE_VERSION — версия сохраняется в каждом расчёте.
"""

ENGINE_VERSION = "1.0.0"

# Порог «стабильности»: изменение год к году менее 5 % от предыдущего значения.
STABLE_THRESHOLD = 0.05
# Допуск при сверке итогов (в единицах измерения отчётности).
TOTAL_TOLERANCE = 0.5


def _line(code, name):
    return {"code": code, "name": name, "total": False}


def _total(code, name, formula):
    return {"code": code, "name": name, "total": True, "formula": formula}


# formula — список (знак, код строки)
BALANCE = [
    {"section": "I. Внеоборотные активы", "lines": [
        _line("1150", "Основные средства"),
        _line("1160", "Доходные вложения в материальные ценности"),
        _line("1170", "Финансовые вложения"),
        _line("1180", "Отложенные налоговые активы"),
        _line("1190", "Прочие внеоборотные активы"),
        _total("1100", "Итого по разделу I",
               [(1, "1150"), (1, "1160"), (1, "1170"), (1, "1180"), (1, "1190")]),
    ]},
    {"section": "II. Оборотные активы", "lines": [
        _line("1210", "Запасы"),
        _line("1230", "Дебиторская задолженность"),
        _line("1240", "Финансовые вложения (краткосрочные)"),
        _line("1250", "Денежные средства и денежные эквиваленты"),
        _line("1260", "Прочие оборотные активы"),
        _total("1200", "Итого по разделу II",
               [(1, "1210"), (1, "1230"), (1, "1240"), (1, "1250"), (1, "1260")]),
        _total("1600", "БАЛАНС (актив)", [(1, "1100"), (1, "1200")]),
    ]},
    {"section": "III. Капитал и резервы", "lines": [
        _line("1310", "Уставный капитал"),
        _line("1340", "Переоценка внеоборотных активов"),
        _line("1350", "Добавочный капитал"),
        _line("1360", "Резервный капитал"),
        _line("1370", "Нераспределённая прибыль (непокрытый убыток)"),
        _total("1300", "Итого по разделу III",
               [(1, "1310"), (1, "1340"), (1, "1350"), (1, "1360"), (1, "1370")]),
    ]},
    {"section": "IV. Долгосрочные обязательства", "lines": [
        _line("1410", "Заёмные средства"),
        _line("1420", "Отложенные налоговые обязательства"),
        _line("1430", "Оценочные обязательства"),
        _line("1450", "Прочие долгосрочные обязательства"),
        _total("1400", "Итого по разделу IV",
               [(1, "1410"), (1, "1420"), (1, "1430"), (1, "1450")]),
    ]},
    {"section": "V. Краткосрочные обязательства", "lines": [
        _line("1510", "Заёмные средства"),
        _line("1520", "Кредиторская задолженность"),
        _line("1530", "Доходы будущих периодов"),
        _line("1540", "Оценочные обязательства"),
        _line("1550", "Прочие краткосрочные обязательства"),
        _total("1500", "Итого по разделу V",
               [(1, "1510"), (1, "1520"), (1, "1530"), (1, "1540"), (1, "1550")]),
        _total("1700", "БАЛАНС (пассив)", [(1, "1300"), (1, "1400"), (1, "1500")]),
    ]},
]

# Расходы вносятся положительными числами (в форме они показаны в скобках).
PNL = [
    {"section": "Отчёт о финансовых результатах", "lines": [
        _line("2110", "Выручка"),
        _line("2120", "Себестоимость продаж"),
        _total("2100", "Валовая прибыль (убыток)", [(1, "2110"), (-1, "2120")]),
        _line("2210", "Коммерческие расходы"),
        _line("2220", "Управленческие расходы"),
        _total("2200", "Прибыль (убыток) от продаж",
               [(1, "2100"), (-1, "2210"), (-1, "2220")]),
        _line("2310", "Доходы от участия в других организациях"),
        _line("2320", "Проценты к получению"),
        _line("2330", "Проценты к уплате"),
        _line("2340", "Прочие доходы"),
        _line("2350", "Прочие расходы"),
        _total("2300", "Прибыль (убыток) до налогообложения",
               [(1, "2200"), (1, "2310"), (1, "2320"), (-1, "2330"),
                (1, "2340"), (-1, "2350")]),
        _line("2410", "Налог на прибыль"),
        _total("2400", "Чистая прибыль (убыток)", [(1, "2300"), (-1, "2410")]),
    ]},
]

EXTRA = [
    {"section": "Дополнительные данные (необязательно)", "lines": [
        _line("headcount", "Среднесписочная численность, чел."),
        _line("amort", "Амортизация"),
        _line("ebitda", "EBITDA (если не указана — считается: стр. 2300 + стр. 2330 + амортизация)"),
        _line("taxes", "Сумма уплаченных налогов"),
    ]},
]

FORMS = {"balance": BALANCE, "pnl": PNL, "extra": EXTRA}
EXPENSE_CODES = {"2120", "2210", "2220", "2330", "2350"}


def _all_lines(form):
    return [ln for sec in form for ln in sec["lines"]]


LINES = {ln["code"]: ln for f in FORMS.values() for ln in _all_lines(f)}
LINE_NAMES = {c: ln["name"] for c, ln in LINES.items()}
BALANCE_CODES = [ln["code"] for ln in _all_lines(BALANCE)]
PNL_CODES = [ln["code"] for ln in _all_lines(PNL)]
EXTRA_CODES = [ln["code"] for ln in _all_lines(EXTRA)]


def _num(x):
    if x is None or x == "":
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def normalize(raw, year):
    """Приводит данные одного года к числам, достраивает пустые итоги.

    Возвращает (данные, предупреждения). Пустые детальные строки считаются
    нулём, если в их форме заполнена хотя бы одна строка.
    """
    raw = raw or {}
    data = {c: _num(raw.get(c)) for c in LINES}
    warnings = []
    for codes in (BALANCE_CODES, PNL_CODES):
        if any(data[c] is not None for c in codes):
            for c in codes:
                if data[c] is None and not LINES[c]["total"]:
                    data[c] = 0.0
    for form in (BALANCE, PNL):
        for ln in _all_lines(form):
            if not ln["total"]:
                continue
            parts = [data[c] for _, c in ln["formula"]]
            if any(p is None for p in parts):
                continue
            calc = sum(s * data[c] for s, c in ln["formula"])
            if data[ln["code"]] is None:
                data[ln["code"]] = calc
            elif abs(data[ln["code"]] - calc) > TOTAL_TOLERANCE:
                warnings.append(
                    f"{year}: строка {ln['code']} «{ln['name']}» = {data[ln['code']]:g}, "
                    f"сумма составляющих строк = {calc:g}")
    a, p = data["1600"], data["1700"]
    if a is not None and p is not None and abs(a - p) > TOTAL_TOLERANCE:
        warnings.append(f"{year}: актив баланса ({a:g}) не равен пассиву ({p:g})")
    return data, warnings


class Ctx:
    """Данные одного года + предыдущего года (для среднегодовых величин)."""

    def __init__(self, cur, prev):
        self.cur, self.prev = cur, prev
        self.notes = []

    def v(self, code):
        return self.cur.get(code)

    def s(self, *terms):
        """Сумма со знаками: s('1300', '-1100')."""
        total = 0.0
        for t in terms:
            sign, code = (-1, t[1:]) if t.startswith("-") else (1, t)
            val = self.cur.get(code)
            if val is None:
                return None
            total += sign * val
        return total

    def avg(self, code):
        cur = self.cur.get(code)
        if cur is None:
            return None
        prev = self.prev.get(code) if self.prev else None
        if prev is None:
            self.notes.append(
                f"Нет данных за предыдущий год: вместо среднегодового значения "
                f"строки {code} взято значение на конец года")
            return cur
        return (prev + cur) / 2

    def ebitda(self):
        given = self.cur.get("ebitda")
        if given is not None:
            self.notes.append("EBITDA взята из дополнительных данных")
            return given
        amort = self.cur.get("amort")
        base = self.s("2300", "2330")
        if amort is None or base is None:
            self.notes.append("Не указаны ни EBITDA, ни амортизация")
            return None
        self.notes.append("EBITDA = стр. 2300 + стр. 2330 + амортизация")
        return base + amort


CL = ("1500", "-1530")  # краткосрочные обязательства без доходов будущих периодов
CL_LABEL = "стр. 1500 − стр. 1530"

GROUPS = [
    ("abs", "Абсолютные показатели"),
    ("profit", "Рентабельность"),
    ("liquidity", "Ликвидность"),
    ("stability", "Финансовая устойчивость"),
    ("activity", "Деловая активность"),
]
UNITS = {"money": "", "pct": "%", "ratio": "коэф.", "turns": "об."}


def _ind(id, group, name, unit, num_label, num, den_label=None, den=None, lines=(), mvp=False):
    return {"id": id, "group": group, "name": name, "unit": unit,
            "num_label": num_label, "den_label": den_label,
            "num": num, "den": den, "lines": list(lines), "mvp": mvp,
            "formula": num_label if den_label is None else
            f"({num_label}) / ({den_label})" + (" × 100 %" if unit == "pct" else "")}


INDICATORS = [
    _ind("revenue", "abs", "Выручка", "money", "стр. 2110",
         lambda c: c.v("2110"), lines=["2110"], mvp=True),
    _ind("net_profit", "abs", "Чистая прибыль (убыток)", "money", "стр. 2400",
         lambda c: c.v("2400"), lines=["2400"], mvp=True),

    _ind("ros", "profit", "Рентабельность продаж", "pct",
         "стр. 2200", lambda c: c.v("2200"), "стр. 2110", lambda c: c.v("2110"),
         ["2200", "2110"], mvp=True),
    _ind("npm", "profit", "Рентабельность по чистой прибыли", "pct",
         "стр. 2400", lambda c: c.v("2400"), "стр. 2110", lambda c: c.v("2110"),
         ["2400", "2110"], mvp=True),
    _ind("roa", "profit", "Рентабельность активов (ROA)", "pct",
         "стр. 2400", lambda c: c.v("2400"),
         "среднегодовая стр. 1600", lambda c: c.avg("1600"), ["2400", "1600"], mvp=True),
    _ind("roe", "profit", "Рентабельность собственного капитала (ROE)", "pct",
         "стр. 2400", lambda c: c.v("2400"),
         "среднегодовая стр. 1300", lambda c: c.avg("1300"), ["2400", "1300"], mvp=True),
    _ind("ebitda_margin", "profit", "Рентабельность по EBITDA", "pct",
         "EBITDA", lambda c: c.ebitda(), "стр. 2110", lambda c: c.v("2110"),
         ["2300", "2330", "amort", "ebitda", "2110"]),

    _ind("abs_liq", "liquidity", "Коэффициент абсолютной ликвидности", "ratio",
         "стр. 1250 + стр. 1240", lambda c: c.s("1250", "1240"),
         CL_LABEL, lambda c: c.s(*CL), ["1250", "1240", "1500", "1530"], mvp=True),
    _ind("quick_liq", "liquidity", "Коэффициент быстрой ликвидности", "ratio",
         "стр. 1250 + стр. 1240 + стр. 1230", lambda c: c.s("1250", "1240", "1230"),
         CL_LABEL, lambda c: c.s(*CL), ["1250", "1240", "1230", "1500", "1530"], mvp=True),
    _ind("cur_liq", "liquidity", "Коэффициент текущей ликвидности", "ratio",
         "стр. 1200", lambda c: c.v("1200"),
         CL_LABEL, lambda c: c.s(*CL), ["1200", "1500", "1530"], mvp=True),

    _ind("autonomy", "stability", "Коэффициент автономии", "ratio",
         "стр. 1300", lambda c: c.v("1300"), "стр. 1700", lambda c: c.v("1700"),
         ["1300", "1700"], mvp=True),
    _ind("sos", "stability", "Обеспеченность собственными оборотными средствами", "ratio",
         "стр. 1300 − стр. 1100", lambda c: c.s("1300", "-1100"),
         "стр. 1200", lambda c: c.v("1200"), ["1300", "1100", "1200"]),
    _ind("leverage", "stability", "Плечо финансового рычага", "ratio",
         "стр. 1400 + стр. 1500", lambda c: c.s("1400", "1500"),
         "стр. 1300", lambda c: c.v("1300"), ["1400", "1500", "1300"]),
    _ind("debt_ebitda", "stability", "Долг / EBITDA", "ratio",
         "стр. 1410 + стр. 1510", lambda c: c.s("1410", "1510"),
         "EBITDA", lambda c: c.ebitda(),
         ["1410", "1510", "2300", "2330", "amort", "ebitda"]),

    _ind("asset_turn", "activity", "Оборачиваемость активов", "turns",
         "стр. 2110", lambda c: c.v("2110"),
         "среднегодовая стр. 1600", lambda c: c.avg("1600"), ["2110", "1600"]),
    _ind("inv_turn", "activity", "Оборачиваемость запасов", "turns",
         "стр. 2120", lambda c: c.v("2120"),
         "среднегодовая стр. 1210", lambda c: c.avg("1210"), ["2120", "1210"]),
    _ind("rec_turn", "activity", "Оборачиваемость дебиторской задолженности", "turns",
         "стр. 2110", lambda c: c.v("2110"),
         "среднегодовая стр. 1230", lambda c: c.avg("1230"), ["2110", "1230"]),
    _ind("pay_turn", "activity", "Оборачиваемость кредиторской задолженности", "turns",
         "стр. 2120", lambda c: c.v("2120"),
         "среднегодовая стр. 1520", lambda c: c.avg("1520"), ["2120", "1520"]),
]
IND_BY_ID = {i["id"]: i for i in INDICATORS}
BENCH_IDS = [i["id"] for i in INDICATORS if i["group"] != "abs"]
ALWAYS = ["revenue", "net_profit"]


def indicators_meta():
    return [{k: v for k, v in i.items() if k not in ("num", "den")} for i in INDICATORS]


def compute_year(ind, cur, prev):
    ctx = Ctx(cur, prev)
    num = ind["num"](ctx)
    den = ind["den"](ctx) if ind["den"] else None
    value = None
    if ind["den"] is None:
        value = num
    elif num is None or den is None:
        ctx.notes.append("Недостаточно исходных данных")
    elif den == 0:
        ctx.notes.append("Знаменатель равен нулю — показатель не рассчитывается")
    else:
        value = num / den * (100 if ind["unit"] == "pct" else 1)
    if ind["den"] is None and num is None:
        ctx.notes.append("Недостаточно исходных данных")
    return {"value": value, "num": num, "den": den,
            "notes": list(dict.fromkeys(ctx.notes))}


def compare(value, bench, unit, basis):
    """Факт против отраслевого значения. Оценка описательная, не «хорошо/плохо»."""
    if value is None or not bench:
        return None
    base = bench.get(basis)
    used = basis
    if base is None:
        used = "median" if basis == "mean" else "mean"
        base = bench.get(used)
    if base is None:
        return None
    dev = value - base
    low, high = bench.get("low"), bench.get("high")
    if low is not None and high is not None:
        pos = "below" if value < low else "above" if value > high else "in_range"
    else:
        pos = "below" if dev < 0 else "above" if dev > 0 else "in_range"
    return {"base": base, "basis": used, "abs_dev": dev,
            "pct_dev": dev / abs(base) * 100 if base else None,
            "pp_dev": dev if unit == "pct" else None,
            "position": pos}


def trend(years, values):
    pts = [(y, v) for y, v in zip(years, values) if v is not None]
    out = {"direction": None, "steps": [], "cagr": None, "avg_abs": None,
           "change_abs": None, "change_pct": None}
    if len(pts) < 2:
        return out
    signs = []
    for (y0, a), (y1, b) in zip(pts, pts[1:]):
        d = b - a
        rel = d / abs(a) if a else None
        if rel is None:
            s = 0 if d == 0 else (1 if d > 0 else -1)
        else:
            s = 0 if abs(rel) < STABLE_THRESHOLD else (1 if d > 0 else -1)
        signs.append(s)
        out["steps"].append({"from": y0, "to": y1, "abs": d,
                             "pct": rel * 100 if rel is not None else None})
    if all(s == 0 for s in signs):
        out["direction"] = "stable"
    elif 1 in signs and -1 in signs:
        out["direction"] = "unstable"
    else:
        out["direction"] = "up" if 1 in signs else "down"
    (y0, v0), (y1, v1) = pts[0], pts[-1]
    span = y1 - y0
    out["change_abs"] = v1 - v0
    out["change_pct"] = (v1 - v0) / abs(v0) * 100 if v0 else None
    out["avg_abs"] = (v1 - v0) / span
    if v0 > 0 and v1 > 0:
        out["cagr"] = ((v1 / v0) ** (1 / span) - 1) * 100
    return out


def check(years, financials):
    """Проверка полноты: что не заполнено и что не сходится."""
    missing, warnings, norm = [], [], {}
    for y in years:
        data, w = normalize(financials.get(str(y)) or financials.get(y), y)
        norm[y] = data
        warnings += w
        if data["1600"] is None or data["1700"] is None:
            missing.append(f"{y}: бухгалтерский баланс не заполнен или заполнен не полностью")
        if data["2110"] is None:
            missing.append(f"{y}: отчёт о финансовых результатах не заполнен")
    return norm, missing, warnings


def run(years, financials, benchmarks, selected=None, basis="mean"):
    """Полный расчёт.

    benchmarks: {indicator_id: {mean, median, low, high, source}}
    """
    years = sorted(int(y) for y in years)
    norm, missing, warnings = check(years, financials)
    ids = [i for i in IND_BY_ID if i in ALWAYS or selected is None or i in selected]
    result = []
    for iid in ids:
        ind = IND_BY_ID[iid]
        bench = benchmarks.get(iid)
        per_year, values = {}, []
        for idx, y in enumerate(years):
            prev = norm[years[idx - 1]] if idx and years[idx - 1] == y - 1 else None
            r = compute_year(ind, norm[y], prev)
            r["compare"] = compare(r["value"], bench, ind["unit"], basis)
            per_year[str(y)] = r
            values.append(r["value"])
        result.append({
            "id": iid, "name": ind["name"], "group": ind["group"], "unit": ind["unit"],
            "formula": ind["formula"], "num_label": ind["num_label"],
            "den_label": ind["den_label"],
            "lines": [{"code": c, "name": LINE_NAMES[c],
                       "values": {str(y): norm[y].get(c) for y in years}}
                      for c in ind["lines"]],
            "years": per_year, "bench": bench, "trend": trend(years, values),
        })
    return {"engine_version": ENGINE_VERSION, "years": years, "basis": basis,
            "missing": missing, "warnings": warnings, "indicators": result}
