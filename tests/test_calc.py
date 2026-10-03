"""Проверка расчётного ядра на демонстрационных данных.  Запуск: python3 -m unittest -v"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import calc
import refseed
import xlsx

YEARS = [2022, 2023, 2024]
BENCH = {iid: {"mean": mean, "median": median, "low": low, "high": high}
         for ind, size, iid, mean, median, low, high in refseed.benchmarks()
         if ind == "wholesale" and size == "small"}


def result(**kw):
    res = calc.run(YEARS, refseed.DEMO_FINANCIALS, BENCH, **kw)
    return res, {i["id"]: i for i in res["indicators"]}


class NormalizeTest(unittest.TestCase):
    def test_totals_are_derived(self):
        d, w = calc.normalize(refseed.DEMO_FINANCIALS["2022"], 2022)
        self.assertEqual(w, [])
        self.assertEqual(d["1100"], 12500)
        self.assertEqual(d["1600"], 72500)
        self.assertEqual(d["1700"], 72500)
        self.assertEqual(d["2100"], 30000)
        self.assertEqual(d["2200"], 9000)
        self.assertEqual(d["2300"], 6200)
        self.assertEqual(d["2400"], 4960)

    def test_mismatch_is_reported(self):
        raw = dict(refseed.DEMO_FINANCIALS["2022"], **{"1100": 99999})
        _, w = calc.normalize(raw, 2022)
        self.assertTrue(any("1100" in x for x in w))
        self.assertTrue(any("актив" in x for x in w))

    def test_empty_year_is_missing(self):
        res = calc.run(YEARS, {"2022": refseed.DEMO_FINANCIALS["2022"]}, {})
        self.assertEqual(len(res["missing"]), 4)


class IndicatorTest(unittest.TestCase):
    def test_values(self):
        _, ind = result()
        v = lambda iid, y: ind[iid]["years"][str(y)]["value"]
        self.assertAlmostEqual(v("ros", 2022), 5.0)
        self.assertAlmostEqual(v("npm", 2024), 4400 / 240000 * 100)
        # ROA: первый год — на конец года, далее среднегодовые активы
        self.assertAlmostEqual(v("roa", 2022), 4960 / 72500 * 100)
        self.assertAlmostEqual(v("roa", 2023), 5700 / ((72500 + 87800) / 2) * 100)
        self.assertAlmostEqual(v("roe", 2024), 4400 / ((27700 + 32100) / 2) * 100)
        self.assertAlmostEqual(v("ebitda_margin", 2022), (6200 + 2200 + 1500) / 180000 * 100)
        self.assertAlmostEqual(v("abs_liq", 2022), 4500 / 42500)
        self.assertAlmostEqual(v("quick_liq", 2022), 29500 / 42500)
        self.assertAlmostEqual(v("cur_liq", 2022), 60000 / 42500)
        self.assertAlmostEqual(v("autonomy", 2024), 32100 / 102700)
        self.assertAlmostEqual(v("sos", 2024), (32100 - 16100) / 86600)
        self.assertAlmostEqual(v("leverage", 2024), (11000 + 59600) / 32100)
        self.assertAlmostEqual(v("debt_ebitda", 2024), 28000 / (5500 + 3900 + 2100))
        self.assertAlmostEqual(v("asset_turn", 2024), 240000 / ((87800 + 102700) / 2))
        self.assertAlmostEqual(v("inv_turn", 2023), 180500 / 33000)
        self.assertAlmostEqual(v("rec_turn", 2023), 215000 / 28000)
        self.assertAlmostEqual(v("pay_turn", 2023), 180500 / 34250)

    def test_selection_keeps_absolute_indicators(self):
        _, ind = result(selected=["ros"])
        self.assertEqual(set(ind), {"revenue", "net_profit", "ros"})

    def test_ebitda_unavailable_without_amortisation(self):
        fin = {y: {k: v for k, v in d.items() if k != "amort"}
               for y, d in refseed.DEMO_FINANCIALS.items()}
        res = calc.run(YEARS, fin, BENCH)
        ebitda = next(i for i in res["indicators"] if i["id"] == "ebitda_margin")
        self.assertIsNone(ebitda["years"]["2022"]["value"])
        self.assertTrue(ebitda["years"]["2022"]["notes"])

    def test_zero_denominator(self):
        r = calc.compute_year(calc.IND_BY_ID["ros"], {"2200": 5.0, "2110": 0.0}, None)
        self.assertIsNone(r["value"])


class CompareTest(unittest.TestCase):
    def test_deviation_and_position(self):
        b = {"mean": 10.0, "median": 8.0, "low": 6.0, "high": 13.0}
        c = calc.compare(4.0, b, "pct", "mean")
        self.assertEqual((c["abs_dev"], c["pct_dev"], c["pp_dev"], c["position"]),
                         (-6.0, -60.0, -6.0, "below"))
        self.assertEqual(calc.compare(12.0, b, "pct", "median")["position"], "in_range")
        self.assertEqual(calc.compare(14.0, b, "ratio", "median")["position"], "above")
        self.assertIsNone(calc.compare(14.0, b, "ratio", "median")["pp_dev"])
        self.assertIsNone(calc.compare(None, b, "pct", "mean"))
        self.assertIsNone(calc.compare(1.0, None, "pct", "mean"))

    def test_falls_back_to_other_basis(self):
        c = calc.compare(5.0, {"mean": None, "median": 4.0}, "ratio", "mean")
        self.assertEqual((c["basis"], c["position"]), ("median", "above"))


class TrendTest(unittest.TestCase):
    def test_directions(self):
        d = lambda v: calc.trend(YEARS, v)["direction"]
        self.assertEqual(d([100, 120, 150]), "up")
        self.assertEqual(d([100, 80, 60]), "down")
        self.assertEqual(d([100, 102, 101]), "stable")
        self.assertEqual(d([100, 130, 90]), "unstable")
        self.assertEqual(d([100, 101, 120]), "up")
        self.assertIsNone(d([None, None, 5]))

    def test_rates(self):
        t = calc.trend(YEARS, [100, 110, 121])
        self.assertAlmostEqual(t["cagr"], 10.0)
        self.assertAlmostEqual(t["avg_abs"], 10.5)
        self.assertAlmostEqual(t["change_pct"], 21.0)
        self.assertIsNone(calc.trend(YEARS, [-5, 1, 4])["cagr"])


class XlsxTest(unittest.TestCase):
    def test_roundtrip(self):
        data = xlsx.write([("Лист «1»", [["Код", "Имя", 2022], ["2110", "Выручка & прочее", 1234.5]], 1)])
        self.assertEqual(xlsx.read(data), [["Код", "Имя", 2022.0], ["2110", "Выручка & прочее", 1234.5]])


if __name__ == "__main__":
    unittest.main()
