import posthog from "posthog-js"

const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST

if (!projectToken || !host) {
  // PostHog is optional: without its env vars the app runs and sends nothing.
} else {
  // Test traffic (clumsy-user agents) opens the app with ?synthetic=1; every event in that tab gets
  // synthetic_tester=true so it can be filtered out.
  let synthetic = false
  try {
    if (new URLSearchParams(window.location.search).has("synthetic")) sessionStorage.setItem("synthetic_tester", "1")
    synthetic = sessionStorage.getItem("synthetic_tester") === "1"
  } catch { /* storage blocked */ }
  posthog.init(projectToken, {
    before_send: (event) => {
      if (synthetic && event) event.properties = { ...event.properties, synthetic_tester: true }
      return event
    },
    api_host: host,
    defaults: "2026-05-30",
  })
}
