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
    // GraphQL сам ищет по названию/описанию (nameDescriptionRu). Без листания тысяч страниц!
    const query = `query($limit: Int, $after: Int, $q: String) {
      Lots(filter: { nameDescriptionRu: $q }, limit: $limit, after: $after) {
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
        refLotStatusId
        lastUpdateDate
      }
    }`;

    let matched = [];
    let after = 0;
    const PAGES = 10;       // на случай если совпадений много — листаем страницы результатов
    const PER = 200;
    for (let p = 0; p < PAGES; p++) {
      const data = await gzGraphQL(query, { limit: PER, after: after, q: word });
      const lots = (data && data.Lots) ? data.Lots : [];
      if (!lots.length) break;
      matched = matched.concat(lots);
      after = lots[lots.length - 1].id;
      if (lots.length < PER) break;       // последняя страница
      if (matched.length >= 200) break;   // достаточно
    }

    const items = matched.map(function (l) {
      const cnt = l.count || 0;
      const amt = l.amount || 0;
      return {
        lotNumber: l.lotNumber,
        name: l.nameRu || "",
        amount: amt,
        count: cnt,
        unitPrice: cnt > 0 ? Math.round(amt / cnt) : 0,   // цена за штуку
        customer: l.customerNameRu || "",
        annoNumber: l.trdBuyNumberAnno || "",
        dumping: l.dumping || 0,
        status: l.refLotStatusId || ""
      };
    }).filter(function (x) { return x.amount > 0; });

    let stats = null;
    if (items.length) {
      const amounts = items.map(function (i) { return i.amount; }).sort(function (a, b) { return a - b; });
      const sum = amounts.reduce(function (a, b) { return a + b; }, 0);
      // цены за штуку (только где есть количество)
      const units = items.map(function (i) { return i.unitPrice; }).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
      let unitStats = null;
      if (units.length) {
        const usum = units.reduce(function (a, b) { return a + b; }, 0);
        unitStats = { avg: Math.round(usum / units.length), min: units[0], max: units[units.length - 1], median: units[Math.floor(units.length / 2)] };
      }
      stats = {
        count: amounts.length,
        avg: Math.round(sum / amounts.length), min: amounts[0], max: amounts[amounts.length - 1], median: amounts[Math.floor(amounts.length / 2)],
        unit: unitStats   // статистика цены за штуку
      };
    }
    res.json({ query: word, found: items.length, stats: stats, lots: items.slice(0, 13) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// РЕАЛЬНЫЕ ЦЕНЫ ПОБЕД через Contract (точные поля из интроспекции).
// /api/goszakup/wins?q=бритва
app.get("/api/goszakup/wins", async (req, res) => {
  if (!GOSZAKUP_TOKEN) return res.status(500).json({ error: "GOSZAKUP_TOKEN не настроен на сервере" });
  const word = (req.query.q || "бритва").trim();
  // Способ проверки: можно ли фильтровать Contract по названию (descriptionRu) и какие поля цены
  const t = req.query.try || "1";
  const queries = {
    // 1) ContractUnits ВНУТРИ Contract — правильный путь (itemPrice = цена за штуку победителя)
    "1": `{ Contract(limit:5){ id descriptionRu contractSum supplierFio ContractUnits{ lotId itemPrice quantity totalSum } } }`,
    // 2) Поля фильтра Contract (можно ли фильтровать по trdBuyId/trdBuyNumberAnno)
    "2": `{ __type(name:"ContractFiltersInput"){ name inputFields{ name type{ name kind } } } }`,
    // 3) Договоры без фильтра — примеры
    "3": `{ Contract(limit:5){ id descriptionRu contractSum faktSum supplierFio } }`,
    // 4) Contract по trdBuyId (связь с объявлением, у лота тоже есть trdBuyId)
    "4": `{ Contract(filter:{trdBuyId:[${(req.query.tb||"0")}]}, limit:5){ id descriptionRu contractSum ContractUnits{ lotId itemPrice quantity } } }`
  };
  const query = queries[t] || queries["1"];
  try {
    const data = await gzGraphQL(query, {});
    res.json({ ok: true, tried: t, sample: data });
  } catch (e) {
    res.status(500).json({ tried: t, error: e.message });
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
