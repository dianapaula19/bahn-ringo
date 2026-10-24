import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { resourceFromAttributes } from "@opentelemetry/resources"

const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST

export const ringLogsProvider = projectToken && host
  ? new LoggerProvider({
      resource: resourceFromAttributes({ "service.name": "car-delivery-control-room" }),
      processors: [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({
            url: `${host}/i/v1/logs`,
            headers: {
              Authorization: `Bearer ${projectToken}`,
              "Content-Type": "application/json",
            },
          }),
        }),
      ],
    })
  : null

// This logger is intentionally separate: only log records added for PostHog leave the app.
export const ringLogsLogger = ringLogsProvider?.getLogger("posthog.ring.lifecycle")

export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  if (!projectToken || !host) {
    // PostHog is optional: without its env vars the app runs and sends nothing.

    return
  }
}
