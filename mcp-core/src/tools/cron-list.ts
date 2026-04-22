import { z } from "zod";
import { runOpenclawJson } from "../cli-wrapper.js";

const InputSchema = z.object({ enabled_only: z.boolean().optional().default(false) });

export type CronJob = { id: string; enabled: boolean; [k: string]: unknown };
export type CronListResult = { jobs: CronJob[] };

export const cronListTool = {
  definition: {
    name: "cron_list",
    description: "List cron jobs registered with OpenClaw, optionally only enabled ones.",
    inputSchema: {
      type: "object",
      properties: {
        enabled_only: {
          type: "boolean",
          description: "If true, only return jobs with enabled: true",
          default: false,
        },
      },
    },
  },
  async handler(rawArgs: unknown): Promise<CronListResult> {
    const { enabled_only } = InputSchema.parse(rawArgs);
    const raw = await runOpenclawJson<{ jobs: CronJob[] }>(["cron", "list", "--json"]);
    const jobs =
      raw && typeof raw === "object" && Array.isArray((raw as { jobs?: unknown }).jobs)
        ? (raw as { jobs: CronJob[] }).jobs
        : [];
    return { jobs: enabled_only ? jobs.filter(j => j.enabled) : jobs };
  },
};
