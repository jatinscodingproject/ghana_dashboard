require("dotenv").config();

const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");

const app = express();
const PORT = Number(process.env.PORT || 3000);

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET must be set in .env and should be at least 32 characters.");
  process.exit(1);
}
for (const key of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"]) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Create the configured database automatically. DB_USER must have CREATE DATABASE
// privilege the first time this app is launched.
if (!/^[a-zA-Z0-9_]+$/.test(process.env.DB_NAME)) {
  console.error("DB_NAME may contain only letters, numbers, and underscores.");
  process.exit(1);
}

async function ensureDatabaseExists() {
  const server = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    charset: "utf8mb4"
  });
  try {
    await server.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await server.end();
  }
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: "utf8mb4"
});

async function ensureDashboardTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS dashboard_admins (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_dashboard_admins_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Optional first-run admin bootstrap. It never overwrites an existing account.
  const adminUsername = String(process.env.ADMIN_USERNAME || "").trim();
  const adminPassword = String(process.env.ADMIN_PASSWORD || "");
  if (adminUsername && adminPassword) {
    if (!/^[a-zA-Z0-9_.@-]{3,100}$/.test(adminUsername)) {
      throw new Error("ADMIN_USERNAME must be 3-100 characters: letters, numbers, _, ., @, -.");
    }
    if (adminPassword.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
    const [existing] = await pool.execute("SELECT id FROM dashboard_admins WHERE username = ? LIMIT 1", [adminUsername]);
    if (!existing.length) {
      const hash = await bcrypt.hash(adminPassword, 12);
      await pool.execute("INSERT INTO dashboard_admins (username, password_hash) VALUES (?, ?)", [adminUsername, hash]);
      console.log(`Initial admin account created: ${adminUsername}`);
    }
  } else if (adminUsername || adminPassword) {
    throw new Error("Set both ADMIN_USERNAME and ADMIN_PASSWORD in .env, or leave both blank.");
  }
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.disable("x-powered-by");
if (String(process.env.TRUST_PROXY).toLowerCase() === "true") app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  name: "mtn_report.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many login attempts. Try again in 15 minutes."
});

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function validDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (e) {
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});

app.get("/", (req, res) => res.redirect(req.session.user ? "/dashboard" : "/login"));

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("login", { error: null });
});

app.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (!username || !password || username.length > 100 || password.length > 200) {
      return res.status(400).render("login", { error: "Enter a valid username and password." });
    }

    const [rows] = await pool.execute(
      "SELECT id, username, password_hash FROM dashboard_admins WHERE username = ? LIMIT 1",
      [username]
    );
    const admin = rows[0];
    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).render("login", { error: "Invalid username or password." });
    }

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { id: admin.id, username: admin.username };
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        res.redirect("/dashboard");
      });
    });
  } catch (err) {
    next(err);
  }
});

app.post("/logout", requireLogin, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("mtn_report.sid", { httpOnly: true, sameSite: "strict" });
    res.redirect("/login");
  });
});

app.get("/dashboard", requireLogin, async (req, res, next) => {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Accra" });
    const defaultFrom = today.slice(0, 8) + "01";
    const from = validDate(req.query.from) ? req.query.from : defaultFrom;
    const to = validDate(req.query.to) ? req.query.to : today;

    if (from > to) {
      return res.status(400).render("error", {
        title: "Invalid date range",
        message: "The start date must be on or before the end date."
      });
    }
    const rangeDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
    if (rangeDays > 366) {
      return res.status(400).render("error", {
        title: "Date range too large",
        message: "Choose a date range of 366 days or fewer."
      });
    }

    // Use half-open date range so the created_at index can be used.
    const sql = `
      SELECT
        DATE(created_at) AS report_date,
        SUM(CASE WHEN UPPER(TRIM(subscriber_life_cycle)) LIKE 'UNSUB%' THEN 1 ELSE 0 END) AS unsub_count,
        SUM(CASE WHEN UPPER(TRIM(subscriber_life_cycle)) LIKE 'REN%' AND charge_amt <> 0 THEN 1 ELSE 0 END) AS renewal_count,
        SUM(CASE WHEN UPPER(TRIM(subscriber_life_cycle)) LIKE 'SUB%'
                  AND status_code IN ('Insufficent balance', 'Activation Success') THEN 1 ELSE 0 END) AS activation_base_count,
        SUM(CASE WHEN UPPER(TRIM(subscriber_life_cycle)) LIKE 'SUB%'
                  AND status_code = 'Insufficent balance' THEN 1 ELSE 0 END) AS insufficient_balance_count,
        SUM(CASE WHEN UPPER(TRIM(subscriber_life_cycle)) LIKE 'SUB%'
                  AND status_code = 'Activation Success' THEN 1 ELSE 0 END) AS activation_success_count,
        SUM(CASE WHEN UPPER(TRIM(subscriber_life_cycle)) LIKE 'SUB%'
                  AND status_code = 'Retry_Activation_Success' THEN 1 ELSE 0 END) AS retry_activation_success_count,
        SUM(CASE WHEN UPPER(TRIM(subscriber_life_cycle)) LIKE 'REN%'
                  AND charge_amt > 0 THEN 1 ELSE 0 END) AS positive_renewal_charge_count,
        SUM(CASE WHEN UPPER(TRIM(subscriber_life_cycle)) LIKE 'SUB%'
                  AND charge_amt > 0 THEN 1.5 ELSE 0 END) AS calculated_activation_charge,
        SUM(CASE WHEN UPPER(TRIM(subscriber_life_cycle)) LIKE 'REN%'
                  AND charge_amt > 0 THEN 1.5 ELSE 0 END) AS calculated_renewal_charge,
        SUM(CASE WHEN (UPPER(TRIM(subscriber_life_cycle)) LIKE 'SUB%'
                    OR UPPER(TRIM(subscriber_life_cycle)) LIKE 'REN%')
                  AND charge_amt > 0 THEN 1.5 ELSE 0 END) AS calculated_charge_total
      FROM mtn_subscription_callbacks
      WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
        AND (
          UPPER(TRIM(subscriber_life_cycle)) LIKE 'UNSUB%'
          OR (UPPER(TRIM(subscriber_life_cycle)) LIKE 'REN%' AND charge_amt <> 0)
          OR (UPPER(TRIM(subscriber_life_cycle)) LIKE 'SUB%'
              AND status_code IN ('Insufficent balance', 'Activation Success', 'Retry_Activation_Success'))
        )
      GROUP BY DATE(created_at)
      ORDER BY report_date DESC
    `;
    const [rows] = await pool.execute(sql, [`${from} 00:00:00`, `${to} 00:00:00`]);

    const total = rows.reduce((a, r) => {
      for (const key of [
        "unsub_count", "renewal_count", "activation_base_count",
        "insufficient_balance_count", "activation_success_count",
        "retry_activation_success_count", "positive_renewal_charge_count"
      ]) a[key] += Number(r[key] || 0);
      a.calculated_activation_charge += Number(r.calculated_activation_charge || 0);
      a.calculated_renewal_charge += Number(r.calculated_renewal_charge || 0);
      a.calculated_charge_total += Number(r.calculated_charge_total || 0);
      return a;
    }, {
      unsub_count: 0, renewal_count: 0, activation_base_count: 0,
      insufficient_balance_count: 0, activation_success_count: 0,
      retry_activation_success_count: 0, positive_renewal_charge_count: 0,
      calculated_activation_charge: 0, calculated_renewal_charge: 0, calculated_charge_total: 0
    });

    res.render("dashboard", {
      from, to, rows, total,
      formatNumber: (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 }),
      formatDate: (d) => {
        const date = new Date(d);
        return date.toLocaleDateString("en-GB", { timeZone: "Africa/Accra", day: "2-digit", month: "short", year: "numeric" });
      }
    });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error("[APP_ERROR]", err.message);
  if (res.headersSent) return next(err);
  res.status(500).render("error", {
    title: "Something went wrong",
    message: process.env.NODE_ENV === "production"
      ? "The request could not be completed. Check the application logs."
      : err.message
  });
});

async function start() {
  await ensureDatabaseExists();
  await pool.query("SELECT 1");
  await ensureDashboardTables();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MTN Ghana dashboard listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Startup failed:", err.message);
  if (err.code === "ER_ACCESS_DENIED_ERROR" || err.code === "ER_DBACCESS_DENIED_ERROR") {
    console.error("Check DB_USER/DB_PASSWORD in .env. The database user also needs CREATE DATABASE privilege on first launch.");
  }
  process.exit(1);
});
