// /src/lib/db.ts
import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'chatbot_db',
      port: Number(process.env.DB_PORT || 3306),
      connectionLimit: 10,
      decimalNumbers: true,
      dateStrings: true,
    });
  }
  return pool;
}
