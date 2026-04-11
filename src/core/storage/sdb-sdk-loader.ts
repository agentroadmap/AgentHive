// sdb-sdk-loader.ts - Connect to SDB directly (port 3000)

import type { Proposal, Directive } from "../../types/index.ts";
import { getSdbConfig, querySdbSync } from "./sdb-client.ts";
import { AcceptanceCriteriaManager, extractStructuredSection } from "../../markdown/structured-sections.ts";
import WebSocket from "ws";

export interface SdbData {
    proposals: Proposal[];
    directives: Directive[];
    messages: any[];
}

export type SdbUpdateCallback = (data: SdbData) => void;

export async function connectSdb(): Promise<any> {
    return { isActive: true };
}

/** Convert microsecond timestamp to milliseconds */
function toMs(timestamp: any): number {
  if (!timestamp) return 0;
  const num = Number(timestamp);
  if (num > 1e15) return Math.floor(num / 1000);
  return num;
}

export async function getSdbData(): Promise<SdbData> {
    try {
        const { querySdb } = await import("./sdb-client.ts");
        const rows = await querySdb("SELECT * FROM proposal");
        const directivesRows = await querySdb("SELECT id, display_id, title, body_markdown as description, status FROM proposal WHERE proposal_type = 'DIRECTIVE'");
        const messages = await querySdb("SELECT * FROM message_ledger ORDER BY timestamp DESC LIMIT 100");
        
        const proposals: Proposal[] = rows.map((row: any) => {
            const id = String(row.display_id || row.id);
            const status = row.status || "New";
            const bodyText = String(row.body_markdown || "");

            return {
                id,
                title: String(row.title),
                status: status as any,
                priority: (row.priority || "medium").toLowerCase() as Proposal["priority"],
                assignee: [],
                labels: row.tags ? String(row.tags).split(",").map((s: string) => s.trim()).filter(Boolean) : [],
                dependencies: [],
                description: String(row.description || "") || extractStructuredSection(bodyText, "description") || "",
                implementationPlan: extractStructuredSection(bodyText, "implementationPlan") || undefined,
                implementationNotes: String(row.process_logic || "") || extractStructuredSection(bodyText, "implementationNotes") || "",
                finalSummary: extractStructuredSection(bodyText, "finalSummary") || "",
                rawContent: bodyText,
                acceptanceCriteriaItems: AcceptanceCriteriaManager.parseAllCriteria(bodyText),
                createdDate: row.created_at ? new Date(toMs(row.created_at)).toISOString() : new Date().toISOString(),
                updatedDate: row.updated_at ? new Date(toMs(row.updated_at)).toISOString() : new Date().toISOString(),
                budgetLimitUsd: row.budget_limit_usd,
                proposalType: row.proposal_type,
                domainId: row.domain_id,
                category: row.category,
            };
        });

        const directiveData: Directive[] = directivesRows.map((row: any) => ({
            id: String(row.display_id || row.id),
            title: String(row.title),
            description: String(row.description || ""),
            status: String(row.status || "New"),
            rawContent: "",
        }));

        return { proposals, directives: directiveData, messages };
    } catch (err: any) {
        if (process.env.DEBUG) {
            console.error(`[DEBUG] getSdbData Error: ${err.message}`);
        }
        return { proposals: [], directives: [], messages: [] };
    }
}

// Global error handler to catch Node 24 native WebSocket fetch failed throws
if (typeof process !== "undefined" && typeof process.on === "function") {
    process.on("unhandledRejection", (reason: any) => {
        if (reason && reason.message && reason.message.includes("fetch failed")) {
            // Silence native websocket fetch failures
        } else {
            // Re-throw if it's something else
            // throw reason;
        }
    });
}

export function subscribeSdb(callback: SdbUpdateCallback): () => void {
    let closed = false;
    let ws: any = null;
    let pollInterval: any = null;

    function startPolling() {
        if (closed || pollInterval) return;
        pollInterval = setInterval(() => {
            if (closed) return;
            getSdbData().then(callback).catch(e => {
                if (process.env.DEBUG) console.error("[DEBUG] Polling update failed", e);
            });
        }, 3000);
    }

    async function connect() {
        if (closed) return;
        const config = await getSdbConfig();
        
        const WebSocketClient = WebSocket || (globalThis as any).WebSocket;

        if (!WebSocketClient) {
            startPolling();
            return;
        }

        try {
            ws = new WebSocketClient(config.wsUri, "v1.json.spacetimedb");
        } catch (e: any) {
            startPolling();
            return;
        }
        
        ws.on("open", () => {
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
            ws.send(JSON.stringify({
                subscribe: {
                    query_strings: ["SELECT * FROM proposal", "SELECT * FROM message_ledger", "SELECT * FROM workforce_pulse"]
                }
            }));
        });

        ws.on("message", (msg: any) => {
            try {
                const data = JSON.parse(msg.toString());
                if (data.SubscriptionUpdate) {
                    getSdbData().then(callback).catch(() => {});
                }
            } catch (e) {}
        });

        ws.on("error", (err: any) => {
            startPolling();
        });

        ws.on("close", () => {
            if (!closed) {
                startPolling();
                setTimeout(connect, 5000);
            }
        });
    }

    connect().catch(() => {
        startPolling();
    });

    return () => {
        closed = true;
        if (ws) {
            try { ws.close(); } catch(e) {}
        }
        if (pollInterval) {
            clearInterval(pollInterval);
        }
    };
}
