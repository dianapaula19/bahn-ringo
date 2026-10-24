import { EntityIndex } from "../components/entity-page"

export const metadata = { title: "Customers" }

export default function Page() {
  return <EntityIndex kind="customer" />
}
