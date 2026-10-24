import type { Metadata } from "next"
import Link from "next/link"
import { withBase } from "@/lib/base"
import { AppFrame } from "./components/app-frame"

export const metadata: Metadata = { title: "Not found · Ringo" }

export default function NotFound() {
  return <AppFrame><main className="page"><div className="gone" role="alert">
    {/* eslint-disable-next-line @next/next/no-img-element -- a static svg needs no optimiser */}
    <img src={withBase("/lizard-dealer.svg")} alt="" width={214} height={240} />
    <div>
      <h1>This one’s already gone.</h1>
      <p>There’s no page or order at this address.</p>
      <Link className="btn primary" href="/">Back to the queue</Link>
    </div>
  </div></main></AppFrame>
}
