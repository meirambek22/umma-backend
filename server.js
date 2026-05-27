// ============================================================
// UMMA AI — Backend (сервер-посредник)
// Прячет ключ Claude и токен госзакупок. Браузер их не видит.
// ============================================================

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());                       // разрешаем запросы с твоего сайта
app.use(express.json({ limit: "10mb" })); // принимаем JSON (ТЗ может быть большим)

// Ключи берутся из переменных окружения Render (НЕ хранятся в коде!)
const CLAUDE_KEY   = process.env.CLAUDE_KEY   || "";
const GOSZAKUP_TOKEN = process.env.GOSZAKUP_TOKEN || "";

// ---------- Проверка что сервер жив ----------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "UMMA backend", time: new Date().toISOString() });
});

// ============================================================
// 1) ПРОКСИ ДЛЯ CLAUDE — сайт шлёт сюда, мы идём в Claude с ключом
// ============================================================
app.post("/api/claude", async (req, res) => {
  if (!CLAUDE_KEY) return res.status(500).json({ error: "CLAUDE_KEY не настроен на сервере" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(req.body)   // тело запроса приходит с сайта как есть
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: "Ошибка обращения к Claude: " + e.message });
  }
});

// ============================================================
// 2) ГОСЗАКУПКИ — поиск похожих тендеров и цен победителей
//    Используется для маржи и победной цены на реальных данных.
// ============================================================

// Базовый адрес API госзакупок (REST v3)
const GZ_BASE = "https://ows.goszakup.gov.kz/v3";

// вспомогательная функция запроса к госзакупкам с токеном
async function gzFetch(path) {
  const r = await fetch(GZ_BASE + path, {
    headers: { "Authorization": "Bearer " + GOSZAKUP_TOKEN }
  });
  if (!r.ok) throw new Error("Госзакупки вернули статус " + r.status);
  return r.json();
}

// GraphQL-запрос к госзакупкам (POST на /v3/graphql)
async function gzGraphQL(query, variables) {
  const r = await fetch(GZ_BASE + "/graphql", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + GOSZAKUP_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query: query, variables: variables || {} })
  });
  const data = await r.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

// Поиск завершённых лотов по слову в названии (GraphQL).
// ref_lot_status_id: статусы завершённых лотов (берём несколько на пробу).
app.get("/api/goszakup/search", async (req, res) => {
  if (!GOSZAKUP_TOKEN) return res.status(500).json({ error: "GOSZAKUP_TOKEN не настроен на сервере" });
  const word = (req.query.q || "").trim();
  try {
    // GraphQL: тянем лоты, фильтруем по статусу завершённости.
    // Поиск по названию делаем на нашей стороне (фильтр содержит слово), т.к. в схеме нет name-фильтра.
    const query = `query($limit: Int, $after: Int, $status: [Int]) {
      Lots(filter: { ref_lot_status_id: $status }, limit: $limit, after: $after) {
        id
        lotNumber
        nameRu
        amount
        count
        customerBin
        customerNameRu
        trdBuyNumberAnno
        trdBuyId
        dumping
        RefLotsStatus { nameRu }
      }
    }`;
    // статусы: 330 (опубликован), 350/360 (итоги/завершён) — пробуем набор
    const data = await gzGraphQL(query, { limit: 200, after: 0, status: [330, 350, 360, 240, 220] });
    let lots = (data && data.Lots) ? data.Lots : [];
    // Фильтр по слову в названии (на нашей стороне) — точный поиск
    if (word) {
      const w = word.toLowerCase();
      const words = w.split(/\s+/).filter(function (x) { return x.length > 2; });
      lots = lots.filter(function (l) {
        const n = (l.nameRu || "").toLowerCase();
        return words.some(function (ww) { return n.indexOf(ww) >= 0; });
      });
    }
    const items = lots.map(function (l) {
      return {
        lotNumber: l.lotNumber,
        name: l.nameRu || "",
        amount: l.amount || 0,
        count: l.count || 0,
        customer: l.customerNameRu || "",
        annoNumber: l.trdBuyNumberAnno || "",
        dumping: l.dumping || 0,
        status: (l.RefLotsStatus && l.RefLotsStatus.nameRu) || ""
      };
    }).filter(function (x) { return x.amount > 0; });

    // статистика
    let stats = null;
    if (items.length) {
      const amounts = items.map(function (i) { return i.amount; }).sort(function (a, b) { return a - b; });
      const sum = amounts.reduce(function (a, b) { return a + b; }, 0);
      stats = { count: amounts.length, avg: Math.round(sum / amounts.length), min: amounts[0], max: amounts[amounts.length - 1], median: amounts[Math.floor(amounts.length / 2)] };
    }
    res.json({ query: word, found: items.length, stats: stats, lots: items.slice(0, 15) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Поиск лотов по названию (что закупали раньше)
// Пример: /api/goszakup/lots?q=светодиодный маяк
app.get("/api/goszakup/lots", async (req, res) => {
  if (!GOSZAKUP_TOKEN) return res.status(500).json({ error: "GOSZAKUP_TOKEN не настроен на сервере" });
  try {
    const q = encodeURIComponent(req.query.q || "");
    // ищем в реестре лотов по ключевому слову (name_ru)
    const data = await gzFetch("/lots?nameRu=" + q + "&limit=20");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Поиск договоров (реальные цены, по которым заключали) по номеру объявления
// Пример: /api/goszakup/contracts?trdBuy=12345
app.get("/api/goszakup/contracts", async (req, res) => {
  if (!GOSZAKUP_TOKEN) return res.status(500).json({ error: "GOSZAKUP_TOKEN не настроен на сервере" });
  try {
    const id = encodeURIComponent(req.query.trdBuy || "");
    const data = await gzFetch("/contract?trdBuyId=" + id + "&limit=20");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 3) МАРЖА ТЕНДЕРА — связываем: ищем похожие лоты → их договоры →
//    реальные цены побед → отдаём сайту для расчёта.
//    (Базовая версия: вернём похожие лоты и их суммы.)
// ============================================================
app.get("/api/goszakup/margin", async (req, res) => {
  if (!GOSZAKUP_TOKEN) return res.status(500).json({ error: "GOSZAKUP_TOKEN не настроен на сервере" });
  try {
    const q = encodeURIComponent(req.query.q || "");
    const lots = await gzFetch("/lots?nameRu=" + q + "&limit=30");
    const arr = lots.items || (Array.isArray(lots) ? lots : []);
    const items = arr.map(function (l) {
      return {
        name: l.name_ru || l.nameRu || "",
        amount: l.amount || l.sum || 0,
        count: l.count || l.quantity || 0,
        customer: l.customer_name_ru || l.customerNameRu || "",
        dumping: l.dumping || 0
      };
    }).filter(function (x) { return x.amount > 0; });

    // Статистика по суммам похожих тендеров (для расчёта реальной цены)
    let stats = null;
    if (items.length) {
      const amounts = items.map(function (i) { return i.amount; }).sort(function (a, b) { return a - b; });
      const sum = amounts.reduce(function (a, b) { return a + b; }, 0);
      stats = {
        count: amounts.length,
        avg: Math.round(sum / amounts.length),
        min: amounts[0],
        max: amounts[amounts.length - 1],
        median: amounts[Math.floor(amounts.length / 2)]
      };
    }
    res.json({ query: req.query.q, total: lots.total || items.length, found: items.length, stats: stats, lots: items.slice(0, 15) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("UMMA backend запущен на порту " + PORT);
});
