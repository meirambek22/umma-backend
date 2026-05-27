// ============================================================
// UMMA AI — Backend (сервер-посредник)
// Безопасный backend для Claude + Госзакупок
// ============================================================

const express = require("express");
const cors = require("cors");

// Node 18+ имеет fetch встроенный.
// Для Node <18:
// npm install node-fetch
// const fetch = require("node-fetch");

const app = express();

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());

app.use(express.json({
  limit: "10mb"
}));

// ============================================================
// ENV
// ============================================================

const CLAUDE_KEY = process.env.CLAUDE_KEY || "";
const GOSZAKUP_TOKEN = process.env.GOSZAKUP_TOKEN || "";

if (!CLAUDE_KEY) {
  console.warn("⚠ CLAUDE_KEY не найден");
}

if (!GOSZAKUP_TOKEN) {
  console.warn("⚠ GOSZAKUP_TOKEN не найден");
}

// ============================================================
// CONSTANTS
// ============================================================

// Проверь endpoint если API изменится
const GZ_BASE = "https://ows.goszakup.gov.kz/v3";

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "UMMA backend",
    time: new Date().toISOString()
  });
});

// ============================================================
// SAFE FETCH
// ============================================================

async function gzFetch(path, options = {}) {

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 30000);

  try {

    const response = await fetch(GZ_BASE + path, {
      ...options,
      signal: controller.signal,
      headers: {
        "Authorization": "Bearer " + GOSZAKUP_TOKEN,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    const text = await response.text();

    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      throw new Error("Некорректный JSON от API госзакупок");
    }

    if (!response.ok) {
      throw new Error(
        "Ошибка API госзакупок: " +
        response.status +
        " " +
        JSON.stringify(data)
      );
    }

    return data;

  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// GRAPHQL HELPER
// ============================================================

async function gzGraphQL(query, variables = {}) {

  const data = await gzFetch("/graphql", {
    method: "POST",
    body: JSON.stringify({
      query,
      variables
    })
  });

  if (data.errors) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data.data;
}

// ============================================================
// CLAUDE PROXY
// ============================================================

app.post("/api/claude", async (req, res) => {

  if (!CLAUDE_KEY) {
    return res.status(500).json({
      error: "CLAUDE_KEY не настроен"
    });
  }

  try {

    const response = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CLAUDE_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(req.body)
      }
    );

    const text = await response.text();

    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {
        raw: text
      };
    }

    res.status(response.status).json(data);

  } catch (e) {

    res.status(500).json({
      error: "Ошибка обращения к Claude: " + e.message
    });

  }
});

// ============================================================
// SEARCH SIMILAR TENDERS
// ============================================================

app.get("/api/goszakup/search", async (req, res) => {

  if (!GOSZAKUP_TOKEN) {
    return res.status(500).json({
      error: "GOSZAKUP_TOKEN не настроен"
    });
  }

  try {

    const word = String(req.query.q || "").trim();

    if (!word) {
      return res.status(400).json({
        error: "Укажите query параметр q"
      });
    }

    const query = `
      query($limit: Int, $after: Int) {
        Lots(limit: $limit, after: $after) {
          id
          lotNumber
          nameRu
          amount
          count
          customerNameRu
          trdBuyNumberAnno
          dumping
          refLotStatusId
        }
      }
    `;

    let matched = [];
    let after = 0;

    const LIMIT = 200;
    const PAGES = 10;

    const searchWords = word
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2);

    for (let page = 0; page < PAGES; page++) {

      const data = await gzGraphQL(query, {
        limit: LIMIT,
        after
      });

      const lots = data?.Lots || [];

      if (!lots.length) {
        break;
      }

      const filtered = lots.filter(lot => {

        const text = String(lot.nameRu || "")
          .toLowerCase();

        return searchWords.some(sw =>
          text.includes(sw)
        );
      });

      matched = matched.concat(filtered);

      after = lots[lots.length - 1].id;

      if (matched.length >= 50) {
        break;
      }
    }

    const items = matched
      .filter(l => Number(l.amount) > 0)
      .map(l => ({
        lotNumber: l.lotNumber,
        name: l.nameRu || "",
        amount: Number(l.amount || 0),
        count: Number(l.count || 0),
        customer: l.customerNameRu || "",
        annoNumber: l.trdBuyNumberAnno || "",
        dumping: l.dumping || 0,
        status: l.refLotStatusId || ""
      }));

    const amounts = items
      .map(i => i.amount)
      .sort((a, b) => a - b);

    let stats = null;

    if (amounts.length) {

      const sum = amounts.reduce((a, b) => a + b, 0);

      stats = {
        count: amounts.length,
        avg: Math.round(sum / amounts.length),
        min: amounts[0],
        max: amounts[amounts.length - 1],
        median: amounts[Math.floor(amounts.length / 2)]
      };
    }

    res.json({
      query: word,
      found: items.length,
      stats,
      lots: items.slice(0, 20)
    });

  } catch (e) {

    res.status(500).json({
      error: e.message
    });

  }
});

// ============================================================
// LOTS SEARCH
// ============================================================

app.get("/api/goszakup/lots", async (req, res) => {

  if (!GOSZAKUP_TOKEN) {
    return res.status(500).json({
      error: "GOSZAKUP_TOKEN не настроен"
    });
  }

  try {

    const q = encodeURIComponent(req.query.q || "");

    const data = await gzFetch(
      "/lots?nameRu=" + q + "&limit=20"
    );

    res.json(data);

  } catch (e) {

    res.status(500).json({
      error: e.message
    });

  }
});

// ============================================================
// CONTRACTS
// ============================================================

app.get("/api/goszakup/contracts", async (req, res) => {

  if (!GOSZAKUP_TOKEN) {
    return res.status(500).json({
      error: "GOSZAKUP_TOKEN не настроен"
    });
  }

  try {

    const trdBuyId = encodeURIComponent(
      req.query.trdBuy || ""
    );

    if (!trdBuyId) {
      return res.status(400).json({
        error: "Не указан trdBuy"
      });
    }

    const data = await gzFetch(
      "/contracts?trdBuyId=" +
      trdBuyId +
      "&limit=20"
    );

    res.json(data);

  } catch (e) {

    res.status(500).json({
      error: e.message
    });

  }
});

// ============================================================
// MARGIN ANALYTICS
// ============================================================

app.get("/api/goszakup/margin", async (req, res) => {

  if (!GOSZAKUP_TOKEN) {
    return res.status(500).json({
      error: "GOSZAKUP_TOKEN не настроен"
    });
  }

  try {

    const q = encodeURIComponent(req.query.q || "");

    const lots = await gzFetch(
      "/lots?nameRu=" + q + "&limit=30"
    );

    const arr = lots.items || (
      Array.isArray(lots)
        ? lots
        : []
    );

    const items = arr
      .map(l => ({
        name: l.name_ru || l.nameRu || "",
        amount: Number(l.amount || l.sum || 0),
        count: Number(l.count || l.quantity || 0),
        customer: l.customer_name_ru || l.customerNameRu || "",
        dumping: l.dumping || 0
      }))
      .filter(x => x.amount > 0);

    const amounts = items
      .map(i => i.amount)
      .sort((a, b) => a - b);

    let stats = null;

    if (amounts.length) {

      const sum = amounts.reduce((a, b) => a + b, 0);

      stats = {
        count: amounts.length,
        avg: Math.round(sum / amounts.length),
        min: amounts[0],
        max: amounts[amounts.length - 1],
        median: amounts[Math.floor(amounts.length / 2)]
      };
    }

    res.json({
      query: req.query.q,
      total: items.length,
      stats,
      lots: items.slice(0, 20)
    });

  } catch (e) {

    res.status(500).json({
      error: e.message
    });

  }
});

// ============================================================
// WINS TEST
// ============================================================

app.get("/api/goszakup/wins", async (req, res) => {

  try {

    const year = new Date().getFullYear();

    const startDate = `${year}-01-01`;

    const query = `
      query($limit: Int) {
        Lots(limit: $limit) {
          id
          nameRu
          amount
        }
      }
    `;

    const data = await gzGraphQL(query, {
      limit: 10
    });

    res.json({
      ok: true,
      startDate,
      data
    });

  } catch (e) {

    res.status(500).json({
      error: e.message
    });

  }
});

// ============================================================
// GLOBAL ERROR HANDLERS
// ============================================================

process.on("unhandledRejection", err => {
  console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", err => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 UMMA backend запущен на порту " + PORT);
});
