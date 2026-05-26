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
    const lots = await gzFetch("/lots?nameRu=" + q + "&limit=15");
    // вытаскиваем суммы похожих лотов — основа для оценки реальной цены
    const items = (lots.items || lots || []).map(function (l) {
      return {
        name: l.nameRu || l.name_ru || "",
        amount: l.amount || l.sum || 0,
        count: l.count || l.quantity || 0,
        customer: l.customerNameRu || l.customer_name_ru || ""
      };
    });
    res.json({ query: req.query.q, found: items.length, lots: items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("UMMA backend запущен на порту " + PORT);
});
