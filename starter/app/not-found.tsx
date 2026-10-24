import type { Metadata } from "next"
import Link from "next/link"
import { AppFrame } from "./components/app-frame"

export const metadata: Metadata = { title: "Not found · Ringo" }

export default function NotFound() {
  return <AppFrame><main className="page"><div className="record-state" role="alert">
    <h1>Nothing here</h1>
    <p>This page or order does not exist. Order links look like /orders/ord-00516. <Link href="/">Back to the queue</Link></p>
  </div></main></AppFrame>
}
