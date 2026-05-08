import { ConfigResolver } from "../src/shared/runtime/config.ts";

const host = process.env.PGHOST ?? "127.0.0.1";
const port = process.env.PGPORT ?? "5432";
const user = process.env.PGUSER ?? process.env.USER ?? "gary";
const database = process.env.PGDATABASE ?? "agenthive";

const password = ConfigResolver.resolvePasswordSync({
    host,
    port,
    database,
    user,
});

console.log(`Host: ${host}`);
console.log(`User: ${user}`);
console.log(`Password found: ${password ? "YES" : "NO"}`);
if (password) {
    console.log(`Password length: ${password.length}`);
}
process.exit(0);
