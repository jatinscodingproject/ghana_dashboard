require("dotenv").config();
const readline = require("readline");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    let value = "";
    const wasRaw = Boolean(stdin.isRaw);
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    const onData = (ch) => {
      ch = ch.toString("utf8");
      if (ch === "\u0003") {
        cleanup();
        process.exit(130);
      }
      if (ch === "\r" || ch === "\n") {
        cleanup();
        stdout.write("\n");
        resolve(value);
      } else if (ch === "\u0008" || ch === "\u007f") {
        value = value.slice(0, -1);
      } else if (ch >= " ") {
        value += ch;
      }
    };
    function cleanup() {
      stdin.removeListener("data", onData);
      if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    }
    stdin.on("data", onData);
  });
}

async function main() {
  const username = String(process.argv[2] || await ask("Admin username: ")).trim();
  if (!/^[a-zA-Z0-9_.@-]{3,100}$/.test(username)) {
    throw new Error("Username must be 3-100 characters (letters, numbers, _, ., @, -).");
  }
  const password = await askHidden("New password (minimum 12 characters; input hidden): ");
  const confirm = await askHidden("Confirm password: ");
  if (password.length < 12) throw new Error("Password must be at least 12 characters.");
  if (password !== confirm) throw new Error("Passwords do not match.");

  if (!/^[a-zA-Z0-9_]+$/.test(process.env.DB_NAME || "")) {
    throw new Error("DB_NAME may contain only letters, numbers, and underscores.");
  }
  const config = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  };
  const server = await mysql.createConnection(config);
  await server.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await server.end();
  const db = await mysql.createConnection({ ...config, database: process.env.DB_NAME });
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS dashboard_admins (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_dashboard_admins_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const hash = await bcrypt.hash(password, 12);
    await db.execute(
      `INSERT INTO dashboard_admins (username, password_hash)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), updated_at = CURRENT_TIMESTAMP`,
      [username, hash]
    );
    console.log(`Admin password created/updated for "${username}".`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error("Could not set admin password:", err.message);
  process.exit(1);
});
