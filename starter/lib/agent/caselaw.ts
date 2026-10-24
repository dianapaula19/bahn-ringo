// Case law for the Reviewer gate. Each rule was written by hand from the review
// notes on the 14 dataset agent_proposals and cites the proposals it came from.
// A person signs this file off; the eval (scripts/eval-reviewer.ts) re-scores
// the reviewed proposals with each one's own rules removed (leave-one-out).
import type { CaseLawRule } from "@/lib/contract"

export type GateInput = {
  command: string
  actionType: string | null
  payload: Record<string, unknown>
  summary: string
  evidenceRefs: { table: string; id: string }[]
  createdAt: string
}

export type GateContext = {
  /** travel_options id → checked_at */
  travelOptionCheckedAt: Record<string, string>
  /** Source ids that carry verified-level evidence (approved proof, verified document, ferry gate event). */
  verifiedIds: Set<string>
}

type Rule = CaseLawRule & { test: (p: GateInput, ctx: GateContext) => string | null }

/** Every string inside a payload, for wording checks. */
export const payloadText = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) ? v.map(payloadText).join(" ") : v && typeof v === "object" ? Object.values(v).map(payloadText).join(" ") : ""

export const MECHANICAL = /\b(restart\w*|reset\w*|reboot\w*|diagnos\w*|drive on|keep driving|continue driving|jump[- ]?start\w*|top up the oil)\b/i
const BOOKED_WORDING = /\b(booked|confirmed|reserved|guaranteed?)\b/i
const HOURS_2 = 2 * 3600_000

export const RULES: Rule[] = [
  {
    id: "CL-01", title: "No mechanical advice", effect: "block", learnedFrom: ["agent-x95169653143f1607"],
    text: "Never tell a driver to restart, reset, diagnose or drive on, and never authorise restarting or driving.",
    test: (p) => {
      if (p.payload.authorize_restart === true || p.payload.authorize_driving === true) return "The proposal authorises restarting or driving the car."
      const m = MECHANICAL.exec(payloadText(p.payload))
      return m ? `The message gives mechanical advice ("${m[0]}").` : null
    },
  },
  {
    id: "CL-02", title: "No confirmation without verified evidence", effect: "block", learnedFrom: ["agent-x40ab609877909161"],
    text: "Never set a confirmed, verified or boarding flag to true unless a verified-level source is cited.",
    test: (p, ctx) => {
      const key = Object.keys(p.payload).find((k) => p.payload[k] === true && /(confirmed|verified)$|boarding/.test(k))
      if (!key) return null
      return p.evidenceRefs.some((r) => ctx.verifiedIds.has(r.id)) ? null : `"${key}" is set without a verified source (a position or a message is not a gate scan).`
    },
  },
  {
    id: "CL-03", title: "No blame from photos", effect: "block", learnedFrom: ["agent-xaa0af5ec9f775363"],
    text: "Never assign fault or liability. Photos show a reported condition, not when or by whom it happened.",
    test: (p) => {
      if (p.actionType === "attribution" || /attribution/.test(p.command)) return "The proposal assigns fault."
      if (p.payload.assign_liability === true) return "The proposal assigns liability."
      const v = Object.values(p.payload).find((x) => typeof x === "string" && /_CAUSED$/.test(x))
      return v ? `The proposal records "${v}".` : null
    },
  },
  {
    id: "CL-04", title: "Never pick from an unrefreshed list", effect: "block", learnedFrom: ["agent-x3151927d69c76a10"],
    text: "Do not take the first available option or an option checked more than 2 hours ago without a fresh capacity check.",
    test: (p, ctx) => {
      const fresh = p.payload.require_fresh_capacity_check === true || p.payload.refresh_capacity === true
      if (p.payload.use_first_available === true && !fresh) return "It takes the first available option from an unrefreshed list."
      for (const key of ["option_id", "travel_option_id"]) {
        const id = p.payload[key]
        const checked = typeof id === "string" ? ctx.travelOptionCheckedAt[id] : undefined
        if (checked && !fresh && Date.parse(p.createdAt) - Date.parse(checked) > HOURS_2) return `Option ${id} was checked at ${checked}, more than 2 hours before the proposal.`
      }
      return null
    },
  },
  {
    id: "CL-05", title: "A backup is not a booking", effect: "condition", learnedFrom: ["agent-xf4800bb1b907cf89"],
    text: "Preparing a backup never cancels the current booking and is never described as booked or confirmed.",
    test: (p) => {
      if (p.payload.cancel_current === true) return "It cancels the current assignment while preparing a backup."
      const backup = /backup|replacement/.test(p.command) || p.payload.look_for_backup === true
      if (!backup) return null
      return BOOKED_WORDING.test(payloadText(p.payload) + " " + p.summary) ? "It describes the backup as booked or confirmed." : "Prepare a named backup only; do not represent it as booked."
    },
  },
  {
    id: "CL-06", title: "Keep the promise until a booking is confirmed", effect: "condition", learnedFrom: ["agent-x4ac988b20000595f", "agent-x68cbbd7e6e58691c"],
    text: "A vehicle booking attempt or a crossing change keeps the customer promise until the booking is confirmed; only a slot.change may change it.",
    test: (p) => {
      if (p.payload.change_promise === true && p.actionType !== "slot.change") return "It changes the customer promise before a booking is confirmed."
      const vehicleBooking = /^travel\.(book|rebook)/.test(p.command) && (p.payload.vehicle_space_required === true || /ferry|crossing|rebook/.test(p.command))
      return vehicleBooking && p.payload.change_promise !== false ? "Keep the customer promise unchanged until the booking is confirmed." : null
    },
  },
  {
    id: "CL-07", title: "A quote is not a purchase", effect: "condition", learnedFrom: ["agent-x68cbbd7e6e58691c", "agent-x1c721af5508e707a"],
    text: "A refresh or capacity check returns with what it found for a separate booking decision. It never buys.",
    test: (p) => {
      const refresh = p.payload.refresh_capacity === true || /refresh|recheck/.test(p.command)
      if (!refresh || !p.command.startsWith("travel.")) return null
      return p.payload.buy_ticket === true ? "It buys while it should only refresh." : "Return with capacity and feasibility for a separate booking decision."
    },
  },
  {
    id: "CL-08", title: "A ticket is not a movement", effect: "condition", learnedFrom: ["agent-x44051005c0c18aaf"],
    text: "After booking driver travel, still verify that the prior duty ended and the driver arrived.",
    test: (p) => (/^travel\.book_driver/.test(p.command) || typeof p.payload.passenger_assignment_id === "string"
      ? "After booking, verify the prior duty's completion and the driver's arrival." : null),
  },
  {
    id: "CL-09", title: "Tell the customer only what the records establish", effect: "condition", learnedFrom: ["agent-xf874ddfecf02bb68"],
    text: "Do not tell the customer something (an invoice, a booking, a time) that no record establishes yet.",
    test: (p) => {
      const key = Object.keys(p.payload).find((k) => k.startsWith("tell_customer"))
      if (!key) return null
      return p.payload[key] === true && p.evidenceRefs.length === 0 ? `"${key}" has no supporting record.` : "Say nothing to the customer until the record is found."
    },
  },
  {
    id: "CL-10", title: "The agent never contacts a customer", effect: "block", learnedFrom: [],
    text: "From the brief: the agent never contacts a customer on its own. A person sends customer messages (customer.message, locked to ask).",
    test: (p) => {
      const contact = p.payload.contact
      if (Array.isArray(contact) ? contact.includes("customer") : contact === "customer") return "It asks the agent to contact the customer."
      const toCustomer = p.payload.recipient === "customer" || p.payload.recipientType === "customer" || p.payload.recipient_type === "customer"
      return toCustomer && p.actionType !== "customer.message" ? "A customer-facing message must be a customer.message that a person sends." : null
    },
  },
]

/** CL-00 is enforced at execution (recheck before write), listed for the reviewer. */
export const CL_00: CaseLawRule = {
  id: "CL-00", title: "Recheck before write", effect: "block",
  learnedFrom: ["all 14 dataset proposals (RECHECK_CURRENT_STATE_BEFORE_WRITE)"],
  text: "On approval, if the order has a newer event than the proposal's basis, nothing executes and the result is STALE.",
}

export const CASE_LAW: CaseLawRule[] = [...RULES.map(({ test: _t, ...r }) => r), CL_00]
