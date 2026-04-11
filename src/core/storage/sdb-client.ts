/**
 * SpacetimeDB Direct Client
 * 
 * Communicates with SpacetimeDB via REST (SQL) and WebSocket (Subscription).
 * No dependency on 'spacetime' CLI or bridge service.
 */

import { FileSystem } from "../../file-system/operations.ts";
import { execSync, spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — js-yaml has no type declarations
import yaml from "js-yaml";
const parseYaml = yaml.load;

export interface SdbConfig {
    host: string;
    port: number;
    dbName: string;
    httpUri: string;
    wsUri: string;
}

export function getSdbConfigSync(): SdbConfig {
    const defaults: SdbConfig = {
        host: "127.0.0.1",
        port: 3000,
        dbName: "roadmap2",
        httpUri: "http://127.0.0.1:3000/v1/database/roadmap2/sql",
        wsUri: "ws://127.0.0.1:3000/v1/database/roadmap2/subscribe"
    };

    try {
        // Try config.yaml first (nested format with database section)
        const yamlPath = join(process.cwd(), "roadmap", "config.yaml");
        if (existsSync(yamlPath)) {
            const content = readFileSync(yamlPath, "utf-8");
            const cfg = parseYaml(content) as any;
            if (cfg?.database) {
                const host = cfg.database.host || defaults.host;
                const port = cfg.database.port || defaults.port;
                const dbName = cfg.database.name || defaults.dbName;
                return {
                    host,
                    port,
                    dbName,
                    httpUri: `http://${host}:${port}/v1/database/${dbName}/sql`,
                    wsUri: `ws://${host}:${port}/v1/database/${dbName}/subscribe`
                };
            }
        }

        // Fallback to flat config
        const fs = new FileSystem(process.cwd());
        const config = fs.loadConfigSync();
        if (config?.database) {
            const host = config.database.host || defaults.host;
            const port = config.database.port || defaults.port;
            const dbName = config.database.name || defaults.dbName;
            return {
                host,
                port,
                dbName,
                httpUri: `http://${host}:${port}/v1/database/${dbName}/sql`,
                wsUri: `ws://${host}:${port}/v1/database/${dbName}/subscribe`
            };
        }
    } catch {
        // Fallback to defaults
    }
    return defaults;
}

export async function getSdbConfig(): Promise<SdbConfig> {
    const defaults: SdbConfig = {
        host: "127.0.0.1",
        port: 3000,
        dbName: "roadmap2",
        httpUri: "http://127.0.0.1:3000/v1/database/roadmap2/sql",
        wsUri: "ws://127.0.0.1:3000/v1/database/roadmap2/subscribe"
    };

    try {
        // Try config.yaml first
        const yamlPath = join(process.cwd(), "roadmap", "config.yaml");
        if (existsSync(yamlPath)) {
            const content = readFileSync(yamlPath, "utf-8");
            const cfg = parseYaml(content) as any;
            if (cfg?.database) {
                const host = cfg.database.host || defaults.host;
                const port = cfg.database.port || defaults.port;
                const dbName = cfg.database.name || defaults.dbName;
                return {
                    host,
                    port,
                    dbName,
                    httpUri: `http://${host}:${port}/v1/database/${dbName}/sql`,
                    wsUri: `ws://${host}:${port}/v1/database/${dbName}/subscribe`
                };
            }
        }

        // Fallback to flat config
        const fs = new FileSystem(process.cwd());
        const config = await fs.loadConfig();
        if (config?.database) {
            const host = config.database.host || defaults.host;
            const port = config.database.port || defaults.port;
            const dbName = config.database.name || defaults.dbName;
            return {
                host,
                port,
                dbName,
                httpUri: `http://${host}:${port}/v1/database/${dbName}/sql`,
                wsUri: `ws://${host}:${port}/v1/database/${dbName}/subscribe`
            };
        }
    } catch {
        // Fallback to defaults
    }
    return defaults;
}

/**
 * Execute a SQL query against SpacetimeDB (Synchronous via curl).
 */
export function querySdbSync(sql: string): any[] {
    const config = getSdbConfigSync();
    const tmpFile = join(process.cwd(), `.sdb_query_${Math.random().toString(36).substring(7)}.json`);
    try {
        writeFileSync(tmpFile, sql);
        const cmd = `curl -s -X POST -H "Content-Type: application/json" --data-binary "@${tmpFile}" "${config.httpUri}"`;
        const result = execSync(cmd, { encoding: "utf8", timeout: 15000 });
        try { unlinkSync(tmpFile); } catch {}
        if (!result || result.trim() === "") return [];
        return parseSdbJson(result);
    } catch (e) {
        try { unlinkSync(tmpFile); } catch {}
        return [];
    }
}

/**
 * Execute a SQL query against SpacetimeDB (Asynchronous via curl).
 * 
 * We use curl instead of fetch because Node.js fetch can sometimes fail with 'fetch failed' 
 * in local environments due to IPv6/IPv4 or proxy issues, whereas curl is more robust.
 */
async function executeQuery(uri: string, sql: string): Promise<any[]> {
    return new Promise((resolve) => {
        const tmpFile = join(process.cwd(), `.sdb_query_async_${Math.random().toString(36).substring(7)}.json`);
        try {
            writeFileSync(tmpFile, sql);
            const curl = spawn("curl", [
                "-s", "-X", "POST", 
                "-H", "Content-Type: application/json", 
                "--data-binary", `@${tmpFile}`, 
                uri
            ]);

            let result = "";
            curl.stdout.on("data", (data) => {
                result += data.toString();
            });

            curl.on("close", (code) => {
                try { unlinkSync(tmpFile); } catch {}
                if (code !== 0 || !result || result.trim() === "") {
                    resolve([]);
                } else {
                    resolve(parseSdbJson(result));
                }
            });

            curl.on("error", (err) => {
                console.error("[DEBUG] curl spawn error:", err);
                try { unlinkSync(tmpFile); } catch {}
                resolve([]);
            });
        } catch (e) {
            try { unlinkSync(tmpFile); } catch {}
            resolve([]);
        }
    });
}

/**
 * Execute a SQL query against SpacetimeDB (Asynchronous).
 */
export async function querySdb(sql: string): Promise<any[]> {
    const config = await getSdbConfig();
    return executeQuery(config.httpUri, sql);
}

/**
 * Execute a reducer call against SpacetimeDB (Synchronous).
 */
export function callReducerSync(reducer: string, args: any[]): boolean {
    const config = getSdbConfigSync();
    const url = `${config.httpUri.replace('/sql', '/call')}/${reducer}`;
    const tmpFile = join(process.cwd(), `.sdb_call_${Math.random().toString(36).substring(7)}.json`);
    try {
        writeFileSync(tmpFile, JSON.stringify(args));
        const cmd = `curl -s -X POST -H "Content-Type: application/json" --data-binary "@${tmpFile}" "${url}"`;
        execSync(cmd, { encoding: "utf8", timeout: 15000 });
        try { unlinkSync(tmpFile); } catch {}
        return true;
    } catch (e) {
        try { unlinkSync(tmpFile); } catch {}
        return false;
    }
}

function parseSdbJson(jsonStr: string): any[] {
    try {
        const json = JSON.parse(jsonStr);
        const data = Array.isArray(json) ? json[0] : json;
        if (!data || !data.schema || !data.rows) return [];

        const headers = data.schema.elements.map((el: any) => el.name.some || el.name);
        return data.rows.map((row: any[]) => {
            const obj: any = {};
            headers.forEach((h: string, i: number) => {
                let val = row[i];
                if (Array.isArray(val) && val.length === 2) {
                    if (val[0] === 1) { // some
                        val = val[1];
                        if (Array.isArray(val) && val.length === 0) val = null;
                    } else if (val[0] === 0) { // none
                        val = null;
                    }
                }
                obj[h] = val;
            });
            return obj;
        });
    } catch {
        return [];
    }
}
