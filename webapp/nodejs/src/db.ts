import { createPool } from "mysql2/promise";
export const pool = createPool({
  host: process.env.ISUCON_DB_HOST || "127.0.0.1",
  port: Number(process.env.ISUCON_DB_PORT || "3306"),
  user: process.env.ISUCON_DB_USER || "isucon",
  password: process.env.ISUCON_DB_PASSWORD || "isucon",
  database: process.env.ISUCON_DB_NAME || "isuride",
  timezone: "+00:00",
});
