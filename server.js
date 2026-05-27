const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// =====================================================
// ENV
// =====================================================

const CLAUDE_KEY = process.env.CLAUDE_KEY || "";
const GOSZAKUP_TOKEN = process.env.GOSZAKUP_TOKEN || "";

// =====================================================
// CONFIG
// =====================================================

const PORT = process.env.PORT || 10000;

const GZ_BASE = "https://ows.goszakup.gov.kz/v3";

// =====================================================
// ROOT
// =====================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "UMMA backend"
  });
});

// =====================================================
// SAFE FETCH
// =====================================================

async function safeFetch(url, options = {}) {

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 30000);

  try {

    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const text = await response.text();

    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      data = {
        raw: text
      };
    }

    if (!response.ok) {
      throw new Error(
        "HTTP " +
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

// =====================================================
// CLAUDE API
// =====================================================

app.post("/api/claude", async (req, res) => {

  try {

    if (!CLAUDE_KEY) {
      return res.status(500).json({
        error: "CLAUDE_KEY отсутствует"
      });
    }

    const data = await safeFetch(
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

    res.json(data);

  } catch (e) {

    res.status(500).json({
      error: e.message
    });

  }
});

// =====================================================
// SEARCH TENDERS
// =====================================================

app.get("/api/goszakup/search", async (req, res) => {

  try {

    if (!GOSZAKUP_TOKEN) {
      return res.status(500).json({
        error: "GOSZAKUP_TOKEN отсутствует"
      });
    }

    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.status(400).json({
        error: "Укажите q"
      });
    }

    // =================================================
    // GRAPHQL QUERY
    // =================================================

    const query = `
      query Lots($limit: Int, $after: Int) {
        Lots(limit: $limit, after: $after) {
          id
          nameRu
          amount
          customerNameRu
          lotNumber
        }
      }
    `;

    const graphqlData = await safeFetch(
      GZ_BASE + "/graphql",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + GOSZAKUP_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query,
          variables: {
            limit: 200,
            after: 0
          }
        })
      }
    );

    const lots =
      graphqlData?.data?.Lots || [];

    const search = q.toLowerCase();

    const filtered = lots.filter(lot => {

      const name =
        String(lot.nameRu || "")
          .toLowerCase();

      return name.includes(search);

    });

    const items = filtered.map(lot => ({
      id: lot.id,
      lotNumber: lot.lotNumber,
      name: lot.nameRu,
      amount: Number(lot.amount || 0),
      customer: lot.customerNameRu || ""
    }));

    const amounts = items
      .map(x => x.amount)
      .filter(x => x > 0)
      .sort((a, b) => a - b);

    let stats = null;

    if (amounts.length) {

      const sum = amounts.reduce(
        (a, b) => a + b,
        0
      );

      stats = {
        count: amounts.length,
        avg: Math.round(sum / amounts.length),
        min: amounts[0],
        max: amounts[amounts.length - 1],
        median:
          amounts[
            Math.floor(amounts.length / 2)
          ]
      };
    }

    res.json({
      ok: true,
      query: q,
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

// =====================================================
// TEST
// =====================================================

app.get("/test", (req, res) => {
  res.json({
    ok: true,
    message: "server works"
  });
});

// =====================================================
// GLOBAL ERRORS
// =====================================================

process.on("unhandledRejection", err => {
  console.error(err);
});

process.on("uncaughtException", err => {
  console.error(err);
});

// =====================================================
// START
// =====================================================

app.listen(PORT, "0.0.0.0", () => {

  console.log(
    "Server started on port " + PORT
  );

});
