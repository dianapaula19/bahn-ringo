// Simulated phone trees and hidden persona scripts, one per demo order.
// Everything here is fictional and labelled "Simulated" in the UI. Numbers are
// sim:<siteId>. Only "human" nodes call the model, which plays the persona.
// A site answers in its country's language (DE German, DK Danish, FI Finnish,
// else English); every menu line carries its English text for the transcript.
// Each person and mailbox sits on a ladder rung: site desk → stock control → branch manager.
import type { IvrNode, IvrTree, SimPersona, SimScenario } from "@/lib/contract"
import { langForCountry, type Lang, type Rung } from "./calls"

type SiteLike = { id: string; name: string; details: Record<string, unknown> }

/** A node with what the UI needs: its English text, a short label for the path diagram, and its ladder rung. */
export type Node = IvrNode & { en?: string; label?: string; rung?: Rung }
type Said = [said: string, en: string]

const menu = (id: string, language: Lang, label: string, [prompt, en]: Said, options: [string, string, string][]): Node =>
  ({ id, kind: "menu", language, prompt, en, label, seconds: 20, options: options.map(([digit, l, next]) => ({ digit, label: l, next })) })
const hold = (id: string, language: Lang, [prompt, en]: Said, seconds: number, next: string): Node => ({ id, kind: "hold", language, prompt, en, seconds, next })
const human = (id: string, p: SimPersona, label: string, rung: Rung): Node => ({ id, kind: "human", language: p.language, prompt: "", personaId: p.id, label, rung })
const voicemail = (id: string, language: Lang, label: string, [prompt, en]: Said, rung?: Rung): Node => ({ id, kind: "voicemail", language, prompt, en, label, rung })

function tree(site: SiteLike, nodes: Node[], [closedPrompt, closedEn]: Said, lang: Lang): IvrTree {
  const all: Node[] = [...nodes, { id: "closed", kind: "closed", language: lang, prompt: closedPrompt, en: closedEn }]
  return {
    siteId: site.id, number: `sim:${site.id}`, timezone: String(site.details.timezone ?? "UTC"),
    openingHours: (site.details.opening_hours ?? {}) as Record<string, string | null>,
    root: "main", closedNode: "closed", nodes: Object.fromEntries(all.map((n) => [n.id, n])),
  }
}

/** Short lines the phone itself says, per language. */
export const LINE: Record<Lang, { invalid: string; again: string; nobody: string; recorded: string }> = {
  en: { invalid: "That is not a valid option.", again: "Sorry, I didn't get that.", nobody: "Nobody is available. Please leave a message after the tone.", recorded: "Thank you, your message has been recorded." },
  de: { invalid: "Das ist keine gültige Auswahl.", again: "Entschuldigung, das habe ich nicht verstanden.", nobody: "Zurzeit ist niemand erreichbar. Bitte hinterlassen Sie eine Nachricht nach dem Signalton.", recorded: "Vielen Dank, Ihre Nachricht wurde aufgezeichnet." },
  fi: { invalid: "Virheellinen valinta.", again: "Anteeksi, en saanut selvää.", nobody: "Kukaan ei ole juuri nyt tavoitettavissa. Jätä viesti äänimerkin jälkeen.", recorded: "Kiitos, viestisi on tallennettu." },
  da: { invalid: "Det er ikke et gyldigt valg.", again: "Undskyld, det forstod jeg ikke.", nobody: "Der er ingen ledige lige nu. Læg en besked efter tonen.", recorded: "Tak, din besked er optaget." },
}

/** Velantora Helsinki (site-001), in Finnish: main → 3 collections → 1 bay desk / 2 stock hold → stock control; 9 → branch manager; 0 reception. */
function velantora(site: SiteLike, stock: SimPersona, desk: SimPersona, manager: SimPersona): IvrTree {
  return tree(site, [
    menu("main", "fi", "Main menu", ["Tervetuloa Velantora Helsinkiin. Myynti, paina 1. Huolto, paina 2. Ajoneuvojen nouto ja varasto, paina 3. Toimipisteen päällikkö, paina 9. Vastaanotto, paina 0.",
      "Welcome to Velantora Helsinki. For sales, press 1. For service, press 2. For vehicle collections and stock control, press 3. For the branch manager, press 9. For reception, press 0."],
    [["1", "Sales", "sales_vm"], ["2", "Service", "service_vm"], ["3", "Vehicle collections and stock control", "collections"], ["9", "Branch manager", "manager_hold"], ["0", "Reception (site desk)", "reception"]]),
    voicemail("sales_vm", "fi", "Sales voicemail", ["Myyjämme palvelevat asiakkaita. Jätä viesti äänimerkin jälkeen.", "Our sales team is with customers. Please leave a message after the tone."]),
    voicemail("service_vm", "fi", "Service voicemail", ["Huoltovaraukset tehdään verkossa. Jätä viesti äänimerkin jälkeen.", "Service bookings are handled online. Leave a message after the tone."]),
    menu("collections", "fi", "Collections", ["Ajoneuvojen nouto. Varattu nouto noutokaistalta, paina 1. Varasto ja avainten säilytys, paina 2.",
      "Vehicle collections. For a booked collection at the collection bay, press 1. For stock control and key custody, press 2."],
    [["1", "Collection bay desk (site desk)", "bay_desk"], ["2", "Stock control and key custody", "stock_hold"]]),
    hold("stock_hold", "fi", ["Pitomusiikkia. Nauhoitettu ääni toistaa: kaikki varaston työntekijät ovat varattuja, pysy linjalla.", "Hold music. A recorded voice repeats: all stock control staff are busy, please stay on the line."], 35, "stock"),
    hold("manager_hold", "fi", ["Yhdistän toimipisteen päällikölle. Hetkinen.", "Connecting you to the branch manager. One moment."], 20, "manager"),
    human("stock", stock, "Stock control", "stock_control"),
    human("bay_desk", desk, "Collection bay desk", "site_desk"),
    human("reception", desk, "Reception", "site_desk"),
    human("manager", manager, "Branch manager", "branch_manager"),
  ], ["Velantora Helsinki on suljettu. Aukioloajat: maanantaista perjantaihin 8.30–19.00 ja lauantaisin 9.00–13.00.",
    "Velantora Helsinki is closed. Opening hours are Monday to Friday 08:30 to 19:00 and Saturday 09:00 to 13:00."], "fi")
}

const PERSONA_STYLE = "Busy but helpful, plain spoken. Gives exact answers when you know them."

export function scenarioFor(orderId: string, site: SiteLike): SimScenario {
  const lang = langForCountry(site.details.country)
  const person = (p: Omit<SimPersona, "siteId" | "language">): SimPersona => ({ ...p, siteId: site.id, language: lang })
  switch (orderId) {
    case "ord-00516":
    case "ord-00593": {
      const desk = person({
        id: "p-velantora-desk", name: "Adrian Alderbrook", role: "branch desk", style: PERSONA_STYLE,
        knows: orderId === "ord-00593"
          ? ["A Bahn driver has been waiting at the collection bay since this morning.", "The branch desk does not hold collection keys.", "Stock questions go to stock control, option 3 then 2 on the phone menu."]
          : ["The branch desk does not hold collection keys.", "Key custody and release for collections is handled by stock control, option 3 then 2 on the phone menu."],
        doesNotKnow: ["which car is where", "who holds a specific key set"],
      })
      const manager = person({
        id: "p-velantora-manager", name: "Helmi Alderwood", role: "branch manager", style: "Courteous, brief, a little formal. Does not like being called about single cars.",
        knows: [
          "Velantora Helsinki releases collection cars only at the collection bay, against the order reference and the driver's ID.",
          "Questions about a specific car, VIN or key set are answered by stock control (option 3 then 2), not by the branch manager.",
          "The branch manager does not move, swap or substitute cars on the phone.",
        ],
        doesNotKnow: ["where a specific car or key set is", "anything about payment or invoices", "anything the customer said"],
      })
      const stock = person(orderId === "ord-00516" ? {
        id: "p-516-stock", name: "Ilona Alderbrook", role: "stock control lead", style: PERSONA_STYLE,
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
      } : {
        id: "p-593-stock", name: "Ilona Alderbrook", role: "stock control lead", style: PERSONA_STYLE,
        knows: [
          "The BMW M4 with VIN SYNH78NNZVFZVVEJJ for order CD-420593 is not in Velantora Helsinki's stock list.",
          "There is a similar stock reference on the list, but it belongs to a different car, and staff will not hand that car over.",
          "Stock control has no record of this VIN being transferred to or from this branch.",
          "Collection keys at this branch are kept in the stock control key cabinet, never at reception.",
        ],
        doesNotKnow: ["which site physically holds this VIN", "anything the customer said", "when the car will arrive"],
      })
      return {
        orderId, ivr: velantora(site, stock, desk, manager), personas: [stock, desk, manager], script: [],
        ...(orderId === "ord-00593" ? {
          driver: {
            driverId: "drv-139", persona: "Yara Sivellin, freelance driver, calm and short in chat, writes in English.",
            knows: [
              "Still at Velantora Helsinki collection bay, has been there since about 10:00 Helsinki time.",
              "Reception and the bay desk could not find the BMW M4 on their handover list.",
              "Can wait until about 12:30 Helsinki time, then needs a travel plan back to Jyväskylä.",
              "Has not been offered any other car and would not take one without an instruction.",
            ],
          },
        } : {}),
      }
    }
    case "ord-00010": {
      const desk = person({
        id: "p-010-desk", name: "Mareike Ivyfeld", role: "Fahrzeugausgabe (vehicle release desk)", style: "Freundlich, knapp, spricht Deutsch und versteht Englisch.",
        knows: [
          "Der Mercedes-Benz E-Klasse für Auftrag CD-420010 steht abholbereit an der besetzten Fahrzeugbucht.",
          "Direkter Kontakt für die Abholung: die Fahrzeugausgabe, Mareike Ivyfeld, erreichbar unter fahrzeugausgabe-039@example.test.",
          "Bei der Übergabe muss der Fahrer die Auftragsnummer und seinen Fahrerausweis zeigen.",
          "Schlüssel und Zubehörliste werden an der Fahrzeugbucht gemeinsam geprüft.",
          "Die Fahrzeugausgabe ist Montag bis Freitag 08:30 bis 18:00 besetzt.",
        ],
        doesNotKnow: ["welcher Fahrer kommt", "Zahlungen oder Rechnungen", "den Lieferort"],
      })
      return {
        orderId, personas: [desk],
        ivr: tree(site, [
          menu("main", "de", "Main menu", ["Willkommen bei Kervalin Frankfurt. Für den Verkauf drücken Sie die 1. Für Fahrzeugabholungen drücken Sie die 2. Für die Werkstatt drücken Sie die 3. Für Lager und Schlüssel drücken Sie die 4. Für die Filialleitung drücken Sie die 9.",
            "Welcome to Kervalin Frankfurt. For sales, press 1. For vehicle collections, press 2. For the workshop, press 3. For stock and keys, press 4. For the branch manager, press 9."],
          [["1", "Sales", "sales_vm"], ["2", "Vehicle collections (release desk)", "transfer"], ["3", "Workshop", "service_vm"], ["4", "Stock and keys", "stock_vm"], ["9", "Branch manager", "manager_vm"]]),
          voicemail("sales_vm", "de", "Sales voicemail", ["Unser Verkaufsteam ist im Gespräch. Bitte hinterlassen Sie eine Nachricht nach dem Signalton.", "Our sales team is on a call. Please leave a message after the tone."]),
          voicemail("service_vm", "de", "Workshop voicemail", ["Die Werkstatt ist ausgelastet. Bitte hinterlassen Sie eine Nachricht nach dem Signalton.", "The workshop is fully booked. Please leave a message after the tone."]),
          voicemail("stock_vm", "de", "Stock voicemail", ["Lager und Schlüsselausgabe. Bitte hinterlassen Sie eine Nachricht nach dem Signalton.", "Stock and key issue. Please leave a message after the tone."], "stock_control"),
          voicemail("manager_vm", "de", "Branch manager voicemail", ["Filialleitung Kervalin Frankfurt. Bitte hinterlassen Sie eine Nachricht nach dem Signalton.", "Kervalin Frankfurt branch manager. Please leave a message after the tone."], "branch_manager"),
          hold("transfer", "de", ["Sie werden verbunden. Bitte warten Sie.", "Connecting you. Please wait."], 15, "desk"),
          human("desk", desk, "Release desk", "site_desk"),
        ], ["Kervalin Frankfurt ist geschlossen. Öffnungszeiten: Montag bis Freitag 08:30 bis 19:00, Samstag 10:00 bis 14:00.",
          "Kervalin Frankfurt is closed. Opening hours: Monday to Friday 08:30 to 19:00, Saturday 10:00 to 14:00."], "de"),
        // The first attempt drops during the transfer: outcome unknown, so Ringo must reconcile before it redials.
        script: [{ attempt: 1, atNode: "transfer", event: "drop" }],
      }
    }
    case "ord-00023": {
      const lot = person({
        id: "p-023-lot", name: "Felix Alderfield", role: "reconditioning lot lead", style: "Direct, a little rushed.",
        knows: [
          "The Mercedes-Benz GLC for order CD-420023 is at Vellendor Berlin's reconditioning lot.",
          "The street address is Eichenlichtallee 79, Berlin; use the inspection lot gate on the left of the building.",
          "Felix Alderfield releases the keys after the condition sheet is checked at the inspection line.",
          "The driver must show the order reference and driver ID.",
        ],
        doesNotKnow: ["whether the customer wants this as the pickup address", "the delivery side", "any prices"],
      })
      return {
        orderId, personas: [lot], script: [],
        ivr: tree(site, [
          menu("main", "de", "Main menu", ["Vellendor Berlin, guten Tag. Für Verkauf drücken Sie die 1. Für Aufbereitung und Fahrzeugausgabe drücken Sie die 2. Für die Filialleitung drücken Sie die 9.",
            "Vellendor Berlin, good day. For sales, press 1. For reconditioning and vehicle release, press 2. For the branch manager, press 9."],
          [["1", "Sales", "sales_vm"], ["2", "Reconditioning and vehicle release (site desk)", "lot_hold"], ["9", "Branch manager", "manager_vm"]]),
          voicemail("sales_vm", "de", "Sales voicemail", ["Bitte hinterlassen Sie eine Nachricht nach dem Signalton.", "Please leave a message after the tone."]),
          voicemail("manager_vm", "de", "Branch manager voicemail", ["Filialleitung Vellendor Berlin. Bitte hinterlassen Sie eine Nachricht nach dem Signalton.", "Vellendor Berlin branch manager. Please leave a message after the tone."], "branch_manager"),
          hold("lot_hold", "de", ["Bitte bleiben Sie dran, wir verbinden Sie mit der Aufbereitung.", "Please hold, connecting you to the reconditioning lot."], 20, "lot"),
          human("lot", lot, "Reconditioning lot", "site_desk"),
        ], ["Vellendor Berlin ist geschlossen. Montag bis Freitag 09:00 bis 19:00, Samstag 08:00 bis 12:00.",
          "Vellendor Berlin is closed. Monday to Friday 09:00 to 19:00, Saturday 08:00 to 12:00."], "de"),
      }
    }
    case "ord-00458": {
      const store = person({
        id: "p-458-store", name: "Jasper Alderfield", role: "storekeeper", style: "Formal and firm.",
        knows: [
          "Der Ferrari Roma für CD-420458 steht im gesicherten Lager.",
          "Der Verkäufer hat die Herausgabe wegen einer offenen Rechnung gesperrt; es liegt keine unterschriebene Freigabe vor.",
          "Kein Fahrer soll kommen, bevor der Verkäufer die Sperre aufhebt und eine unterschriebene Freigabe schickt.",
        ],
        doesNotKnow: ["wann die Rechnung bezahlt wird", "Details zum Kaufvertrag"],
      })
      return { orderId, personas: [store], script: [], ivr: genericTree(site, lang, store) }
    }
    default:
      return { orderId, personas: [], script: [], ivr: genericTree(site, lang, null) }
  }
}

const GENERIC: Record<Lang, (name: string) => { main: Said; hold: Said; vm: Said; closed: Said }> = {
  en: (n) => ({ main: [`Welcome to ${n}. For sales, press 1. For vehicle collections, press 2. For stock control and keys, press 3. For the branch manager, press 9.`, ""],
    hold: ["Hold music. All colleagues are busy.", ""], vm: [LINE.en.nobody, ""], closed: [`${n} is closed right now.`, ""] }),
  de: (n) => ({ main: [`Willkommen bei ${n}. Für den Verkauf drücken Sie die 1. Für Fahrzeugabholungen drücken Sie die 2. Für Lager und Schlüssel drücken Sie die 3. Für die Filialleitung drücken Sie die 9.`, ""],
    hold: ["Wartemusik. Alle Mitarbeitenden sind im Gespräch.", ""], vm: [LINE.de.nobody, ""], closed: [`${n} ist zurzeit geschlossen.`, ""] }),
  fi: (n) => ({ main: [`Tervetuloa, ${n}. Myynti, paina 1. Ajoneuvojen nouto, paina 2. Varasto ja avaimet, paina 3. Toimipisteen päällikkö, paina 9.`, ""],
    hold: ["Pitomusiikkia. Kaikki työntekijät ovat varattuja.", ""], vm: [LINE.fi.nobody, ""], closed: [`${n} on nyt suljettu.`, ""] }),
  da: (n) => ({ main: [`Velkommen til ${n}. For salg, tryk 1. For afhentning af biler, tryk 2. For lager og nøgler, tryk 3. For afdelingslederen, tryk 9.`, ""],
    hold: ["Ventemusik. Alle medarbejdere er optaget.", ""], vm: [LINE.da.nobody, ""], closed: [`${n} har lukket lige nu.`, ""] }),
}

/** Any other pickup site, in its own language: main menu → collections → hold → voicemail (or the persona). Ringo learns nothing from a mailbox. */
function genericTree(site: SiteLike, lang: Lang, persona: SimPersona | null): IvrTree {
  const g = GENERIC[lang](site.name), e = GENERIC.en(site.name)
  const both = (k: keyof typeof g): Said => [g[k][0], lang === "en" ? "" : e[k][0]]
  return tree(site, [
    menu("main", lang, "Main menu", both("main"), [["1", "Sales", "vm"], ["2", "Vehicle collections (site desk)", "hold"], ["3", "Stock control and keys", "stock_vm"], ["9", "Branch manager", "manager_vm"]]),
    hold("hold", lang, both("hold"), 40, persona ? "human" : "desk_vm"),
    ...(persona ? [human("human", persona, "Vehicle collections", "site_desk")] : []),
    voicemail("vm", lang, "Sales voicemail", both("vm")),
    voicemail("desk_vm", lang, "Collections voicemail", both("vm"), "site_desk"),
    voicemail("stock_vm", lang, "Stock control voicemail", both("vm"), "stock_control"),
    voicemail("manager_vm", lang, "Branch manager voicemail", both("vm"), "branch_manager"),
  ], both("closed"), lang)
}

/** Where pressing `digits` from `nodeId` leads, following holds: the end node and its ladder rung, or the first bad digit. */
export function walk(tree: IvrTree, nodeId: string, digits: string): { end: Node; rung: Rung | null; bad: string | null } {
  let node = tree.nodes[nodeId] as Node
  for (const d of digits) {
    const opt = node.kind === "menu" ? node.options?.find((o) => o.digit === d) : undefined
    if (!opt) return { end: node, rung: null, bad: d }
    node = tree.nodes[opt.next] as Node
    while (node.kind === "hold" && node.next) node = tree.nodes[node.next] as Node
    if (node.kind !== "menu") break
  }
  return { end: node, rung: node.rung ?? null, bad: null }
}
