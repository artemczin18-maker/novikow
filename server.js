
const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

const rarities = [
  { name: "простые", chance: 60, min: 10, max: 80 },
  { name: "средние", chance: 25, min: 80, max: 250 },
  { name: "эпические", chance: 10, min: 250, max: 1000 },
  { name: "мифические", chance: 4, min: 1000, max: 5000 },
  { name: "легендарные", chance: 1, min: 5000, max: 20000 }
];

async function init() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      balance BIGINT NOT NULL DEFAULT 1000
    );

    CREATE TABLE IF NOT EXISTS numbers (
      id SERIAL PRIMARY KEY,
      player_id INTEGER NOT NULL REFERENCES players(id),
      code TEXT NOT NULL,
      rarity TEXT NOT NULL,
      value BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS market (
      id SERIAL PRIMARY KEY,
      number_id INTEGER UNIQUE NOT NULL REFERENCES numbers(id),
      seller_id INTEGER NOT NULL REFERENCES players(id),
      price BIGINT NOT NULL CHECK(price > 0)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      player_id INTEGER NOT NULL REFERENCES players(id)
    );
  `);
}

function pickRarity() {
  const n = Math.random() * 100;
  let sum = 0;
  for (const r of rarities) {
    sum += r.chance;
    if (n < sum) return r;
  }
  return rarities[0];
}

function makeCode() {
  const n = () => String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return `NG-${n()}-${n()}`;
}

async function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Нужен вход" });

  try {
    const r = await db.query(
      "SELECT p.id,p.username,p.balance FROM sessions s JOIN players p ON p.id=s.player_id WHERE s.token=$1",
      [token]
    );
    if (!r.rowCount) return res.status(401).json({ error: "Сессия не найдена" });
    req.player = r.rows[0];
    next();
  } catch {
    res.status(500).json({ error: "Ошибка базы данных" });
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, game: "NumberGen" });
});

app.post("/api/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: "Имя: 3–20 латинских букв, цифр или _" });

  if (password.length < 8 || password.length > 72)
    return res.status(400).json({ error: "Пароль должен быть длиной 8–72 символа" });

  try {
    const hash = crypto.scryptSync(password, "NumberGen-v1-" + username.toLowerCase(), 64).toString("hex");
    const p = await db.query(
      "INSERT INTO players(username,password_hash) VALUES($1,$2) RETURNING id,username,balance",
      [username, hash]
    );
    const token = crypto.randomBytes(32).toString("hex");
    await db.query("INSERT INTO sessions(token,player_id) VALUES($1,$2)", [token, p.rows[0].id]);
    res.json({ token, player: p.rows[0] });
  } catch {
    res.status(400).json({ error: "Имя уже занято или база не настроена" });
  }
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  try {
    const r = await db.query(
      "SELECT * FROM players WHERE username=$1",
      [username]
    );
    if (!r.rowCount) return res.status(401).json({ error: "Неверный логин или пароль" });

    const hash = crypto.scryptSync(password, "NumberGen-v1-" + username.toLowerCase(), 64).toString("hex");
    if (hash !== r.rows[0].password_hash)
      return res.status(401).json({ error: "Неверный логин или пароль" });

    const token = crypto.randomBytes(32).toString("hex");
    await db.query("INSERT INTO sessions(token,player_id) VALUES($1,$2)", [token, r.rows[0].id]);
    res.json({ token, player: { id: r.rows[0].id, username: r.rows[0].username, balance: r.rows[0].balance } });
  } catch {
    res.status(500).json({ error: "Ошибка входа" });
  }
});

app.get("/api/me", auth, (req, res) => res.json({ player: req.player }));

app.post("/api/roll", auth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const p = await client.query(
      "UPDATE players SET balance=balance-50 WHERE id=$1 AND balance>=50 RETURNING balance",
      [req.player.id]
    );
    if (!p.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Не хватает NG" });
    }

    const r = pickRarity();
    const value = Math.floor(Math.random() * (r.max - r.min + 1)) + r.min;
    const code = makeCode();
    const n = await client.query(
      "INSERT INTO numbers(player_id,code,rarity,value) VALUES($1,$2,$3,$4) RETURNING *",
      [req.player.id, code, r.name, value]
    );
    await client.query("COMMIT");
    res.json({ number: n.rows[0], balance: p.rows[0].balance });
  } catch {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Не удалось получить номер" });
  } finally {
    client.release();
  }
});

app.get("/api/numbers", auth, async (req, res) => {
  const r = await db.query(
    "SELECT n.*,m.id AS listing_id,m.price FROM numbers n LEFT JOIN market m ON m.number_id=n.id WHERE n.player_id=$1 ORDER BY n.id DESC",
    [req.player.id]
  );
  res.json({ items: r.rows });
});

app.get("/api/market", auth, async (req, res) => {
  const r = await db.query(
    "SELECT m.id AS listing_id,m.price,p.username AS seller,n.id,n.code,n.rarity,n.value FROM market m JOIN players p ON p.id=m.seller_id JOIN numbers n ON n.id=m.number_id WHERE m.seller_id<>$1 ORDER BY m.id DESC",
    [req.player.id]
  );
  res.json({ items: r.rows });
});

app.post("/api/market/list", auth, async (req, res) => {
  const numberId = Number(req.body.number_id);
  const price = Number(req.body.price);

  if (!Number.isSafeInteger(price) || price < 1 || price > 100000000)
    return res.status(400).json({ error: "Некорректная цена" });

  try {
    await db.query(
      "INSERT INTO market(number_id,seller_id,price) SELECT id,player_id,$3 FROM numbers WHERE id=$1 AND player_id=$2",
      [numberId, req.player.id, price]
    );
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "Номер не найден или уже выставлен" });
  }
});

app.post("/api/market/buy", auth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      "SELECT m.*,n.code FROM market m JOIN numbers n ON n.id=m.number_id WHERE m.id=$1 FOR UPDATE",
      [Number(req.body.listing_id)]
    );
    if (!r.rowCount) throw new Error("Лот уже продан");
    const lot = r.rows[0];
    if (lot.seller_id === req.player.id) throw new Error("Нельзя купить свой номер");

    const debit = await client.query(
      "UPDATE players SET balance=balance-$1 WHERE id=$2 AND balance >= $1 RETURNING id",
      [lot.price, req.player.id]
    );
    if (!debit.rowCount) throw new Error("Не хватает NG");

    await client.query("UPDATE players SET balance=balance+$1 WHERE id=$2", [lot.price, lot.seller_id]);
    await client.query("UPDATE numbers SET player_id=$1 WHERE id=$2", [req.player.id, lot.number_id]);
    await client.query("DELETE FROM market WHERE id=$1", [lot.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message || "Ошибка покупки" });
  } finally {
    client.release();
  }
});

app.post("/api/market/cancel", auth, async (req, res) => {
  const r = await db.query(
    "DELETE FROM market WHERE id=$1 AND seller_id=$2 RETURNING id",
    [Number(req.body.listing_id), req.player.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: "Лот не найден" });
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NumberGen</title>
<style>
body{background:#10111a;color:#f5f5ff;font:16px Arial;margin:0;padding:20px;max-width:560px;margin:auto}
.box{background:#1c1e2c;border:1px solid #353750;border-radius:16px;padding:16px;margin:12px 0}
input,button{width:100%;box-sizing:border-box;padding:13px;margin:6px 0;border-radius:10px;border:0}
input{background:#303247;color:white}button{background:#8974ff;color:white;font-weight:bold}
.small{color:#aaaec4;font-size:13px}.item{border-top:1px solid #444;padding:12px 0}
</style>
<h1>✦ NumberGen</h1>
<div class="box" id="auth">
<h2>Вход / регистрация</h2>
<input id="username" placeholder="Имя: player123" maxlength="20">
<input id="password" type="password" placeholder="Пароль от 8 символов">
<button onclick="go('register')">Создать аккаунт</button>
<button onclick="go('login')">Войти</button>
<p id="msg"></p>
</div>
<div id="game" hidden>
<div class="box"><div class="small">ТВОЙ БАЛАНС</div><h1 id="balance">1000 NG</h1>
<button onclick="roll()">Крутить номер · 50 NG</button><h2 id="result">Удачи!</h2></div>
<div class="box"><h2>Коллекция</h2><div id="numbers"></div></div>
<div class="box"><h2>Общий рынок</h2><button onclick="market()">Обновить</button><div id="lots"></div></div>
<button onclick="logout()">Выйти</button>
</div>
<script>
let token=localStorage.getItem('ngtoken')||'';
async function api(path,data={},method='POST'){
 const r=await fetch('/api/'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(method==='GET'?{}:{body:JSON.stringify(data)})});
 const j=await r.json();if(!r.ok)throw Error(j.error||'Ошибка');return j;
}
async function go(type){try{const r=await api(type,{username:username.value.trim(),password:password.value});token=r.token;localStorage.setItem('ngtoken',token);await boot();}catch(e){msg.textContent=e.message;}}
async function boot(){if(!token)return;try{const r=await api('me',{},'GET');auth.hidden=true;game.hidden=false;balance.textContent=Number(r.player.balance).toLocaleString()+' NG';await numbers();await market();}catch{token='';localStorage.removeItem('ngtoken');}}
async function roll(){try{const r=await api('roll');result.textContent=r.number.code+' · '+r.number.rarity+' · '+r.number.value+' NG';await boot();}catch(e){alert(e.message);}}
async function numbers(){const r=await api('numbers',{},'GET');document.getElementById('numbers').innerHTML=r.items.map(n=>'<div class="item"><b>'+n.code+'</b><br>'+n.rarity+' · '+n.value+' NG '+(n.listing_id?'· На продаже':'')+'<br><button onclick="listNumber('+n.id+','+n.value+')">Выставить на рынок</button>'+(n.listing_id?'<button onclick="cancelLot('+n.listing_id+')">Снять с продажи</button>':'')+'</div>').join('')||'Пока пусто';}
async function listNumber(id,value){const p=prompt('Цена в NG',value);if(p===null)return;try{await api('market/list',{number_id:id,price:Number(p)});await numbers();await market();}catch(e){alert(e.message);}}
async function market(){try{const r=await api('market',{},'GET');lots.innerHTML=r.items.map(n=>'<div class="item"><b>'+n.code+'</b><br>'+n.rarity+' · '+n.price+' NG · продавец '+n.seller+'<button onclick="buy('+n.listing_id+')">Купить</button></div>').join('')||'На рынке пока нет номеров';}catch(e){lots.textContent=e.message;}}
async function buy(id){try{await api('market/buy',{listing_id:id});await boot();alert('Куплено!');}catch(e){alert(e.message);}}
async function cancelLot(id){try{await api('market/cancel',{listing_id:id});await numbers();await market();}catch(e){alert(e.message);}}
async function logout(){try{await api('logout');}catch{}token='';localStorage.removeItem('ngtoken');location.reload();}
boot();
</script></html>`);
});

app.post("/api/logout", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) await db.query("DELETE FROM sessions WHERE token=$1", [token]);
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
init().then(() => {
  app.listen(port, "0.0.0.0", () => console.log("NumberGen listening on " + port));
}).catch(e => {
  console.error("Database initialization failed:", e.message);
  process.exit(1);
});
