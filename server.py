#!/usr/bin/env python3
"""Отраслевой аналитический конструктор показателей предприятия — веб-сервер.

Запуск:  python3 server.py [--host 127.0.0.1] [--port 8000]
Зависимостей нет: только стандартная библиотека Python 3.10+ и SQLite.
"""
import argparse
import base64
import csv
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import calc
import refseed
import xlsx

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = Path(os.environ.get("OAK_DATA_DIR", ROOT / "data"))
DB_PATH = DATA / "app.db"
BACKUPS = DATA / "backups"
SEED_USERS = ROOT / "seed_users.json"

SESSION_HOURS = 12
MAX_BODY = 12 * 1024 * 1024
BACKUP_KEEP = 30
PBKDF2_ROUNDS = 200_000

ROLES = {
    "admin": "Администратор",
    "analyst": "Аналитик",
    "viewer": "Руководитель (просмотр)",
    "maintainer": "Сопровождающий разработчик",
}
WRITE_DATA = {"admin", "analyst"}
WRITE_REF = {"admin", "maintainer"}
SEE_LOG = {"admin", "maintainer"}

POSITION = {"above": "выше", "below": "ниже", "in_range": "в диапазоне"}
DIRECTION = {"up": "рост", "down": "падение", "stable": "стабильность",
             "unstable": "нестабильность"}
BASIS = {"mean": "среднее", "median": "медиана"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL, salt TEXT NOT NULL, pwd_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS login_fail(login TEXT NOT NULL, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS industries(code TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sizes(code TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS okved(code TEXT PRIMARY KEY, name TEXT NOT NULL, industry_code TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ref_versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, comment TEXT,
  created_at TEXT NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS benchmarks(
  version_id INTEGER NOT NULL, industry_code TEXT NOT NULL, size_code TEXT NOT NULL,
  indicator TEXT NOT NULL, mean REAL, median REAL, low REAL, high REAL,
  PRIMARY KEY(version_id, industry_code, size_code, indicator));
CREATE TABLE IF NOT EXISTS companies(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, inn TEXT NOT NULL, okved TEXT NOT NULL,
  industry_code TEXT NOT NULL, size_code TEXT NOT NULL, region TEXT, year_from INTEGER NOT NULL,
  year_to INTEGER NOT NULL, currency TEXT NOT NULL, unit TEXT NOT NULL,
  custom_bench TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS financials(
  company_id INTEGER NOT NULL, year INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(company_id, year));
CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, created_at TEXT NOT NULL,
  user_login TEXT, ref_version_id INTEGER, engine_version TEXT, params TEXT NOT NULL,
  snapshot TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, login TEXT, role TEXT,
  action TEXT NOT NULL, entity TEXT, entity_id TEXT, details TEXT);
CREATE INDEX IF NOT EXISTS idx_runs_company ON runs(company_id, id DESC);
"""


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


class Download:
    def __init__(self, content, ctype, filename):
        self.content, self.ctype, self.filename = content, ctype, filename


def now():
    return datetime.now().isoformat(timespec="seconds")


def connect():
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


def hash_pwd(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt),
                               PBKDF2_ROUNDS).hex()


def add_user(db, login, name, role, password):
    salt = secrets.token_hex(16)
    db.execute("INSERT INTO users(login,name,role,salt,pwd_hash) VALUES(?,?,?,?,?)",
               (login, name, role, salt, hash_pwd(password, salt)))


def audit(db, user, action, entity=None, entity_id=None, details=None):
    db.execute("INSERT INTO audit(ts,login,role,action,entity,entity_id,details) VALUES(?,?,?,?,?,?,?)",
               (now(), user["login"] if user else None, user["role"] if user else None, action,
                entity, None if entity_id is None else str(entity_id),
                json.dumps(details, ensure_ascii=False) if details is not None else None))


def init_db():
    DATA.mkdir(parents=True, exist_ok=True)
    BACKUPS.mkdir(parents=True, exist_ok=True)
    db = connect()
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    if not db.execute("SELECT 1 FROM sizes").fetchone():
        db.executemany("INSERT INTO sizes(code,name,sort) VALUES(?,?,?)",
                       [(c, n, i) for i, (c, n) in enumerate(refseed.SIZES)])
        db.executemany("INSERT INTO industries VALUES(?,?)", refseed.INDUSTRIES)
        db.executemany("INSERT INTO okved VALUES(?,?,?)", refseed.OKVED)
        cur = db.execute("INSERT INTO ref_versions(label,comment,created_at,created_by) VALUES(?,?,?,?)",
                         ("v1 (демонстрационная)",
                          "Демонстрационные значения. Замените фактическими отраслевыми данными.",
                          now(), "system"))
        db.executemany("INSERT INTO benchmarks VALUES(?,?,?,?,?,?,?,?)",
                       [(cur.lastrowid, *row) for row in refseed.benchmarks()])
    if not db.execute("SELECT 1 FROM users").fetchone():
        for u in json.loads(SEED_USERS.read_text(encoding="utf-8")):
            add_user(db, u["login"], u["name"], u["role"], u["password"])
        d = refseed.DEMO_COMPANY
        cur = db.execute(
            "INSERT INTO companies(name,inn,okved,industry_code,size_code,region,year_from,year_to,"
            "currency,unit,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (d["name"], d["inn"], d["okved"], d["industry"], d["size"], d["region"],
             d["year_from"], d["year_to"], d["currency"], d["unit"], now(), now(), "system"))
        for y, data in refseed.DEMO_FINANCIALS.items():
            db.execute("INSERT INTO financials VALUES(?,?,?)", (cur.lastrowid, int(y), json.dumps(data)))
    db.commit()
    db.close()


def make_backup(reason="auto"):
    name = f"app-{datetime.now():%Y%m%d-%H%M%S}-{reason}.db"
    src = connect()
    dst = sqlite3.connect(BACKUPS / name)
    with dst:
        src.backup(dst)
    dst.close()
    src.close()
    for old in sorted(BACKUPS.glob("app-*.db"))[:-BACKUP_KEEP]:
        old.unlink()
    return name


def backup_loop():
    while True:
        files = sorted(BACKUPS.glob("app-*.db"))
        if not files or time.time() - files[-1].stat().st_mtime > 24 * 3600:
            try:
                make_backup()
            except Exception as e:  # резервное копирование не должно ронять сервер
                print("backup failed:", e)
        time.sleep(3600)


# ---------------------------------------------------------------- маршруты

ROUTES = []


def route(method, pattern, roles=None, public=False):
    def deco(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), roles, public, fn))
        return fn
    return deco


class Ctx:
    def __init__(self, db, user, body, query, handler):
        self.db, self.user, self.body, self.query, self.handler = db, user, body, query, handler
        self.set_cookie = None


def rows(cur):
    return [dict(r) for r in cur]


# --- вход

@route("POST", "/api/login", public=True)
def login(c):
    name = str(c.body.get("login", "")).strip().lower()
    password = str(c.body.get("password", ""))
    since = time.time() - 600
    c.db.execute("DELETE FROM login_fail WHERE ts < ?", (since,))
    fails = c.db.execute("SELECT COUNT(*) FROM login_fail WHERE login=?", (name,)).fetchone()[0]
    if fails >= 5:
        raise ApiError(429, "Слишком много неудачных попыток. Повторите через 10 минут.")
    u = c.db.execute("SELECT * FROM users WHERE login=? AND active=1", (name,)).fetchone()
    ok = bool(u) and hmac.compare_digest(u["pwd_hash"], hash_pwd(password, u["salt"]))
    if not ok:
        c.db.execute("INSERT INTO login_fail VALUES(?,?)", (name, time.time()))
        audit(c.db, None, "login.failed", "user", name)
        c.db.commit()
        raise ApiError(401, "Неверный логин или пароль")
    token = secrets.token_urlsafe(32)
    c.db.execute("INSERT INTO sessions VALUES(?,?,?)",
                 (token, u["id"], time.time() + SESSION_HOURS * 3600))
    c.db.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
    audit(c.db, u, "login", "user", u["login"])
    c.set_cookie = f"sid={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_HOURS * 3600}"
    return public_user(u)


def public_user(u):
    return {"id": u["id"], "login": u["login"], "name": u["name"], "role": u["role"],
            "role_name": ROLES.get(u["role"], u["role"]), "active": u["active"]}


@route("POST", "/api/logout")
def logout(c):
    c.db.execute("DELETE FROM sessions WHERE user_id=?", (c.user["id"],))
    audit(c.db, c.user, "logout", "user", c.user["login"])
    c.set_cookie = "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
    return {"ok": True}


@route("GET", "/api/me")
def me(c):
    return public_user(c.user)


def check_password(p):
    if len(p) < 8:
        raise ApiError(400, "Пароль должен быть не короче 8 символов")


@route("POST", "/api/me/password")
def change_password(c):
    old, new = str(c.body.get("old", "")), str(c.body.get("new", ""))
    if not hmac.compare_digest(c.user["pwd_hash"], hash_pwd(old, c.user["salt"])):
        raise ApiError(400, "Текущий пароль указан неверно")
    check_password(new)
    salt = secrets.token_hex(16)
    c.db.execute("UPDATE users SET salt=?, pwd_hash=? WHERE id=?",
                 (salt, hash_pwd(new, salt), c.user["id"]))
    audit(c.db, c.user, "user.password", "user", c.user["login"])
    return {"ok": True}


# --- метаданные и справочники

def current_version(db):
    return db.execute("SELECT * FROM ref_versions ORDER BY id DESC LIMIT 1").fetchone()


@route("GET", "/api/meta")
def meta(c):
    return {
        "forms": calc.FORMS, "indicators": calc.indicators_meta(),
        "groups": calc.GROUPS, "units": calc.UNITS, "roles": ROLES,
        "engine_version": calc.ENGINE_VERSION,
        "stable_threshold": calc.STABLE_THRESHOLD,
        "industries": rows(c.db.execute("SELECT * FROM industries ORDER BY name")),
        "sizes": rows(c.db.execute("SELECT * FROM sizes ORDER BY sort, name")),
        "okved": rows(c.db.execute("SELECT * FROM okved ORDER BY code")),
        "versions": rows(c.db.execute("SELECT * FROM ref_versions ORDER BY id DESC")),
    }


DICTS = {
    "industries": ("industries", ["code", "name"]),
    "sizes": ("sizes", ["code", "name", "sort"]),
    "okved": ("okved", ["code", "name", "industry_code"]),
}


@route("POST", "/api/ref/(industries|sizes|okved)", roles=WRITE_REF)
def dict_upsert(c, kind):
    table, cols = DICTS[kind]
    vals = [c.body.get(k) for k in cols]
    code, name = str(vals[0] or "").strip(), str(vals[1] or "").strip()
    if not code or not name or not re.fullmatch(r"[\w.\-]{1,20}", code):
        raise ApiError(400, "Укажите код (буквы, цифры, точка) и наименование")
    vals[0], vals[1] = code, name
    if kind == "sizes":
        vals[2] = int(vals[2] or 0)
    if kind == "okved" and not c.db.execute(
            "SELECT 1 FROM industries WHERE code=?", (vals[2],)).fetchone():
        raise ApiError(400, "Неизвестная отрасль")
    c.db.execute(f"INSERT OR REPLACE INTO {table}({','.join(cols)}) VALUES({','.join('?' * len(cols))})", vals)
    audit(c.db, c.user, f"ref.{kind}.save", kind, code, dict(zip(cols, vals)))
    return {"ok": True}


@route("DELETE", "/api/ref/(industries|sizes|okved)/([^/]+)", roles=WRITE_REF)
def dict_delete(c, kind, code):
    table, _ = DICTS[kind]
    col = {"industries": "industry_code", "sizes": "size_code"}.get(kind)
    if col and c.db.execute(f"SELECT 1 FROM companies WHERE {col}=?", (code,)).fetchone():
        raise ApiError(409, "Значение используется в карточках предприятий")
    if kind == "industries" and c.db.execute(
            "SELECT 1 FROM okved WHERE industry_code=?", (code,)).fetchone():
        raise ApiError(409, "К отрасли привязаны коды ОКВЭД")
    c.db.execute(f"DELETE FROM {table} WHERE code=?", (code,))
    audit(c.db, c.user, f"ref.{kind}.delete", kind, code)
    return {"ok": True}


@route("GET", "/api/ref/benchmarks")
def bench_list(c):
    v = int(c.query.get("version") or current_version(c.db)["id"])
    sql, args = "SELECT * FROM benchmarks WHERE version_id=?", [v]
    for key, col in (("industry", "industry_code"), ("size", "size_code")):
        if c.query.get(key):
            sql += f" AND {col}=?"
            args.append(c.query[key])
    return rows(c.db.execute(sql, args))


BENCH_COLS = ["industry", "size", "indicator", "mean", "median", "low", "high"]


@route("GET", "/api/ref/benchmarks.csv")
def bench_csv(c):
    v = int(c.query.get("version") or current_version(c.db)["id"])
    out = io.StringIO()
    w = csv.writer(out, delimiter=";", lineterminator="\r\n")
    w.writerow(BENCH_COLS)
    for r in c.db.execute("SELECT * FROM benchmarks WHERE version_id=? ORDER BY 2,3,4", (v,)):
        w.writerow([r["industry_code"], r["size_code"], r["indicator"]] +
                   [fmt_csv(r[k]) for k in ("mean", "median", "low", "high")])
    return Download(("﻿" + out.getvalue()).encode(), "text/csv; charset=utf-8",
                    f"benchmarks-v{v}.csv")


def fmt_csv(x):
    return "" if x is None else f"{x:.10g}".replace(".", ",")


def parse_number(x, code=None):
    """Число из ячейки Excel/CSV. Скобки — отрицательное (кроме строк расходов)."""
    if x is None:
        return None
    if isinstance(x, (int, float)):
        val = float(x)
    else:
        s = str(x).replace(" ", "").replace(" ", "").replace("−", "-").strip()
        if s in ("", "-", "—", "–"):
            return None
        neg = s.startswith("(") and s.endswith(")")
        s = s.strip("()").replace(",", ".")
        try:
            val = float(s)
        except ValueError:
            return None
        if neg:
            val = -abs(val)
    if code in calc.EXPENSE_CODES or (code == "2410" and isinstance(x, str) and "(" in x):
        val = abs(val)
    return val


def read_table(filename, content):
    if filename.lower().endswith((".xlsx", ".xlsm")):
        try:
            return xlsx.read(content)
        except Exception:
            raise ApiError(400, "Не удалось прочитать файл Excel (.xlsx)")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("cp1251", errors="replace")
    head = text[:4000]
    delim = max(";\t,", key=head.count)
    return list(csv.reader(io.StringIO(text), delimiter=delim))


@route("POST", "/api/ref/versions", roles=WRITE_REF)
def version_create(c):
    base = int(c.body.get("base_id") or current_version(c.db)["id"])
    changes = list(c.body.get("rows") or [])
    if c.body.get("file_b64"):
        table = read_table(str(c.body.get("filename", "x.csv")), base64.b64decode(c.body["file_b64"]))
        for r in table[1:]:
            if len(r) >= 4 and r[0]:
                r = list(r) + [None] * 7
                changes.append(dict(zip(BENCH_COLS, r[:7])))
    if not changes:
        raise ApiError(400, "Нет изменений для новой версии")
    industries = {r["code"] for r in c.db.execute("SELECT code FROM industries")}
    sizes = {r["code"] for r in c.db.execute("SELECT code FROM sizes")}
    cur = c.db.execute("INSERT INTO ref_versions(label,comment,created_at,created_by) VALUES('',?,?,?)",
                       (str(c.body.get("comment") or "")[:500], now(), c.user["login"]))
    vid = cur.lastrowid
    c.db.execute("UPDATE ref_versions SET label=? WHERE id=?",
                 (f"v{vid} от {datetime.now():%d.%m.%Y}", vid))
    c.db.execute("INSERT INTO benchmarks SELECT ?,industry_code,size_code,indicator,mean,median,low,high "
                 "FROM benchmarks WHERE version_id=?", (vid, base))
    for ch in changes:
        ind, size, iid = str(ch.get("industry")).strip(), str(ch.get("size")).strip(), str(ch.get("indicator")).strip()
        if ind not in industries or size not in sizes or iid not in calc.BENCH_IDS:
            raise ApiError(400, f"Неизвестная комбинация: {ind} / {size} / {iid}")
        vals = [parse_number(ch.get(k)) for k in ("mean", "median", "low", "high")]
        if all(v is None for v in vals):
            c.db.execute("DELETE FROM benchmarks WHERE version_id=? AND industry_code=? AND size_code=? AND indicator=?",
                         (vid, ind, size, iid))
        else:
            c.db.execute("INSERT OR REPLACE INTO benchmarks VALUES(?,?,?,?,?,?,?,?)",
                         (vid, ind, size, iid, *vals))
    audit(c.db, c.user, "ref.version.create", "ref_version", vid,
          {"base": base, "changed_rows": len(changes), "comment": c.body.get("comment")})
    return dict(c.db.execute("SELECT * FROM ref_versions WHERE id=?", (vid,)).fetchone())


# --- предприятия

COMPANY_FIELDS = ["name", "inn", "okved", "industry_code", "size_code", "region",
                  "year_from", "year_to", "currency", "unit"]


def company_out(r):
    d = dict(r)
    d["custom_bench"] = json.loads(d["custom_bench"] or "{}")
    d["years"] = list(range(d["year_from"], d["year_to"] + 1))
    return d


def get_company(db, cid):
    r = db.execute("SELECT * FROM companies WHERE id=?", (cid,)).fetchone()
    if not r:
        raise ApiError(404, "Предприятие не найдено")
    return company_out(r)


def validate_company(db, b):
    d = {k: b.get(k) for k in COMPANY_FIELDS}
    for k in ("name", "inn", "okved", "region", "currency", "unit"):
        d[k] = str(d[k] or "").strip()
    if not d["name"]:
        raise ApiError(400, "Укажите наименование предприятия")
    if not re.fullmatch(r"\d{10}|\d{12}", d["inn"]):
        raise ApiError(400, "ИНН должен состоять из 10 или 12 цифр")
    if not re.fullmatch(r"\d{2}(\.\d{1,2}){0,2}", d["okved"]):
        raise ApiError(400, "ОКВЭД указывается в формате 46, 46.7, 46.73 или 46.73.1")
    if not db.execute("SELECT 1 FROM industries WHERE code=?", (d["industry_code"],)).fetchone():
        raise ApiError(400, "Выберите отрасль из справочника")
    if not db.execute("SELECT 1 FROM sizes WHERE code=?", (d["size_code"],)).fetchone():
        raise ApiError(400, "Выберите размер бизнеса из справочника")
    try:
        d["year_from"], d["year_to"] = int(d["year_from"]), int(d["year_to"])
    except (TypeError, ValueError):
        raise ApiError(400, "Укажите период анализа")
    if not (1990 <= d["year_from"] <= d["year_to"] <= 2100) or d["year_to"] - d["year_from"] > 9:
        raise ApiError(400, "Период анализа: от 1 до 10 лет, начало не позже окончания")
    d["currency"] = d["currency"] or "RUB"
    d["unit"] = d["unit"] or "тыс."
    cb = b.get("custom_bench") or {}
    clean = {}
    for iid, v in cb.items():
        if iid in calc.BENCH_IDS and isinstance(v, dict):
            row = {k: parse_number(v.get(k)) for k in ("mean", "median", "low", "high")}
            if any(x is not None for x in row.values()):
                clean[iid] = row
    d["custom_bench"] = json.dumps(clean)
    return d


@route("GET", "/api/companies")
def companies(c):
    return [company_out(r) for r in c.db.execute("SELECT * FROM companies ORDER BY name")]


@route("POST", "/api/companies", roles=WRITE_DATA)
def company_create(c):
    d = validate_company(c.db, c.body)
    cols = list(d)
    cur = c.db.execute(
        f"INSERT INTO companies({','.join(cols)},created_at,updated_at,created_by) "
        f"VALUES({','.join('?' * len(cols))},?,?,?)",
        [d[k] for k in cols] + [now(), now(), c.user["login"]])
    audit(c.db, c.user, "company.create", "company", cur.lastrowid, {"name": d["name"]})
    return get_company(c.db, cur.lastrowid)


@route("GET", r"/api/companies/(\d+)")
def company_get(c, cid):
    return get_company(c.db, cid)


@route("PUT", r"/api/companies/(\d+)", roles=WRITE_DATA)
def company_update(c, cid):
    get_company(c.db, cid)
    d = validate_company(c.db, c.body)
    c.db.execute(f"UPDATE companies SET {','.join(k + '=?' for k in d)}, updated_at=? WHERE id=?",
                 list(d.values()) + [now(), cid])
    audit(c.db, c.user, "company.update", "company", cid, {"name": d["name"]})
    return get_company(c.db, cid)


@route("DELETE", r"/api/companies/(\d+)", roles={"admin"})
def company_delete(c, cid):
    comp = get_company(c.db, cid)
    make_backup("before-delete")
    for t in ("financials", "runs"):
        c.db.execute(f"DELETE FROM {t} WHERE company_id=?", (cid,))
    c.db.execute("DELETE FROM companies WHERE id=?", (cid,))
    audit(c.db, c.user, "company.delete", "company", cid, {"name": comp["name"]})
    return {"ok": True}


def load_financials(db, cid):
    return {str(r["year"]): json.loads(r["data"])
            for r in db.execute("SELECT * FROM financials WHERE company_id=?", (cid,))}


def save_financials(db, comp, incoming):
    saved = 0
    for y in comp["years"]:
        src = incoming.get(str(y))
        if not isinstance(src, dict):
            continue
        data = {}
        for code in calc.LINES:
            v = parse_number(src.get(code))
            if v is not None:
                data[code] = v
        db.execute("INSERT OR REPLACE INTO financials VALUES(?,?,?)", (comp["id"], y, json.dumps(data)))
        saved += 1
    return saved


@route("GET", r"/api/companies/(\d+)/financials")
def financials_get(c, cid):
    get_company(c.db, cid)
    return load_financials(c.db, cid)


@route("PUT", r"/api/companies/(\d+)/financials", roles=WRITE_DATA)
def financials_put(c, cid):
    comp = get_company(c.db, cid)
    n = save_financials(c.db, comp, c.body)
    audit(c.db, c.user, "financials.update", "company", cid, {"years": n})
    return load_financials(c.db, cid)


def parse_statement(table, years):
    """Таблица вида «Код | Наименование | 2022 | 2023 | 2024» -> {год: {код: число}}."""
    year_cols, header_idx = {}, None
    for i, row in enumerate(table[:30]):
        found = {}
        for j, cell in enumerate(row):
            m = re.fullmatch(r"\s*((?:19|20)\d{2})(?:\.0)?\s*(?:г\.?|год)?\s*", str(cell if cell is not None else ""))
            if m:
                found[j] = int(m.group(1))
        if found:
            year_cols, header_idx = found, i
            break
    if not year_cols:
        raise ApiError(400, "В файле не найдена строка заголовка с годами (например: Код; Наименование; 2022; 2023; 2024)")
    data = {str(y): {} for y in years}
    recognized, skipped_years = 0, sorted({y for y in year_cols.values() if y not in years})
    for row in table[header_idx + 1:]:
        code = None
        for cell in row[:3]:
            s = str(cell if cell is not None else "").strip()
            s = re.sub(r"\.0$", "", s)
            if s in calc.LINES:
                code = s
                break
        if not code:
            continue
        hit = False
        for j, y in year_cols.items():
            if y in years and j < len(row):
                v = parse_number(row[j], code)
                if v is not None:
                    data[str(y)][code] = v
                    hit = True
        recognized += hit
    return data, recognized, skipped_years


@route("POST", r"/api/companies/(\d+)/import", roles=WRITE_DATA)
def financials_import(c, cid):
    comp = get_company(c.db, cid)
    filename = str(c.body.get("filename", ""))
    try:
        content = base64.b64decode(c.body.get("file_b64", ""))
    except Exception:
        raise ApiError(400, "Файл повреждён")
    parsed, recognized, skipped = parse_statement(read_table(filename, content), comp["years"])
    if not recognized:
        raise ApiError(400, "В файле не найдено ни одной строки с известным кодом (1150, 2110 …)")
    merged = load_financials(c.db, cid)
    for y, vals in parsed.items():
        merged.setdefault(y, {}).update(vals)
    save_financials(c.db, comp, merged)
    audit(c.db, c.user, "financials.import", "company", cid,
          {"file": filename, "rows": recognized})
    return {"financials": load_financials(c.db, cid), "recognized": recognized,
            "skipped_years": skipped}


def statement_rows(years, fin):
    out = [["Код", "Наименование"] + list(years)]
    for form in ("balance", "pnl", "extra"):
        for sec in calc.FORMS[form]:
            out.append([None, sec["section"]])
            for ln in sec["lines"]:
                out.append([ln["code"], ln["name"]] +
                           [(fin.get(str(y)) or {}).get(ln["code"]) for y in years])
    return out


@route("GET", r"/api/companies/(\d+)/source\.(csv|xlsx)")
def source_export(c, cid, ext):
    comp = get_company(c.db, cid)
    table = statement_rows(comp["years"], load_financials(c.db, cid))
    audit(c.db, c.user, "export.source", "company", cid, {"format": ext})
    fname = f"ishodnye-dannye-{comp['inn']}.{ext}"
    if ext == "xlsx":
        return Download(xlsx.write([("Исходные данные", table, 1)]), XLSX_TYPE, fname)
    out = io.StringIO()
    w = csv.writer(out, delimiter=";", lineterminator="\r\n")
    for r in table:
        w.writerow([fmt_csv(x) if isinstance(x, float) else ("" if x is None else x) for x in r])
    return Download(("﻿" + out.getvalue()).encode(), "text/csv; charset=utf-8", fname)


XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# --- расчёты

def bench_for(db, version_id, industry, size, custom):
    out = {}
    for r in db.execute("SELECT * FROM benchmarks WHERE version_id=? AND industry_code=? AND size_code=?",
                        (version_id, industry, size)):
        out[r["indicator"]] = {"mean": r["mean"], "median": r["median"], "low": r["low"],
                               "high": r["high"], "source": "справочник"}
    for iid, v in (custom or {}).items():
        if iid not in out:  # пользовательские значения — только если их нет в справочнике
            out[iid] = {**v, "source": "введено пользователем"}
    return out


def name_of(db, table, code):
    r = db.execute(f"SELECT name FROM {table} WHERE code=?", (code,)).fetchone()
    return r["name"] if r else code


def build_run(c, cid):
    comp = get_company(c.db, cid)
    b = c.body
    version = c.db.execute("SELECT * FROM ref_versions WHERE id=?",
                           (int(b.get("version_id") or current_version(c.db)["id"]),)).fetchone()
    if not version:
        raise ApiError(400, "Версия справочника не найдена")
    industry = b.get("industry") or comp["industry_code"]
    size = b.get("size") or comp["size_code"]
    basis = b.get("basis") if b.get("basis") in BASIS else "mean"
    selected = b.get("indicators")
    if selected is not None:
        selected = [i for i in selected if i in calc.IND_BY_ID]
    fin = load_financials(c.db, cid)
    result = calc.run(comp["years"], fin,
                      bench_for(c.db, version["id"], industry, size, comp["custom_bench"]),
                      selected, basis)
    result["title"] = {
        "company": comp["name"], "inn": comp["inn"], "okved": comp["okved"],
        "industry": name_of(c.db, "industries", comp["industry_code"]),
        "size": name_of(c.db, "sizes", comp["size_code"]),
        "bench_industry_code": industry, "bench_size_code": size,
        "bench_industry": name_of(c.db, "industries", industry),
        "bench_size": name_of(c.db, "sizes", size),
        "region": comp["region"], "period": f"{comp['year_from']}–{comp['year_to']}",
        "currency": comp["currency"], "unit": comp["unit"],
        "generated_at": now(), "ref_version": version["label"], "ref_version_id": version["id"],
        "engine_version": calc.ENGINE_VERSION, "basis": basis, "author": c.user["login"],
    }
    params = {"indicators": selected, "basis": basis, "industry": industry, "size": size,
              "version_id": version["id"]}
    return comp, fin, params, result


@route("POST", r"/api/companies/(\d+)/preview")
def run_preview(c, cid):
    """Расчёт без сохранения: проверка полноты и фильтры дашборда."""
    return build_run(c, cid)[3]


@route("POST", r"/api/companies/(\d+)/runs", roles=WRITE_DATA)
def run_create(c, cid):
    comp, fin, params, result = build_run(c, cid)
    if result["missing"]:
        raise ApiError(422, "Данные неполные: " + "; ".join(result["missing"]))
    cur = c.db.execute(
        "INSERT INTO runs(company_id,created_at,user_login,ref_version_id,engine_version,params,snapshot,result) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (cid, result["title"]["generated_at"], c.user["login"], params["version_id"],
         calc.ENGINE_VERSION, json.dumps(params), json.dumps({"company": comp, "financials": fin}),
         json.dumps(result)))
    result["run_id"] = cur.lastrowid
    audit(c.db, c.user, "run.create", "run", cur.lastrowid, {"company": cid, **params})
    return result


@route("GET", r"/api/companies/(\d+)/runs")
def run_list(c, cid):
    return rows(c.db.execute(
        "SELECT r.id, r.created_at, r.user_login, r.engine_version, r.params, v.label AS ref_version "
        "FROM runs r LEFT JOIN ref_versions v ON v.id=r.ref_version_id "
        "WHERE r.company_id=? ORDER BY r.id DESC", (cid,)))


def get_run(db, rid):
    r = db.execute("SELECT * FROM runs WHERE id=?", (rid,)).fetchone()
    if not r:
        raise ApiError(404, "Расчёт не найден")
    return r


@route("GET", r"/api/runs/(\d+)")
def run_get(c, rid):
    r = get_run(c.db, rid)
    result = json.loads(r["result"])
    result["run_id"] = r["id"]
    return result


def unit_label(ind, title):
    if ind["unit"] == "money":
        return f"{title['unit']} {title['currency']}".strip()
    return calc.UNITS[ind["unit"]]


@route("GET", r"/api/runs/(\d+)/export\.xlsx")
def run_export(c, rid):
    r = get_run(c.db, rid)
    res, snap = json.loads(r["result"]), json.loads(r["snapshot"])
    t, years = res["title"], res["years"]
    ys = [str(y) for y in years]
    title = [["Сводный аналитический отчёт"],
             ["Предприятие", t["company"]], ["ИНН", t["inn"]], ["ОКВЭД", t["okved"]],
             ["Отрасль", t["industry"]], ["Размер бизнеса", t["size"]],
             ["База сравнения", f"{t['bench_industry']} / {t['bench_size']} ({BASIS[t['basis']]})"],
             ["Период анализа", t["period"]], ["Единицы измерения", f"{t['unit']} {t['currency']}"],
             ["Дата формирования", t["generated_at"]], ["Версия справочников", t["ref_version"]],
             ["Версия расчётного модуля", t["engine_version"]], ["Сформировал", t["author"]],
             [],
             ["Отчёт содержит только факты, отклонения и динамику. Рекомендаций и прогнозов не содержит."]]
    for w in res["warnings"]:
        title.append(["Замечание к данным", w])
    ind_rows = [["Показатель", "Ед."] + years + ["Изменение, абс.", "Изменение, %"]]
    cmp_rows = [["Показатель", "Ед.", "Год", "Предприятие", "Среднее по отрасли", "Медиана по отрасли",
                 "Норма: от", "Норма: до", "База сравнения", "Отклонение, абс.", "Отклонение, %",
                 "Отклонение, п.п.", "Положение", "Источник отраслевых данных"]]
    tr_rows = [["Показатель", "Ед."] + years + ["Тренд", "Среднегодовой темп (CAGR), %",
                                                 "Среднегодовое изменение, абс."]]
    calc_rows = [["Показатель", "Формула", "Год", "Числитель", "Значение числителя",
                  "Знаменатель", "Значение знаменателя", "Результат", "Примечания"]]
    for ind in res["indicators"]:
        u, tr = unit_label(ind, t), ind["trend"]
        vals = [ind["years"][y]["value"] for y in ys]
        ind_rows.append([ind["name"], u] + vals + [tr["change_abs"], tr["change_pct"]])
        tr_rows.append([ind["name"], u] + vals + [DIRECTION.get(tr["direction"], "нет данных"),
                                                   tr["cagr"], tr["avg_abs"]])
        bench = ind.get("bench") or {}
        for y in ys:
            yr = ind["years"][y]
            calc_rows.append([ind["name"], ind["formula"], int(y), ind["num_label"], yr["num"],
                              ind["den_label"], yr["den"], yr["value"], "; ".join(yr["notes"])])
            cm = yr.get("compare")
            if ind["group"] != "abs":
                cmp_rows.append([ind["name"], u, int(y), yr["value"], bench.get("mean"), bench.get("median"),
                                 bench.get("low"), bench.get("high")] +
                                ([cm["base"], cm["abs_dev"], cm["pct_dev"], cm["pp_dev"],
                                  POSITION[cm["position"]]] if cm else [None] * 4 + ["нет данных"]) +
                                [bench.get("source")])
    audit(c.db, c.user, "export.report", "run", rid, {"format": "xlsx"})
    return Download(xlsx.write([
        ("Титул", title, 1), ("Показатели", ind_rows, 1), ("Сравнение с отраслью", cmp_rows, 1),
        ("Тренды", tr_rows, 1), ("Расчёты", calc_rows, 1),
        ("Исходные данные", statement_rows(years, snap["financials"]), 1),
    ]), XLSX_TYPE, f"otchet-{t['inn']}-{r['id']}.xlsx")


# --- администрирование

@route("GET", "/api/users", roles={"admin"})
def users(c):
    return [public_user(u) for u in c.db.execute("SELECT * FROM users ORDER BY login")]


@route("POST", "/api/users", roles={"admin"})
def user_create(c):
    login_, name, role = (str(c.body.get(k, "")).strip() for k in ("login", "name", "role"))
    login_ = login_.lower()
    if not re.fullmatch(r"[a-z0-9_.\-]{3,32}", login_) or not name or role not in ROLES:
        raise ApiError(400, "Логин — 3–32 латинских символа; укажите имя и роль")
    check_password(str(c.body.get("password", "")))
    if c.db.execute("SELECT 1 FROM users WHERE login=?", (login_,)).fetchone():
        raise ApiError(409, "Такой логин уже существует")
    add_user(c.db, login_, name, role, str(c.body["password"]))
    audit(c.db, c.user, "user.create", "user", login_, {"role": role})
    return {"ok": True}


@route("PUT", r"/api/users/(\d+)", roles={"admin"})
def user_update(c, uid):
    u = c.db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        raise ApiError(404, "Пользователь не найден")
    role = c.body.get("role", u["role"])
    active = 1 if c.body.get("active", u["active"]) else 0
    if role not in ROLES:
        raise ApiError(400, "Неизвестная роль")
    if u["id"] == c.user["id"] and (role != "admin" or not active):
        raise ApiError(400, "Нельзя снять права администратора с самого себя")
    c.db.execute("UPDATE users SET role=?, active=?, name=? WHERE id=?",
                 (role, active, str(c.body.get("name") or u["name"]), uid))
    if c.body.get("password"):
        check_password(str(c.body["password"]))
        salt = secrets.token_hex(16)
        c.db.execute("UPDATE users SET salt=?, pwd_hash=? WHERE id=?",
                     (salt, hash_pwd(str(c.body["password"]), salt), uid))
    if not active:
        c.db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
    audit(c.db, c.user, "user.update", "user", u["login"], {"role": role, "active": active})
    return {"ok": True}


@route("GET", "/api/audit", roles=SEE_LOG)
def audit_list(c):
    limit = min(int(c.query.get("limit") or 300), 2000)
    return rows(c.db.execute("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,)))


@route("GET", "/api/backups", roles=SEE_LOG)
def backups(c):
    return [{"name": p.name, "size": p.stat().st_size,
             "created_at": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")}
            for p in sorted(BACKUPS.glob("app-*.db"), reverse=True)]


@route("POST", "/api/backups", roles=SEE_LOG)
def backup_now(c):
    c.db.commit()
    name = make_backup("manual")
    audit(c.db, c.user, "backup.create", "backup", name)
    return {"name": name}


# ---------------------------------------------------------------- HTTP

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; "
                               "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "OAK/1.0"

    def log_message(self, fmt, *args):
        pass

    def send(self, status, content, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, status, obj, extra=None):
        self.send(status, json.dumps(obj, ensure_ascii=False).encode(),
                  "application/json; charset=utf-8", {"Cache-Control": "no-store", **(extra or {})})

    def session_user(self, db):
        m = re.search(r"(?:^|;\s*)sid=([\w\-]+)", self.headers.get("Cookie", ""))
        if not m:
            return None
        return db.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE s.token=? AND s.expires>? AND u.active=1", (m.group(1), time.time())).fetchone()

    def static(self, path):
        rel = "index.html" if path == "/" else path.lstrip("/")
        target = (STATIC / rel).resolve()
        if STATIC.resolve() not in target.parents or not target.is_file():
            return self.send(404, b"Not found", "text/plain; charset=utf-8")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self.send(200, target.read_bytes(), ctype, {"Cache-Control": "no-cache"})

    def handle_api(self, method):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            if method == "GET":
                return self.static(url.path)
            return self.send_json(405, {"error": "Метод не поддерживается"})
        db = connect()
        try:
            for m, rx, roles, public, fn in ROUTES:
                match = rx.match(url.path)
                if m != method or not match:
                    continue
                user = None if public else self.session_user(db)
                if not public and not user:
                    raise ApiError(401, "Требуется вход в систему")
                if roles and user["role"] not in roles:
                    audit(db, user, "access.denied", "route", url.path)
                    db.commit()
                    raise ApiError(403, "Недостаточно прав для этого действия")
                body = {}
                if method != "GET":
                    if self.headers.get("X-Requested-With") != "fetch":
                        raise ApiError(403, "Запрос отклонён")
                    length = int(self.headers.get("Content-Length") or 0)
                    if length > MAX_BODY:
                        raise ApiError(413, "Слишком большой запрос")
                    if length:
                        try:
                            body = json.loads(self.rfile.read(length))
                        except ValueError:
                            raise ApiError(400, "Некорректный JSON")
                        if not isinstance(body, dict):
                            raise ApiError(400, "Ожидается объект JSON")
                ctx = Ctx(db, user, body, {k: v[0] for k, v in parse_qs(url.query).items()}, self)
                out = fn(ctx, *match.groups())
                db.commit()
                extra = {"Set-Cookie": ctx.set_cookie} if ctx.set_cookie else None
                if isinstance(out, Download):
                    return self.send(200, out.content, out.ctype, {
                        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(out.filename)}",
                        "Cache-Control": "no-store"})
                return self.send_json(200, out, extra)
            raise ApiError(404, "Не найдено")
        except ApiError as e:
            db.rollback()
            self.send_json(e.status, {"error": e.message})
        except Exception as e:
            db.rollback()
            print(f"[{now()}] {method} {url.path}: {e!r}")
            self.send_json(500, {"error": "Внутренняя ошибка сервера"})
        finally:
            db.close()

    def do_GET(self):
        self.handle_api("GET")

    def do_POST(self):
        self.handle_api("POST")

    def do_PUT(self):
        self.handle_api("PUT")

    def do_DELETE(self):
        self.handle_api("DELETE")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    args = ap.parse_args()
    init_db()
    threading.Thread(target=backup_loop, daemon=True).start()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Сервер запущен: http://{args.host}:{args.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
