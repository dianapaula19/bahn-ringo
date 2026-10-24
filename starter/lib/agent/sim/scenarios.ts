// Simulated phone trees and hidden persona scripts, one per demo order.
// Everything here is fictional and labelled "Simulated" in the UI. Numbers are
// sim:<siteId>. Only "human" nodes call the model, which plays the persona.
import type { IvrNode, IvrTree, SimPersona, SimScenario } from "@/lib/contract"

type SiteLike = { id: string; name: string; details: Record<string, unknown> }

const menu = (id: string, language: IvrNode["language"], prompt: string, options: [string, string, string][]): IvrNode =>
  ({ id, kind: "menu", language, prompt, seconds: 20, options: options.map(([digit, label, next]) => ({ digit, label, next })) })
const hold = (id: string, language: IvrNode["language"], prompt: string, seconds: number, next: string): IvrNode => ({ id, kind: "hold", language, prompt, seconds, next })
const human = (id: string, language: IvrNode["language"], personaId: string): IvrNode => ({ id, kind: "human", language, prompt: "", personaId })
const voicemail = (id: string, language: IvrNode["language"], prompt: string): IvrNode => ({ id, kind: "voicemail", language, prompt })
const closed = (language: IvrNode["language"], prompt: string): IvrNode => ({ id: "closed", kind: "closed", language, prompt })

function tree(site: SiteLike, root: string, nodes: IvrNode[], closedPrompt: string, lang: IvrNode["language"]): IvrTree {
  const all = [...nodes, closed(lang, closedPrompt)]
  return {
    siteId: site.id, number: `sim:${site.id}`, timezone: String(site.details.timezone ?? "UTC"),
    openingHours: (site.details.opening_hours ?? {}) as Record<string, string | null>,
    root, closedNode: "closed", nodes: Object.fromEntries(all.map((n) => [n.id, n])),
  }
}

/** Velantora Helsinki (site-001): main menu → collections → stock control hold → stock control. */
function velantora(site: SiteLike, stock: SimPersona, desk: SimPersona): IvrTree {
  return tree(site, "main", [
    menu("main", "en", "Tervetuloa, welcome to Velantora Helsinki. For sales, press 1. For service, press 2. For vehicle collections and stock control, press 3. For reception, press 0.",
      [["1", "Sales", "sales_vm"], ["2", "Service", "service_vm"], ["3", "Vehicle collections and stock control", "collections"], ["0", "Reception", "reception"]]),
    voicemail("sales_vm", "en", "Our sales team is with customers. Please leave a message after the tone."),
    voicemail("service_vm", "en", "Service bookings are handled online. Leave a message after the tone."),
    menu("collections", "en", "Vehicle collections. For a booked collection at the collection bay, press 1. For stock control and key custody, press 2.",
      [["1", "Collection bay desk", "bay_desk"], ["2", "Stock control and key custody", "stock_hold"]]),
    hold("stock_hold", "en", "Hold music. A recorded voice repeats: all stock control staff are busy, please stay on the line.", 35, "stock"),
    human("stock", "en", stock.id),
    human("bay_desk", "en", desk.id),
    human("reception", "en", desk.id),
  ], "Velantora Helsinki is closed. Opening hours are Monday to Friday 08:30 to 19:00 and Saturday 09:00 to 13:00.", "en")
}

const PERSONA_STYLE = "Busy but helpful, plain spoken. Gives exact answers when you know them."

export function scenarioFor(orderId: string, site: SiteLike): SimScenario {
  switch (orderId) {
    case "ord-00516": {
      const stock: SimPersona = {
        id: "p-516-stock", siteId: site.id, name: "Ilona Alderbrook", role: "stock control lead", language: "en", style: PERSONA_STYLE,
        knows: [
          "The Volvo V60 for order CD-420516 (plate DEMO-FI-PV2HSD) came back from the warehouse transfer on 20 October and is on the front lot.",
          "Reception does not hold the keys; the key set is in the stock control key cabinet.",
          "Ilona Alderbrook (stock control) holds the key set and releases the car in person at collection bay 4.",
          "The side gate is vehicle entry only and is not a handover point.",
          "For the slot on Monday 26 October between 09:00 and 12:00 Helsinki time (clocks went back on 25 October) she will be at bay 4.",
          "The driver must show the order reference and their driver ID before release.",
          "The branch desk wants a call 30 minutes before the driver arrives.",
        ],
        doesNotKnow: ["anything about payment or invoices", "the delivery address or delivery time", "which driver is coming"],
      }
      const desk: SimPersona = {
        id: "p-516-desk", siteId: site.id, name: "Adrian Alderbrook", role: "branch desk", language: "en", style: PERSONA_STYLE,
        knows: ["The branch desk does not hold collection keys.", "Key custody and release for collections is handled by stock control, option 3 then 2 on the phone menu."],
        doesNotKnow: ["which car is where", "who holds a specific key set"],
      }
      return { orderId, ivr: velantora(site, stock, desk), personas: [stock, desk], script: [] }
    }
    case "ord-00593": {
      const stock: SimPersona = {
        id: "p-593-stock", siteId: site.id, name: "Ilona Alderbrook", role: "stock control lead", language: "en", style: PERSONA_STYLE,
        knows: [
          "The BMW M4 with VIN SYNH78NNZVFZVVEJJ for order CD-420593 is not in Velantora Helsinki's stock list.",
          "There is a similar stock reference on the list, but it belongs to a different car, and staff will not hand that car over.",
          "Stock control has no record of this VIN being transferred to or from this branch.",
        ],
        doesNotKnow: ["which site physically holds this VIN", "anything the customer said", "when the car will arrive"],
      }
      const desk: SimPersona = {
        id: "p-593-desk", siteId: site.id, name: "Adrian Alderbrook", role: "branch desk", language: "en", style: PERSONA_STYLE,
        knows: ["A Bahn driver has been waiting at the collection bay since this morning.", "Stock questions go to stock control, option 3 then 2."],
        doesNotKnow: ["where the BMW M4 is"],
      }
      return {
        orderId, ivr: velantora(site, stock, desk), personas: [stock, desk], script: [],
        driver: {
          driverId: "drv-139", persona: "Yara Sivellin, freelance driver, calm and short in chat, writes in English.",
          knows: [
            "Still at Velantora Helsinki collection bay, has been there since about 10:00 Helsinki time.",
            "Reception and the bay desk could not find the BMW M4 on their handover list.",
            "Can wait until about 12:30 Helsinki time, then needs a travel plan back to Jyväskylä.",
            "Has not been offered any other car and would not take one without an instruction.",
          ],
        },
      }
    }
    case "ord-00010": {
      const desk: SimPersona = {
        id: "p-010-desk", siteId: site.id, name: "Mareike Ivyfeld", role: "Fahrzeugausgabe (vehicle release desk)", language: "de", style: "Freundlich, knapp, spricht Deutsch und versteht Englisch.",
        knows: [
          "Der Mercedes-Benz E-Klasse für Auftrag CD-420010 steht abholbereit an der besetzten Fahrzeugbucht.",
          "Direkter Kontakt für die Abholung: die Fahrzeugausgabe, Mareike Ivyfeld, erreichbar unter fahrzeugausgabe-039@example.test.",
          "Bei der Übergabe muss der Fahrer die Auftragsnummer und seinen Fahrerausweis zeigen.",
          "Schlüssel und Zubehörliste werden an der Fahrzeugbucht gemeinsam geprüft.",
          "Die Fahrzeugausgabe ist Montag bis Freitag 08:30 bis 18:00 besetzt.",
        ],
        doesNotKnow: ["welcher Fahrer kommt", "Zahlungen oder Rechnungen", "den Lieferort"],
      }
      return {
        orderId, personas: [desk],
        ivr: tree(site, "main", [
          menu("main", "de", "Willkommen bei Kervalin Frankfurt. Für den Verkauf drücken Sie die 1. Für Fahrzeugabholungen drücken Sie die 2. Für die Werkstatt drücken Sie die 3.",
            [["1", "Verkauf", "sales_vm"], ["2", "Fahrzeugabholung", "transfer"], ["3", "Werkstatt", "service_vm"]]),
          voicemail("sales_vm", "de", "Unser Verkaufsteam ist im Gespräch. Bitte hinterlassen Sie eine Nachricht nach dem Signalton."),
          voicemail("service_vm", "de", "Die Werkstatt ist ausgelastet. Bitte hinterlassen Sie eine Nachricht nach dem Signalton."),
          hold("transfer", "de", "Sie werden verbunden. Bitte warten Sie.", 15, "desk"),
          human("desk", "de", desk.id),
        ], "Kervalin Frankfurt ist geschlossen. Öffnungszeiten: Montag bis Freitag 08:30 bis 19:00, Samstag 10:00 bis 14:00.", "de"),
        // The first attempt drops during the transfer: outcome unknown, so Ringo must reconcile before it redials.
        script: [{ attempt: 1, atNode: "transfer", event: "drop" }],
      }
    }
    case "ord-00023": {
      const lot: SimPersona = {
        id: "p-023-lot", siteId: site.id, name: "Felix Alderfield", role: "reconditioning lot lead", language: "en", style: "Direct, a little rushed, switches to English easily.",
        knows: [
          "The Mercedes-Benz GLC for order CD-420023 is at Vellendor Berlin's reconditioning lot.",
          "The street address is Eichenlichtallee 79, Berlin; use the inspection lot gate on the left of the building.",
          "Felix Alderfield releases the keys after the condition sheet is checked at the inspection line.",
          "The driver must show the order reference and driver ID.",
        ],
        doesNotKnow: ["whether the customer wants this as the pickup address", "the delivery side", "any prices"],
      }
      return {
        orderId, personas: [lot], script: [],
        ivr: tree(site, "main", [
          menu("main", "de", "Vellendor Berlin, guten Tag. Für Verkauf drücken Sie die 1. Für Aufbereitung und Fahrzeugausgabe drücken Sie die 2. For English, press 9.",
            [["1", "Verkauf", "sales_vm"], ["2", "Aufbereitung und Fahrzeugausgabe", "lot_hold"], ["9", "English", "main_en"]]),
          menu("main_en", "en", "Vellendor Berlin. For sales, press 1. For reconditioning and vehicle release, press 2.",
            [["1", "Sales", "sales_vm"], ["2", "Reconditioning and vehicle release", "lot_hold"]]),
          voicemail("sales_vm", "de", "Bitte hinterlassen Sie eine Nachricht nach dem Signalton."),
          hold("lot_hold", "en", "Please hold, connecting you to the reconditioning lot.", 20, "lot"),
          human("lot", "en", lot.id),
        ], "Vellendor Berlin ist geschlossen. Montag bis Freitag 09:00 bis 19:00, Samstag 08:00 bis 12:00.", "de"),
      }
    }
    case "ord-00458": {
      const store: SimPersona = {
        id: "p-458-store", siteId: site.id, name: "Jasper Alderfield", role: "storekeeper", language: "de", style: "Formal and firm.",
        knows: [
          "Der Ferrari Roma für CD-420458 steht im gesicherten Lager.",
          "Der Verkäufer hat die Herausgabe wegen einer offenen Rechnung gesperrt; es liegt keine unterschriebene Freigabe vor.",
          "Kein Fahrer soll kommen, bevor der Verkäufer die Sperre aufhebt und eine unterschriebene Freigabe schickt.",
        ],
        doesNotKnow: ["wann die Rechnung bezahlt wird", "Details zum Kaufvertrag"],
      }
      return { orderId, personas: [store], script: [], ivr: genericTree(site, store) }
    }
    default:
      return { orderId, personas: [], script: [], ivr: genericTree(site, null) }
  }
}

/** Any other pickup site: main menu → vehicle collections → hold → voicemail. Ringo learns nothing from it. */
function genericTree(site: SiteLike, persona: SimPersona | null): IvrTree {
  return tree(site, "main", [
    menu("main", "en", `Welcome to ${site.name}. For sales, press 1. For vehicle collections, press 2.`,
      [["1", "Sales", "vm"], ["2", "Vehicle collections", "hold"]]),
    hold("hold", "en", "Hold music. All colleagues are busy.", 40, persona ? "human" : "vm"),
    ...(persona ? [human("human", persona.language, persona.id)] : []),
    voicemail("vm", "en", "Nobody is available. Please leave a message after the tone."),
  ], `${site.name} is closed right now.`, "en")
}
