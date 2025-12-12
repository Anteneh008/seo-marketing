"use server";

import { ApiPath } from "@/convex/http";
import { buildPerplexityPrompt } from "@/prompts/perplexity";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { auth } from "@clerk/nextjs/server";
import retryAnalysisOnly from "./retryAnalysis";

if (!process.env.NEXT_PUBLIC_CONVEX_URL) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
}
if (!process.env.BRIGHTDATA_API_KEY) {
  throw new Error("BRIGHTDATA_API_KEY is not set");
}

export default async function startScraping(
  prompt: string,
  existingJobId?: string,
  country: string = "US",
) {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("User ID is required");
  }

  //   Initialize Convex Client
  const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

  let jobId: string;

  if (existingJobId) {
    // Check if we can use smart retry (analysis only)
    const retryInfo = await convex.query(api.scrapingJobs.canUseSmartRetry, {
      jobId: existingJobId as Id<"scrapingJobs">,
      userId: userId,
    });

    if (retryInfo.canRetryAnalysisOnly) {
      console.log("Using smart retry - analysis only for job", existingJobId);

      const result = await retryAnalysisOnly(existingJobId);

      if (result.ok) {
        return {
          ok: true,
          data: { snapshot_id: null },
          jobId: existingJobId,
          smartretry: true,
        };
      } else {
        return {
          ok: false,
          error: result.error || "Smart retry failed",
        };
      }
    } else {
      console.log("Full retry required for job:", existingJobId);
      //   Retry existing job - reset it to pending status
      await convex.mutation(api.scrapingJobs.retryJob, {
        jobId: existingJobId as Id<"scrapingJobs">,
      });
      jobId = existingJobId;
    }
  } else {
    // Create a new job record in the database

    jobId = await convex.mutation(api.scrapingJobs.createScrapingJob, {
      originalPrompt: prompt,
      userId: userId,
    });
  }

  //   Include the job ID in the webhook URL as a query parameter
  const WEBHOOK_URL = `${process.env.NEXT_PUBLIC_CONVEX__SITE_URL}${ApiPath.Webhook}?jobId=${jobId}`;
  const encodedWebhookUrl = encodeURIComponent(WEBHOOK_URL);

  // Call to brightdata...

  const datasetId = process.env.BRIGHTDATA_DATASET_ID;

  if (!datasetId) {
    throw new Error("BRIGHTDATA_DATASET_ID is not set");
  }

  const url = `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${datasetId}&custom_output_fields=url&notify=${encodedWebhookUrl}&include_errors=true`;

  const perplexityPrompt = buildPerplexityPrompt(prompt);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: [
          {
            url: "https://www.perplexity.ai",
            prompt: perplexityPrompt,
            country: country,
            index: 1,
          },
        ],
        custom_output_fields: [
          "url",
          "prompt",
          "answer_text",
          "sources",
          "citations",
          "timestamp",
          "input",
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Mark job as failed
      await convex.mutation(api.scrapingJobs.failJob, {
        jobId: jobId as Id<"scrapingJobs">,
        error: `HTTP  ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`,
      });
      return {
        // Mark job as failed
        ok: false,
        error: `HTTP  ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`,
      };
    }

    const data = await response.json().catch(() => null);

    // Extract snapshot ID from the reponse and update the job
    if (data && data.snapshot_id) {
      await convex.mutation(api.scrapingJobs.updateJobWithSnapshotId, {
        jobId: jobId as Id<"scrapingJobs">,
        snapshotId: data.snapshot_id,
      });
    }

    return { ok: true, data, jobId };
  } catch (error) {
    console.error(error);
    // Mark job as failed
    await convex.mutation(api.scrapingJobs.failJob, {
      jobId: jobId as Id<"scrapingJobs">,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
