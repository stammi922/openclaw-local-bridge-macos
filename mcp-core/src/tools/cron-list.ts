import { z } from "zod";
import { runOpenclawJson } from "../cli-wrapper.js";

const InputSchema = z.object({ enabled_only: z.boolean().optional().default(false) });

export type CronJob = { id: string; enabled: boolean; [k: string]: unknown };
export type CronListResult = CronJob[];

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
    const raw = await runOpenclawJson<{ jobs: CronJob[] } | CronJob[]>(["cron", "list", "--json"]);
    // Upstream CLI returns `{jobs: [...]}`; unwrap to a bare array to match the
    // shape of every other list tool (sessions_list, agents_list, memory_search, lcm_grep).
    const jobs: CronJob[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { jobs?: unknown }).jobs)
        ? (raw as { jobs: CronJob[] }).jobs
        : [];
    return enabled_only ? jobs.filter(j => j.enabled) : jobs;
  },
};
