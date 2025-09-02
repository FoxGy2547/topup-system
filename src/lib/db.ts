// /src/lib/db.ts
import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'sql12.freesqldatabase.com',
      user: process.env.DB_USER || 'sql12796984',
      password: process.env.DB_PASS || 'n72gyyb4KT',
      database: process.env.DB_NAME || 'sql12796984',
      port: Number(process.env.DB_PORT || 3306),
      connectionLimit: 10,
      decimalNumbers: true,
      dateStrings: true,
    });
  }
  return pool;
}
