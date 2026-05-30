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
const FIREBASE_SA  = process.env.FIREBASE_SA  || "";  // JSON Service Account (Firebase Admin)

// ---------- Firebase Admin (для заливки мозга и работы с базой) ----------
let firebaseAdmin = null;
let fbStore = null;
if (FIREBASE_SA) {
  try {
    firebaseAdmin = require("firebase-admin");
    const serviceAccount = JSON.parse(FIREBASE_SA);
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(serviceAccount)
    });
    fbStore = firebaseAdmin.firestore();
    console.log("✓ Firebase Admin подключён к проекту:", serviceAccount.project_id);
  } catch (e) {
    console.error("✗ Firebase Admin не подключён:", e.message);
  }
}

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
        isDeleted
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
      // ФИЛЬТР: убираем удалённые/отменённые лоты (их нет на сайте, юзеры не могут найти)
      const active = lots.filter(function (l) { return !l.isDeleted; });
      matched = matched.concat(active);
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

// Проверка лота по номеру — посмотреть, есть ли он, удалён ли, статус.
// /api/goszakup/checklot?n=84166392
app.get("/api/goszakup/checklot", async (req, res) => {
  if (!GOSZAKUP_TOKEN) return res.status(500).json({ error: "GOSZAKUP_TOKEN не настроен на сервере" });
  const num = (req.query.n || "").trim();
  if (!num) return res.status(400).json({ error: "Укажите n (номер лота)" });
  try {
    // Перебираем формы номера (с типичными суффиксами) по одной
    const variants = [num, num+"-ЗЦП1", num+"-1", num+"-ОИ4", num+"-ОИ1", num+"-2"];
    const query = `query($v: String){ Lots(filter:{ lotNumber:$v }, limit:5){ id lotNumber nameRu refLotStatusId isDeleted lastUpdateDate trdBuyId trdBuyNumberAnno amount count customerNameRu } }`;
    const allLots = [];
    for (const v of variants) {
      try {
        const data = await gzGraphQL(query, { v });
        const lots = (data && data.Lots) ? data.Lots : [];
        lots.forEach(l => { l._matchedVariant = v; allLots.push(l); });
      } catch (e) { /* пропускаем неудачный вариант */ }
    }
    res.json({ query: num, variantsChecked: variants, found: allLots.length, lots: allLots });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ФИНАЛ: реальные цены ПОБЕД за штуку по слову, с описаниями для отбора похожих.
// Цепочка: лоты по слову -> их trdBuyId+descriptionRu -> договоры (Contract) -> ContractUnits.itemPrice
// /api/goszakup/realwins?q=бритва
app.get("/api/goszakup/realwins", async (req, res) => {
  if (!GOSZAKUP_TOKEN) return res.status(500).json({ error: "GOSZAKUP_TOKEN не настроен на сервере" });
  const word = (req.query.q || "").trim();
  if (!word) return res.status(400).json({ error: "Укажите q" });
  try {
    // 1) Находим лоты по слову, собираем их trdBuyId, описание, имя
    const lotsQuery = `query($q: String, $limit: Int){
      Lots(filter:{ nameDescriptionRu:$q }, limit:$limit){
        id nameRu descriptionRu trdBuyId count amount isDeleted customerNameRu
      }
    }`;
    const lotsData = await gzGraphQL(lotsQuery, { q: word, limit: 200 });
    const lots = ((lotsData && lotsData.Lots) ? lotsData.Lots : []).filter(function(l){ return !l.isDeleted; });
    // map: trdBuyId -> описание лота (для связи с договорами)
    const lotById = {};
    const tbIds = [];
    lots.forEach(function (l) {
      if (l.trdBuyId && tbIds.indexOf(l.trdBuyId) < 0) tbIds.push(l.trdBuyId);
      lotById[l.id] = l;
    });
    if (!tbIds.length) return res.json({ query: word, foundLots: lots.length, wins: [], stats: null });

    // 2) По trdBuyId тянем договоры с позициями
    const contractQuery = `query($tb: [Int], $limit: Int){
      Contract(filter:{ trdBuyId:$tb }, limit:$limit){
        id descriptionRu contractSum supplierFio supplierBiin trdBuyId
        ContractUnits{ itemPrice quantity totalSum }
      }
    }`;
    const contractData = await gzGraphQL(contractQuery, { tb: tbIds.slice(0, 60), limit: 200 });
    const contracts = (contractData && contractData.Contract) ? contractData.Contract : [];

    // map: trdBuyId -> массив лотов в нём (чтобы знать описание соответствующего лота)
    const lotsByTb = {};
    lots.forEach(function (l) {
      if (l.trdBuyId) {
        if (!lotsByTb[l.trdBuyId]) lotsByTb[l.trdBuyId] = [];
        lotsByTb[l.trdBuyId].push(l);
      }
    });

    // 3) Собираем реальные цены за штуку из позиций договоров — с описанием для отбора
    const wins = [];
    contracts.forEach(function (c) {
      const lotsForTb = lotsByTb[c.trdBuyId] || [];
      // Описание лота(ов) из этого объявления — это поможет фронту/Claude отобрать похожие
      const lotName = lotsForTb.length ? lotsForTb[0].nameRu : "";
      const lotDesc = lotsForTb.length ? (lotsForTb[0].descriptionRu || "") : "";
      const customer = lotsForTb.length ? (lotsForTb[0].customerNameRu || "") : "";
      (c.ContractUnits || []).forEach(function (u) {
        const price = parseFloat(u.itemPrice) || 0;
        const qty = parseFloat(u.quantity) || 0;
        if (price > 0) {
          wins.push({
            description: c.descriptionRu || "",
            lotName: lotName,                  // название лота (короткое, типа "Бритва")
            lotDescription: lotDesc,            // подробное описание лота (характеристики)
            customer: customer,                 // заказчик
            supplier: c.supplierFio || "",
            supplierBin: c.supplierBiin || "",
            unitPrice: price,                   // реальная цена ПОБЕДЫ за штуку
            quantity: qty,
            totalSum: parseFloat(u.totalSum) || 0,
            contractSum: parseFloat(c.contractSum) || 0
          });
        }
      });
    });

    // 4) Статистика по ВСЕМ ценам
    let stats = null;
    if (wins.length) {
      const prices = wins.map(function (w) { return w.unitPrice; }).sort(function (a, b) { return a - b; });
      const sum = prices.reduce(function (a, b) { return a + b; }, 0);
      stats = {
        count: prices.length,
        avgUnit: Math.round(sum / prices.length),
        minUnit: prices[0],
        maxUnit: prices[prices.length - 1],
        medianUnit: prices[Math.floor(prices.length / 2)]
      };
    }
    // сортируем по цене за штуку (от меньшей к большей)
    wins.sort(function (a, b) { return a.unitPrice - b.unitPrice; });
    // Возвращаем больше побед (до 50), чтобы фронт мог отобрать похожие
    res.json({ query: word, foundLots: lots.length, foundContracts: contracts.length, stats: stats, wins: wins.slice(0, 50) });
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

// ============================================================
// ЗАЛИВКА МОЗГА — собираем тендеры в Firebase для обучения
// /api/brain/seed?word=бритва&pages=3   → заливает побед по слову
// /api/brain/stats                       → сколько в мозге сейчас
// ============================================================

// Извлечение характеристик из ТЗ (повторяет логику фронта)
function extractSpecsBrain(text){
  const specs = [];
  const t = (text||"").toLowerCase();
  const numUnit = /(\d+(?:[.,]\d+)?)\s*(гб|gb|мб|mb|тб|tb|мбит|mbit|гбит|gbit|вт|w|квт|kw|мл|ml|л|l|кг|kg|г\b|г$|мм|mm|см|cm|м\b|м$|гц|hz|кгц|мгц|ггц|шт|штук|pcs)/g;
  let m;
  while((m = numUnit.exec(t)) !== null) specs.push(m[1].replace(",",".") + m[2]);
  const orig = text||"";
  const brand = /\b([A-Z][a-zA-Z]{2,15})\b/g;
  const stop = ["The","For","And","With","From","This","That","Type","Class","Model"];
  while((m = brand.exec(orig)) !== null) if(stop.indexOf(m[1]) < 0) specs.push(m[1].toLowerCase());
  const tech = ["usb","type-c","typec","hdmi","ssd","hdd","ddr","ddr4","ddr5","металл","пластик","нетканый","полиэтилен","одноразов","многоразов","перезаряжаем"];
  tech.forEach(x => { if(t.indexOf(x) >= 0) specs.push(x); });
  return Array.from(new Set(specs));
}

// Определение категории из названия лота (простая эвристика)
function detectCategory(lotName, lotDesc){
  const t = ((lotName||"") + " " + (lotDesc||"")).toLowerCase();
  if(/бритв|станок для брит/.test(t)) return "бритвы";
  if(/бахил/.test(t)) return "бахилы";
  if(/флеш|usb.*flash|накопитель/.test(t)) return "флеш-накопители";
  if(/ноутбук|laptop/.test(t)) return "ноутбуки";
  if(/канцелярия|канцеляр|ручк|карандаш|тетрад/.test(t)) return "канцелярия";
  if(/цемент/.test(t)) return "цемент";
  if(/арматур/.test(t)) return "арматура";
  if(/бумаг|туалетн.*бумаг/.test(t)) return "бумага";
  if(/моющ|мыло|порошок/.test(t)) return "моющие средства";
  if(/перчатк/.test(t)) return "перчатки";
  if(/маск.*медицинск/.test(t)) return "маски медицинские";
  if(/халат/.test(t)) return "халаты";
  if(/обув|сапог|ботинк/.test(t)) return "обувь";
  if(/мебел|стол\b|стул|шкаф|кресло/.test(t)) return "мебель";
  if(/принтер/.test(t)) return "принтеры";
  if(/картридж|тонер/.test(t)) return "картриджи";
  if(/компьютер/.test(t)) return "компьютеры";
  if(/монитор/.test(t)) return "мониторы";
  if(/мфу/.test(t)) return "мфу";
  if(/телефон/.test(t)) return "телефоны";
  if(/планшет/.test(t)) return "планшеты";
  if(/кабел/.test(t)) return "кабели";
  if(/лампа|светильник|освещен/.test(t)) return "освещение";
  if(/краск/.test(t)) return "краски";
  if(/штук|пакет/.test(t)) return "упаковка";
  // По умолчанию — первое слово названия
  const w = (lotName||"").trim().split(/\s+/)[0];
  return (w || "разное").toLowerCase();
}

// Регион из имени заказчика
function detectRegion(customer){
  const t = (customer||"").toLowerCase();
  if(/алмат|almaty/.test(t)) return "Алматы";
  if(/астан|нур-султан|astana|нурсултан/.test(t)) return "Астана";
  if(/шымкент|shymkent/.test(t)) return "Шымкент";
  if(/караганд/.test(t)) return "Карагандинская";
  if(/павлодар/.test(t)) return "Павлодарская";
  if(/актобе|актюбин/.test(t)) return "Актюбинская";
  if(/атырау/.test(t)) return "Атырауская";
  if(/уральск|западно-каз|зко\b/.test(t)) return "Западно-Казахстанская";
  if(/восточно-каз|вко\b|усть-камен|оскем/.test(t)) return "Восточно-Казахстанская";
  if(/жетісу|жетысу|талдыкорг/.test(t)) return "Жетісу";
  if(/абай/.test(t)) return "Абай";
  if(/жамбыл|тараз/.test(t)) return "Жамбылская";
  if(/туркестан/.test(t)) return "Туркестанская";
  if(/мангист/.test(t)) return "Мангистауская";
  if(/костанай/.test(t)) return "Костанайская";
  if(/северо-каз|ско\b|петропавл/.test(t)) return "Северо-Казахстанская";
  if(/акмол/.test(t)) return "Акмолинская";
  if(/кызылорд/.test(t)) return "Кызылординская";
  if(/улыта/.test(t)) return "Улытауская";
  return "Не определён";
}

app.get("/api/brain/seed", async (req, res) => {
  if (!fbStore) return res.status(500).json({ error: "Firebase Admin не настроен (нужна переменная FIREBASE_SA)" });
  if (!GOSZAKUP_TOKEN) return res.status(500).json({ error: "GOSZAKUP_TOKEN не настроен" });
  const word = (req.query.word || "").trim();
  if (!word) return res.status(400).json({ error: "Укажите параметр word" });
  const maxPages = parseInt(req.query.pages) || 1;

  try {
    let savedCount = 0;
    let skippedCount = 0;
    let after = parseInt(req.query.after) || 0;

    for (let page = 0; page < maxPages; page++) {
      // 1) Тянем лоты по слову
      const lotsQuery = `query($q:String,$limit:Int,$after:Int){
        Lots(filter:{nameDescriptionRu:$q}, limit:$limit, after:$after){
          id lotNumber nameRu descriptionRu trdBuyId count amount isDeleted customerNameRu lastUpdateDate
        }
      }`;
      const lotsData = await gzGraphQL(lotsQuery, { q: word, limit: 200, after: after });
      const lots = ((lotsData && lotsData.Lots) ? lotsData.Lots : []).filter(l => !l.isDeleted);
      if (!lots.length) break;
      after = lots[lots.length - 1].id;

      // Карта trdBuyId → лот
      const tbIds = [];
      const lotsByTb = {};
      lots.forEach(l => {
        if (l.trdBuyId) {
          if (tbIds.indexOf(l.trdBuyId) < 0) tbIds.push(l.trdBuyId);
          if (!lotsByTb[l.trdBuyId]) lotsByTb[l.trdBuyId] = [];
          lotsByTb[l.trdBuyId].push(l);
        }
      });

      // 2) Договоры порциями
      const batchSize = 30;
      for (let i = 0; i < tbIds.length; i += batchSize) {
        const slice = tbIds.slice(i, i + batchSize);
        const contractQuery = `query($tb:[Int],$limit:Int){
          Contract(filter:{trdBuyId:$tb}, limit:$limit){
            id descriptionRu contractSum supplierFio supplierBiin trdBuyId signDate
            ContractUnits{ itemPrice quantity totalSum }
          }
        }`;
        const cData = await gzGraphQL(contractQuery, { tb: slice, limit: 200 });
        const contracts = (cData && cData.Contract) ? cData.Contract : [];

        // 3) Сохраняем в Firebase каждую позицию договора как отдельную запись
        const batch = fbStore.batch();
        let batchCount = 0;
        for (const c of contracts) {
          const lotsForTb = lotsByTb[c.trdBuyId] || [];
          const lot = lotsForTb[0];
          if (!lot) continue;
          for (const u of (c.ContractUnits || [])) {
            const unitPrice = parseFloat(u.itemPrice) || 0;
            const qty = parseFloat(u.quantity) || 0;
            if (unitPrice <= 0 || qty <= 0) { skippedCount++; continue; }
            const budgetPerUnit = lot.count > 0 ? (parseFloat(lot.amount) || 0) / parseFloat(lot.count) : 0;
            const dropPercent = budgetPerUnit > 0 ? Math.round(((budgetPerUnit - unitPrice) / budgetPerUnit) * 1000) / 10 : 0;
            const category = detectCategory(lot.nameRu, lot.descriptionRu);
            const characteristics = extractSpecsBrain(((lot.nameRu||"")+" "+(lot.descriptionRu||"")+" "+(c.descriptionRu||"")));

            // ID документа = trdBuyId_lotId_supplierBin (уникальный, исключает дубли)
            const docId = `${c.trdBuyId}_${lot.id}_${c.supplierBiin || "no"}_${Math.round(unitPrice)}`;
            const docRef = fbStore.collection("tenders").doc(docId);
            batch.set(docRef, {
              category: category,
              characteristics: characteristics.slice(0, 15),
              lotId: lot.id,
              lotNumber: lot.lotNumber || "",
              lotName: lot.nameRu || "",
              lotDescription: lot.descriptionRu || "",
              contractDescription: c.descriptionRu || "",
              budget: parseFloat(lot.amount) || 0,
              qty: parseFloat(lot.count) || 0,
              budgetPerUnit: Math.round(budgetPerUnit * 100) / 100,
              winnerPrice: unitPrice,
              winnerQty: qty,
              winnerTotal: parseFloat(u.totalSum) || 0,
              winnerName: c.supplierFio || "",
              winnerBin: c.supplierBiin || "",
              dropPercent: dropPercent,
              customerName: lot.customerNameRu || "",
              region: detectRegion(lot.customerNameRu),
              signDate: c.signDate || "",
              lotDate: lot.lastUpdateDate || "",
              source: "goszakup",
              seedWord: word,
              createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            batchCount++;
            // Firestore лимит 500 операций в одном batch
            if (batchCount >= 450) {
              await batch.commit();
              savedCount += batchCount;
              batchCount = 0;
            }
          }
        }
        if (batchCount > 0) {
          await batch.commit();
          savedCount += batchCount;
        }
      }

      if (lots.length < 200) break; // последняя страница
    }

    res.json({
      ok: true,
      word: word,
      pagesProcessed: maxPages,
      savedTenders: savedCount,
      skipped: skippedCount,
      nextAfter: after,
      message: `Сохранено ${savedCount} тендеров в мозг по слову "${word}". Если хочешь больше — повтори с параметром after=${after}`
    });
  } catch (e) {
    console.error("brain/seed error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Статистика мозга
app.get("/api/brain/stats", async (req, res) => {
  if (!fbStore) return res.status(500).json({ error: "Firebase Admin не настроен" });
  try {
    const snap = await fbStore.collection("tenders").count().get();
    const total = snap.data().count;
    // Топ-категорий
    const sample = await fbStore.collection("tenders").limit(2000).get();
    const byCategory = {};
    sample.forEach(doc => {
      const c = doc.data().category || "разное";
      byCategory[c] = (byCategory[c] || 0) + 1;
    });
    const topCats = Object.entries(byCategory)
      .sort((a,b) => b[1] - a[1]).slice(0, 20)
      .map(([cat, n]) => ({ category: cat, count: n }));
    res.json({ ok: true, totalTenders: total, sampled: sample.size, topCategories: topCats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("UMMA backend запущен на порту " + PORT);
});
